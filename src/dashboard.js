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
  getLatestSessionId, isMainModule,
} from './utils.js';
import { loadTasks, getActiveTask, taskSpend, tasksForProject } from './tasks.js';
import { loadLedger } from './notices.js';

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
  const model = config.model || 'opus-4.8';
  const cost = getModelCost(model);
  const effectiveBudget = getEffectiveBudget(config);

  const session = sessionId ? loadJSON(join(SESSIONS_DIR, `${sessionId}.json`)) : null;
  const budget = sessionId ? loadJSON(join(BUDGET_STATE_DIR, `${sessionId}.json`)) : null;
  const cache = sessionId ? loadJSON(join(READ_CACHE_DIR, `${sessionId}.json`)) : null;

  const used = (budget && budget.totalTokensEstimated) || 0;
  const inTok = (budget && budget.inputTokensEstimated) || 0;
  const outTok = (budget && budget.outputTokensEstimated) || 0;
  const dollars = (inTok / 1e6) * cost.input + (outTok / 1e6) * cost.output;

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
    used, inTok, outTok, dollars,
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
  if (d.saved > 0) {
    const savedDollars = (d.saved / 1e6) * d.cost.input;
    const ov = d.overhead > 0 ? ` (net of ${formatTokens(d.overhead)} CCO overhead)` : '';
    L.push(`  CCO saved you ${formatTokens(d.saved)} tokens net this session${ov} (~$${savedDollars.toFixed(2)}).`);
    L.push(`  Your ${formatTokens(d.effectiveBudget)} budget worked like ${formatTokens(Math.round(d.used + d.saved))} (${d.multiplier.toFixed(2)}x).`);
  } else {
    L.push(`  Tracked ${formatTokens(d.used)} tokens this session ($${d.dollars.toFixed(2)}).`);
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
  } else {
    console.log(renderBoard(d));
  }
}

if (isMainModule(import.meta.url)) {
  try { main(); } catch (e) { console.error(`[cco] dashboard error: ${e.message}`); process.exit(0); }
}
