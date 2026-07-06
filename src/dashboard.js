#!/usr/bin/env node

/**
 * Context Control Center — the one-screen flagship of v4.0.
 *
 * Aggregates everything the optimizer already tracks into a single view:
 *   • Budget    — % of the effective context window used, $ spent this session
 *   • Saved     — tokens the Read Cache blocked → "effectiveness multiplier"
 *   • Waste     — cold context (read, never edited) you can drop to free budget
 *   • Prompt    — grade of your last prompt (from Prompt Coach)
 *   • Tasks     — per-task token/$ attribution (organize work by task)
 *   • Actions   — ready-to-run next steps (drop these / pack that / compact)
 *
 * Two render modes:
 *   node dashboard.js            → the live Control Center board
 *   node dashboard.js summary    → the session-end "CCO saved you $X" report
 *
 * Pure aggregation: it only READS existing data files, never blocks or mutates.
 */

import { join } from 'path';
import { existsSync, readFileSync } from 'fs';
import {
  SESSIONS_DIR, BUDGET_STATE_DIR, READ_CACHE_DIR, PROMPTS_DIR,
  loadJSON, loadConfig, getEffectiveBudget, getModelCost, formatTokens, displayPath,
  getLatestSessionId, isMainModule, computeCacheAwareCost, CACHE_WRITE_MULT, CACHE_READ_MULT,
  updateCalibrationFromSession, getSessionModel, normalizeModelId,
} from './utils.js';
import { loadTasks, getActiveTask, taskSpend, tasksForProject } from './tasks.js';
import { loadLedger } from './notices.js';
import { readTranscriptEconomics } from './transcript-usage.js';

// ── Data gathering ──────────────────────────────────────────────────────────

function lastPromptGrade(sessionId) {
  try {
    const file = join(PROMPTS_DIR, `${sessionId}.jsonl`);
    if (!existsSync(file)) return null;
    const lines = readFileSync(file, 'utf-8').trim().split('\n').filter(Boolean);
    if (!lines.length) return null;
    const last = JSON.parse(lines[lines.length - 1]);
    return { grade: last.grade, score: last.score, suggestions: last.suggestions || [] };
  } catch { return null; }
}

export function gather(sessionId) {
  const config = loadConfig();
  // Prefer the model the SESSION actually runs on (detected by the budget hook
  // from the transcript) over the static config value.
  const rawSessionModel = getSessionModel(sessionId);
  const model = normalizeModelId(rawSessionModel) || config.model || 'opus-4.8';
  const cost = getModelCost(model);
  const effectiveBudget = getEffectiveBudget(config, rawSessionModel);

  const session = sessionId ? loadJSON(join(SESSIONS_DIR, `${sessionId}.json`)) : null;
  const budget = sessionId ? loadJSON(join(BUDGET_STATE_DIR, `${sessionId}.json`)) : null;
  const cache = sessionId ? loadJSON(join(READ_CACHE_DIR, `${sessionId}.json`)) : null;

  // realContextTokens = exact usage read from the session transcript by the
  // budget hook; the chars-per-token estimate is the fallback.
  const used = (budget && (budget.realContextTokens || budget.totalTokensEstimated)) || 0;
  const inTok = (budget && budget.inputTokensEstimated) || 0;
  const outTok = (budget && budget.outputTokensEstimated) || 0;

  // Cache economics — exact usage totals from the full transcript, priced at
  // real cache rates (reads 10%, writes 125% of input). This is what the
  // session actually bills; the estimate below stays as the fallback.
  const econ = budget && budget.transcriptPath
    ? readTranscriptEconomics(budget.transcriptPath) : null;
  let dollars, cacheEcon = null;
  if (econ) {
    const costs = computeCacheAwareCost(econ.totals, model);
    dollars = costs.real;
    const inputSide = econ.totals.input + econ.totals.cacheRead + econ.totals.cacheCreation;
    const breakTokens = econ.breaks.reduce((s, b) => s + b.lostTokens, 0);
    cacheEcon = {
      hitPct: inputSide > 0 ? Math.round((econ.totals.cacheRead / inputSide) * 100) : 0,
      savings: costs.cacheSavings,
      naive: costs.naive,
      breaks: econ.breaks.length,
      breakTokens,
      // A break re-writes cached tokens at 1.25× instead of re-reading at 0.1×.
      breakCost: (breakTokens / 1e6) * cost.input * (CACHE_WRITE_MULT - CACHE_READ_MULT),
      turns: econ.turns,
    };
  } else {
    dollars = (inTok / 1e6) * cost.input + (outTok / 1e6) * cost.output;
  }

  const savedGross = (cache && cache.totalTokensSaved) || 0;
  const blocked = (cache && cache.blockedReads) || 0;
  // NET savings — subtract the tokens the optimizer's own messages injected into
  // context this session. This is the honest number: what CCO saved you minus
  // what CCO cost you. If it's ever negative, the optimizer is net-negative.
  const overhead = sessionId ? (loadLedger(sessionId).tokensInjected || 0) : 0;
  const saved = Math.max(0, savedGross - overhead);
  const multiplier = used > 0 ? (used + saved) / used : 1;

  // Cold / droppable context: files read but never edited (mirrors the budget
  // hook's compact recommendation). These are the safe-to-drop candidates.
  const cold = [];
  const useful = [];
  if (session && session.files) {
    for (const [path, f] of Object.entries(session.files)) {
      const tokens = (f.estTokens || 0) * Math.max(1, f.reads || 1);
      if (f.edits > 0 || f.wasEdited) useful.push({ path, tokens: f.estTokens || 0, edits: f.edits || 0 });
      else if ((f.reads || 0) >= 1) cold.push({ path, tokens, reads: f.reads || 0 });
    }
  }
  cold.sort((a, b) => b.tokens - a.tokens);
  useful.sort((a, b) => b.edits - a.edits);
  const reclaimable = cold.reduce((s, c) => s + c.tokens, 0);
  const wastePct = used > 0 ? Math.min(100, Math.round((reclaimable / used) * 100)) : 0;

  const prompt = sessionId ? lastPromptGrade(sessionId) : null;

  const project = (session && session.projectRoot) || process.cwd();
  const tasksState = loadTasks();
  const active = getActiveTask(tasksState, { project });
  const recentTasks = tasksForProject(tasksState, project, 5);

  return {
    model, cost, effectiveBudget,
    used, inTok, outTok, dollars, cacheEcon,
    saved, savedGross, overhead, blocked, multiplier,
    cold, useful, reclaimable, wastePct,
    prompt, project, active, recentTasks,
    hasData: !!(session || budget || cache),
  };
}

// ── Rendering helpers ─────────────────────────────────────────────────────────

function bar(pct, width = 12) {
  const filled = Math.max(0, Math.min(width, Math.round((pct / 100) * width)));
  return '▓'.repeat(filled) + '░'.repeat(width - filled);
}

function fmtModelWindow(d) {
  const w = d.effectiveBudget >= 1e6 ? `${(d.effectiveBudget / 1e6).toFixed(1)}M`
    : `${Math.round(d.effectiveBudget / 1000)}K`;
  return `${d.model} · ${w}`;
}

// ── Board ───────────────────────────────────────────────────────────────────

export function renderBoard(d) {
  if (!d.hasData) {
    return [
      '  CONTEXT CONTROL CENTER',
      '  ───────────────────────────────────────────────',
      '  No session data yet. Keep working — reads, edits,',
      '  prompts and cache savings are tracked automatically.',
      '  Then run /cco again to see your live board.',
    ].join('\n');
  }

  const L = [];
  const pct = d.effectiveBudget > 0 ? Math.round((d.used / d.effectiveBudget) * 100) : 0;
  L.push(`  CONTEXT CONTROL CENTER          ${fmtModelWindow(d)}`);
  L.push('  ────────────────────────────────────────────────────────────');
  L.push(`  Budget   ${bar(pct)}  ${formatTokens(d.used)} / ${formatTokens(d.effectiveBudget)}  (${pct}%)  $${d.dollars.toFixed(3)}`);

  if (d.saved > 0) {
    const ov = d.overhead > 0 ? `  (gross ${formatTokens(d.savedGross)} − CCO ${formatTokens(d.overhead)})` : '';
    L.push(`  Saved    +${formatTokens(d.saved)} net  →  ${d.multiplier.toFixed(2)}x effective` +
      (d.blocked ? `  ·  ${d.blocked} reads blocked` : '') + ov);
  } else if (d.savedGross > 0) {
    L.push(`  Saved    net ~0  (cache saved ${formatTokens(d.savedGross)}, CCO messages cost ${formatTokens(d.overhead)})`);
  } else {
    L.push('  Saved    (cache warming up — savings appear after repeat reads)');
  }

  if (d.cacheEcon) {
    const c = d.cacheEcon;
    let line = `  Cache    ${bar(c.hitPct)}  ${c.hitPct}% hit  ·  saved $${c.savings.toFixed(2)} vs uncached`;
    if (c.breaks > 0) line += `  ·  ${c.breaks} break${c.breaks === 1 ? '' : 's'} (−$${c.breakCost.toFixed(2)})`;
    L.push(line);
  }

  L.push(`  Waste    ${bar(d.wastePct)}  ${d.wastePct}%  (${d.cold.length} cold file${d.cold.length === 1 ? '' : 's'})`);

  if (d.prompt) {
    const hint = d.prompt.suggestions && d.prompt.suggestions.length
      ? `  (${d.prompt.suggestions[0]})` : '';
    L.push(`  Prompt   last grade: ${d.prompt.grade}${hint}`);
  }

  // ── Tasks ──
  L.push('  ────────────────────────────────────────────────────────────');
  if (d.active) {
    const spent = taskSpend(d.active, d.used);
    L.push(`  ▶ Task   #${d.active.id} ${d.active.name}  ·  ~${formatTokens(spent)} · $${((spent / 1e6) * d.cost.input).toFixed(3)}`);
  } else {
    L.push('  ▶ Task   none active  →  /cco-task add "<what you are doing>"');
  }
  if (d.recentTasks.length > 1) {
    const done = d.recentTasks.filter(t => t.status === 'done').slice(0, 2);
    for (const t of done) {
      const spent = taskSpend(t, t.tokensAtEnd || t.tokensAtStart);
      L.push(`  ✓ #${t.id} ${t.name}  ·  ~${formatTokens(spent)}`);
    }
  }

  // ── Actions ──
  L.push('  ────────────────────────────────────────────────────────────');
  const actions = buildActions(d);
  if (actions.length) {
    for (const a of actions) L.push(`  ${a}`);
  } else {
    L.push('  ✅ Context is lean — nothing to optimize right now.');
  }

  return L.join('\n');
}

function buildActions(d) {
  const out = [];
  if (d.reclaimable > 3000 && d.cold.length) {
    const top = d.cold.slice(0, 3).map(c => displayPath(c.path, 28)).join(', ');
    out.push(`⚡ Free ~${formatTokens(d.reclaimable)}:  drop ${top}  → /compact`);
  }
  if (!d.active) {
    out.push('📦 Start a task:  /cco-task add "<task>"  then  /cco-pack "<task>"');
  } else {
    out.push(`📦 Pack minimal context:  /cco-pack "${d.active.name}"`);
  }
  if (d.prompt && d.prompt.grade && 'CDF'.includes(d.prompt.grade)) {
    out.push('✍️  Last prompt was vague — /cco-coach can sharpen the next one');
  }
  return out;
}

// ── Session-end summary (Auto-Optimizer report) ───────────────────────────────

export function renderSummary(d) {
  if (!d.hasData || (d.saved === 0 && d.used === 0)) return '';
  const L = [];
  L.push('  ── CCO session summary ───────────────────────────────────────');
  // Headline: everything CCO + prompt caching saved, as % of what the session
  // WOULD have cost without them. The one number people remember.
  {
    const readCacheDollars = (d.saved / 1e6) * d.cost.input;
    const cacheDollars = d.cacheEcon ? d.cacheEcon.savings : 0;
    const totalSaved = readCacheDollars + cacheDollars;
    const wouldHaveCost = d.dollars + totalSaved;
    if (totalSaved >= 0.01 && wouldHaveCost > 0) {
      const pct = Math.round((totalSaved / wouldHaveCost) * 100);
      L.push(`  ★ CCO saved $${totalSaved.toFixed(2)} this session — ${pct}% of what it would have cost.`);
    }
  }
  if (d.saved > 0) {
    const savedDollars = (d.saved / 1e6) * d.cost.input;
    const ov = d.overhead > 0 ? ` (net of ${formatTokens(d.overhead)} CCO overhead)` : '';
    L.push(`  CCO saved you ${formatTokens(d.saved)} tokens net this session${ov} (~$${savedDollars.toFixed(2)}).`);
    L.push(`  Your ${formatTokens(d.effectiveBudget)} budget worked like ${formatTokens(Math.round(d.used + d.saved))} (${d.multiplier.toFixed(2)}x).`);
  } else {
    L.push(`  Tracked ${formatTokens(d.used)} tokens this session ($${d.dollars.toFixed(2)}).`);
  }
  if (d.cacheEcon) {
    const c = d.cacheEcon;
    L.push(`  Prompt cache: ${c.hitPct}% hit rate saved $${c.savings.toFixed(2)} vs uncached pricing.`);
    if (c.breaks > 0) {
      L.push(`  ⚠ Cache broke ${c.breaks}x (${formatTokens(c.breakTokens)} re-written, ~$${c.breakCost.toFixed(2)} extra).` +
        ` Common causes: >5 min pauses, editing CLAUDE.md mid-session, switching models.`);
    }
  }
  if (d.reclaimable > 3000) {
    L.push(`  Tip: ~${formatTokens(d.reclaimable)} of cold context is still loaded — /compact before next task.`);
  }
  return L.join('\n');
}

// ── CLI ───────────────────────────────────────────────────────────────────────

function main() {
  const mode = process.argv[2] || 'board';
  const sessionId = process.argv[3] || getLatestSessionId();
  const d = gather(sessionId);
  if (mode === 'summary') {
    const s = renderSummary(d);
    if (s) console.log(s);
    // Session is over — let ground truth teach the estimator its local drift.
    const budget = sessionId ? loadJSON(join(BUDGET_STATE_DIR, `${sessionId}.json`)) : null;
    if (budget && budget.realContextTokens && budget.totalTokensEstimated) {
      updateCalibrationFromSession(budget.realContextTokens, budget.totalTokensEstimated);
    }
  } else {
    console.log(renderBoard(d));
  }
}

if (isMainModule(import.meta.url)) {
  try { main(); } catch (e) { console.error(`[cco] dashboard error: ${e.message}`); process.exit(0); }
}
