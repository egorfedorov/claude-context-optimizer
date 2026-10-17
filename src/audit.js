#!/usr/bin/env node

/**
 * Savings audit — /cco-audit
 *
 * Does CCO actually save anything? This answers from your own transcripts
 * (~/.claude/projects/**.jsonl), not from estimates or benchmarks:
 *
 *   1. Where the money went: cache reads, cache writes, output — and how much
 *      of the context every request re-reads is fixed overhead vs growth.
 *   2. What CCO verifiably saved: every read-cache refusal is in the
 *      transcript, with the size of the read it replaced.
 *   3. What it could not have saved: repeated reads of unchanged files that
 *      went through anyway (via Read before CCO, or via Bash `cat`/`sed`).
 *   4. The levers that are bigger than read dedup, priced on your sessions:
 *      compacting earlier, trimming fixed overhead, delegating exploration to
 *      Haiku subagents.
 *
 * A token that enters the context is written to the prompt cache once and then
 * re-read on every later request until the session ends or compacts, so a
 * result's real price is tokens × (write + read × requests left). Everything
 * below is priced that way, with the model and cache TTL of each session.
 *
 * Usage:
 *   node src/audit.js [--days 30] [--project <cwd>] [--json]
 */

import { readFileSync, readdirSync, statSync, existsSync } from 'fs';
import { join, basename } from 'path';
import { homedir } from 'os';
import { parseEconomicsFromLines } from './transcript-usage.js';
import {
  getModelCost, getCacheRates, normalizeModelId, computeSessionCost,
  formatTokens, isMainModule, loadConfig,
} from './utils.js';
import { projectTranscriptDir } from './overhead.js';

const MAX_FILE_BYTES = 256 * 1024 * 1024;
const EXPLORE_TOOLS = new Set(['Read', 'Grep', 'Glob', 'WebFetch', 'WebSearch']);
const BASH_READ = /^\s*(cat|sed|head|tail|nl|less|more)\b/;

// ── Pure analysis (exported for tests) ──────────────────────────────────────

function resultChars(content) {
  if (typeof content === 'string') return content.length;
  if (!Array.isArray(content)) return JSON.stringify(content || '').length;
  let n = 0;
  for (const c of content) {
    if (c && c.type === 'text') n += (c.text || '').length;
    else if (c && c.type === 'image') n += 4 * 1600; // ~1.6K tokens per image
    else n += JSON.stringify(c).length;
  }
  return n;
}

function resultText(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) return content.map(c => (c && c.text) || '').join('\n');
  return '';
}

/** "~1.2K tokens" / "~626 tokens" → number. */
export function parseTokenCount(text) {
  const m = /~([\d.]+)([KM]?) tokens/.exec(text || '');
  if (!m) return 0;
  const mult = m[2] === 'M' ? 1e6 : m[2] === 'K' ? 1e3 : 1;
  return Math.round(parseFloat(m[1]) * mult);
}

/**
 * One transcript → its facts. Pure: lines in, numbers out.
 * Requests are counted once per API message id (Claude Code repeats usage on
 * every content block of a message).
 */
export function analyzeTranscript(lines) {
  const requests = [];               // per request: context tokens
  const seen = new Set();
  const toolUses = new Map();        // id → { name, input, req }
  const results = [];                // { id, tokens, isError, text }
  let compactions = 0;
  let model = null;

  for (const line of lines) {
    let e;
    try { e = JSON.parse(line); } catch { continue; }
    if (e.subtype === 'compact_boundary' || e.isCompactSummary) compactions++;
    const m = e.message;
    if (e.type === 'assistant' && m) {
      const u = m.usage;
      if (u && typeof u.input_tokens === 'number' && !seen.has(m.id)) {
        seen.add(m.id);
        requests.push((u.input_tokens || 0) + (u.cache_read_input_tokens || 0) + (u.cache_creation_input_tokens || 0));
        model = m.model || model;
      }
      for (const c of m.content || []) {
        if (c && c.type === 'tool_use') toolUses.set(c.id, { name: c.name, input: c.input || {}, req: requests.length - 1 });
      }
    } else if (e.type === 'user' && m && Array.isArray(m.content)) {
      for (const c of m.content) {
        if (c && c.type === 'tool_result') {
          results.push({ id: c.tool_use_id, tokens: resultChars(c.content) / 4, isError: !!c.is_error, text: resultText(c.content) });
        }
      }
    }
  }

  const n = requests.length;
  const out = {
    model: normalizeModelId(model), requests: n, compactions,
    contexts: requests,
    baseline: n ? requests[0] : 0,
    peak: n ? Math.max(...requests) : 0,
    contextSum: requests.reduce((s, x) => s + x, 0),
    toolTokens: 0, toolWeight: 0,              // weight = tokens × requests left
    exploreTokens: 0, exploreWeight: 0,
    refused: { count: 0, tokens: 0, weight: 0 },
    insisted: 0,
    rereads: { count: 0, tokens: 0, weight: 0 },
    bashRereads: { count: 0, tokens: 0, weight: 0 },
    readCalls: 0,
  };

  // Edits per file, by request index — a read after an edit is not a repeat.
  const edits = new Map();
  for (const { name, input, req } of toolUses.values()) {
    if (['Edit', 'Write', 'MultiEdit', 'NotebookEdit'].includes(name) && input.file_path) {
      if (!edits.has(input.file_path)) edits.set(input.file_path, []);
      edits.get(input.file_path).push(req);
    }
  }
  const editedBetween = (path, a, b) => (edits.get(path) || []).some(i => i > a && i <= b);

  const lastRead = new Map();
  const lastBash = new Map();
  let lastRefusedKey = null;
  for (const r of results) {
    const use = toolUses.get(r.id);
    if (!use) continue;
    const left = Math.max(0, n - use.req - 1);
    const add = (bucket, tokens) => { bucket.count++; bucket.tokens += tokens; bucket.weight += tokens * left; };

    if (r.isError && /\[read-cache\]/.test(r.text) && /re-read skipped|Already loaded/.test(r.text)) {
      add(out.refused, parseTokenCount(r.text));
      lastRefusedKey = JSON.stringify([use.input.file_path, use.input.offset || 0, use.input.limit || 0]);
      continue;
    }
    if (r.isError) continue;

    out.toolTokens += r.tokens;
    out.toolWeight += r.tokens * left;
    const isBashRead = use.name === 'Bash' && BASH_READ.test(use.input.command || '');
    if (EXPLORE_TOOLS.has(use.name) || use.name.startsWith('mcp__') || isBashRead) {
      out.exploreTokens += r.tokens;
      out.exploreWeight += r.tokens * left;
    }

    if (use.name === 'Read') {
      out.readCalls++;
      const key = JSON.stringify([use.input.file_path, use.input.offset || 0, use.input.limit || 0]);
      if (key === lastRefusedKey) out.insisted++;
      lastRefusedKey = null;
      const prev = lastRead.get(key);
      if (prev !== undefined && !editedBetween(use.input.file_path, prev, use.req)) add(out.rereads, r.tokens);
      lastRead.set(key, use.req);
    } else if (isBashRead) {
      const cmd = use.input.command.trim();
      const prev = lastBash.get(cmd);
      if (prev !== undefined && ![...edits.keys()].some(p => cmd.includes(p) && editedBetween(p, prev, use.req))) {
        add(out.bashRereads, r.tokens);
      }
      lastBash.set(cmd, use.req);
    }
  }
  return out;
}

/**
 * Context per request if the session had compacted whenever it passed
 * `threshold`, assuming a summary of `summary` tokens on top of the baseline
 * and the same per-request growth afterwards. Returns { sum, compactions }.
 */
export function simulateCompaction(contexts, threshold, summary = 15_000) {
  if (!contexts.length) return { sum: 0, compactions: 0 };
  let sim = contexts[0];
  let sum = sim;
  let compactions = 0;
  for (let i = 1; i < contexts.length; i++) {
    sim += Math.max(0, contexts[i] - contexts[i - 1]);
    if (sim > threshold) { sim = contexts[0] + summary; compactions++; }
    sum += sim;
  }
  return { sum, compactions };
}

/** Price one session's facts; `econ` from parseEconomicsFromLines. */
export function priceSession(facts, econ, { compactAt = 200_000, fallbackModel = 'opus-5.5' } = {}) {
  const model = facts.model || fallbackModel;
  const cost = getModelCost(model);
  const inRate = cost.input / 1e6;
  const ttl = econ && econ.totals.cacheCreation1h > 0 ? '1h' : '5m';
  const { read, write } = getCacheRates(model, ttl);
  // A token in context: written once, then read on each later request.
  const priceOf = (tokens, weight) => (tokens * write + weight * read) * inRate;

  const t = econ ? econ.totals : { input: 0, cacheRead: 0, cacheCreation: 0, output: 0 };
  const total = econ ? computeSessionCost(econ, model).real : 0;
  const split = {
    cacheReads: t.cacheRead * read * inRate,
    cacheWrites: (t.cacheCreation - (t.cacheCreation1h || 0)) * 1.25 * inRate + (t.cacheCreation1h || 0) * 2 * inRate,
    output: t.output * (cost.output / 1e6),
    input: t.input * inRate,
  };

  const sim = simulateCompaction(facts.contexts, compactAt);
  const compactSaved = Math.max(0,
    (facts.contextSum - sim.sum) * read * inRate
    - sim.compactions * (compactAt * read * inRate + 5_000 * cost.output / 1e6 + 15_000 * write * inRate));

  return {
    model, total, split,
    refusedSaved: priceOf(facts.refused.tokens, facts.refused.weight),
    rereadCost: priceOf(facts.rereads.tokens, facts.rereads.weight),
    bashRereadCost: priceOf(facts.bashRereads.tokens, facts.bashRereads.weight),
    exploreCost: priceOf(facts.exploreTokens, facts.exploreWeight),
    // 10K tokens less of fixed overhead, on every request of this session.
    per10kOverhead: 10_000 * (write + read * Math.max(0, facts.requests - 1)) * inRate,
    compactSaved, simulatedCompactions: sim.compactions,
    // Exploration done by a Haiku 5.5 subagent instead: its results stay out of
    // the main context except a ~10% summary, and Haiku reads them at its price.
    delegateSaved: Math.max(0, priceOf(facts.exploreTokens, facts.exploreWeight) * 0.9
      - facts.exploreTokens * 3 * getModelCost('haiku-5.5').input / 1e6),
  };
}

export function summarize(sessions) {
  const sum = (f) => sessions.reduce((s, x) => s + f(x), 0);
  return {
    sessions: sessions.length,
    subagentSessions: sessions.filter(s => s.subagent).length,
    requests: sum(s => s.facts.requests),
    total: sum(s => s.price.total),
    mainTotal: sum(s => (s.subagent ? 0 : s.price.total)),
    subagentTotal: sum(s => (s.subagent ? s.price.total : 0)),
    // Which models the subagents ran on — Haiku runs are the cheap delegation.
    subagentByModel: sessions.filter(s => s.subagent).reduce((o, s) => {
      const m = o[s.price.model] || (o[s.price.model] = { runs: 0, total: 0, requests: 0 });
      m.runs++; m.total += s.price.total; m.requests += s.facts.requests;
      return o;
    }, {}),
    split: ['cacheReads', 'cacheWrites', 'output', 'input']
      .reduce((o, k) => ({ ...o, [k]: sum(s => s.price.split[k]) }), {}),
    fixedShare: sum(s => s.facts.baseline * s.facts.requests) / Math.max(1, sum(s => s.facts.contextSum)),
    avgContext: sum(s => s.facts.contextSum) / Math.max(1, sum(s => s.facts.requests)),
    peak: Math.max(0, ...sessions.map(s => s.facts.peak)),
    compactions: sum(s => s.facts.compactions),
    readCalls: sum(s => s.facts.readCalls),
    refused: sum(s => s.facts.refused.count),
    refusedTokens: sum(s => s.facts.refused.tokens),
    refusedSaved: sum(s => s.price.refusedSaved),
    insisted: sum(s => s.facts.insisted),
    rereads: sum(s => s.facts.rereads.count),
    rereadCost: sum(s => s.price.rereadCost),
    bashRereads: sum(s => s.facts.bashRereads.count),
    bashRereadCost: sum(s => s.price.bashRereadCost),
    exploreCost: sum(s => (s.subagent ? 0 : s.price.exploreCost)),
    delegateSaved: sum(s => (s.subagent ? 0 : s.price.delegateSaved)),
    compactSaved: sum(s => (s.subagent ? 0 : s.price.compactSaved)),
    per10kOverhead: sum(s => s.price.per10kOverhead),
  };
}

const usd = (x) => `$${x >= 100 ? x.toFixed(0) : x.toFixed(2)}`;
const pct = (x, of) => (of > 0 ? `${Math.round((x / of) * 100)}%` : '0%');

export function renderAudit(a, { days, compactAt }) {
  if (!a.sessions) {
    return '\n  No Claude Code transcripts found for this period.\n';
  }
  const L = [];
  L.push('');
  L.push(`  SAVINGS AUDIT — ${a.sessions - a.subagentSessions} sessions + ${a.subagentSessions} subagent runs, last ${days} days`);
  L.push('  ' + '─'.repeat(66));
  L.push(`  Spend      ${usd(a.total)} over ${a.requests.toLocaleString()} requests` +
    (a.subagentTotal > 0 ? `  (subagents ${usd(a.subagentTotal)})` : ''));
  L.push(`             cache reads ${pct(a.split.cacheReads, a.total)} · cache writes ${pct(a.split.cacheWrites, a.total)} · output ${pct(a.split.output, a.total)}`);
  const subs = Object.entries(a.subagentByModel || {}).sort((x, y) => y[1].total - x[1].total);
  if (subs.length) {
    L.push(`  Subagents  ${subs.map(([m, v]) => `${m} ${usd(v.total)} (${v.runs} run${v.runs === 1 ? '' : 's'})`).join(' · ')}`);
  }
  L.push(`  Context    avg ${formatTokens(Math.round(a.avgContext))} per request, peak ${formatTokens(a.peak)}; ` +
    `fixed overhead is ${pct(a.fixedShare, 1)} of it; ${a.compactions} compaction${a.compactions === 1 ? '' : 's'}`);
  L.push('');
  L.push('  WHAT CCO DID');
  if (a.refused) {
    L.push(`  Read dedup refused ${a.refused} re-read${a.refused === 1 ? '' : 's'} (${formatTokens(Math.round(a.refusedTokens))} tokens) → saved ~${usd(a.refusedSaved)} (${pct(a.refusedSaved, a.total)} of spend)` +
      (a.insisted ? `; Claude insisted ${a.insisted}× (let through)` : ''));
  } else {
    L.push('  Read dedup refused nothing in this period.');
  }
  L.push(`  Repeated reads that went through: ${a.rereads} via Read (~${usd(a.rereadCost)}), ` +
    `${a.bashRereads} via Bash cat/sed (~${usd(a.bashRereadCost)}) out of ${a.readCalls} Read calls`);
  L.push('');
  L.push('  BIGGER LEVERS (estimates on these sessions)');
  const levers = [
    [a.compactSaved, `Compact at ${formatTokens(compactAt)} instead of letting context grow`, '/compact when the budget warning fires'],
    [a.delegateSaved, 'Delegate exploration (Read/Grep/web) to Haiku subagents', 'context-optimizer:scout, /cco-orchestrate'],
    [a.per10kOverhead, 'Every 10K less of fixed overhead (MCP tools, CLAUDE.md, skills)', '/cco-overhead'],
  ].sort((x, y) => y[0] - x[0]);
  for (const [v, what, how] of levers) {
    L.push(`  ~${usd(v).padStart(8)}  ${pct(v, a.total).padStart(4)}  ${what}`);
    L.push(`  ${''.padStart(15)}→ ${how}`);
  }
  L.push('');
  L.push('  VERDICT');
  const best = levers[0];
  if (a.refusedSaved >= best[0] * 0.5 && a.refusedSaved > 0) {
    L.push(`  Read dedup is pulling its weight: ${usd(a.refusedSaved)} saved.`);
  } else {
    L.push(`  Read dedup saved ${usd(a.refusedSaved)}. The biggest saving available here is`);
    L.push(`  "${best[1].toLowerCase()}" — about ${usd(best[0])} (${pct(best[0], a.total)} of spend).`);
  }
  L.push('  Estimates assume the same work; compaction and delegation trade some detail for cost.');
  L.push('');
  return L.join('\n');
}

// ── I/O ───────────────────────────────────────────────────────────────────────

/** Transcript files modified in the window: main sessions and subagent runs. */
export function findTranscripts(root, sinceMs) {
  const out = [];
  const walk = (dir, depth) => {
    let entries;
    try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const p = join(dir, e.name);
      if (e.isDirectory() && depth < 3) walk(p, depth + 1);
      else if (e.isFile() && e.name.endsWith('.jsonl')) {
        try {
          const st = statSync(p);
          if (st.mtimeMs >= sinceMs && st.size <= MAX_FILE_BYTES) {
            out.push({ path: p, size: st.size, subagent: /[\\/]subagents[\\/]/.test(p) || basename(p).startsWith('agent-') });
          }
        } catch { /* vanished */ }
      }
    }
  };
  if (existsSync(root)) walk(root, 0);
  return out;
}

/**
 * Drop lines of API messages already counted from another file. A session
 * that changes directory continues in a new transcript that repeats the whole
 * history, so the same message can sit in two files. Mutates `seen`.
 */
export function dropSeenMessages(lines, seen) {
  const fresh = new Set();
  const out = lines.filter(line => {
    const m = /"type":"assistant"/.test(line) && /"id":"(msg_[^"]+)"/.exec(line);
    if (!m) return true;
    if (seen.has(m[1])) return false;
    fresh.add(m[1]);
    return true;
  });
  for (const id of fresh) seen.add(id);
  return out;
}

export function runAudit({ days = 30, project = null, compactAt = 200_000 } = {}) {
  const root = project ? projectTranscriptDir(project) : join(homedir(), '.claude', 'projects');
  const fallbackModel = loadConfig().model || 'opus-5.5';
  const sessions = [];
  const seen = new Set();
  // Largest first: a continued session's newest file holds the full history.
  const files = findTranscripts(root, Date.now() - days * 86400_000)
    .sort((a, b) => b.size - a.size);
  for (const t of files) {
    let lines;
    try { lines = readFileSync(t.path, 'utf-8').split('\n').filter(Boolean); } catch { continue; }
    lines = dropSeenMessages(lines, seen);
    const facts = analyzeTranscript(lines);
    if (!facts.requests) continue;
    const econ = parseEconomicsFromLines(lines);
    sessions.push({ subagent: t.subagent, facts, price: priceSession(facts, econ, { compactAt, fallbackModel }) });
  }
  return summarize(sessions);
}

function main() {
  const args = process.argv.slice(2);
  const val = (flag, d) => { const i = args.indexOf(flag); return i >= 0 && args[i + 1] ? args[i + 1] : d; };
  const days = parseInt(val('--days', '30'), 10) || 30;
  const compactAt = parseInt(val('--compact-at', '200000'), 10) || 200_000;
  const project = args.includes('--project') ? val('--project', process.cwd()) : null;
  const a = runAudit({ days, project, compactAt });
  if (args.includes('--json')) console.log(JSON.stringify(a, null, 2));
  else console.log(renderAudit(a, { days, compactAt }));
}

if (isMainModule(import.meta.url)) {
  try { main(); } catch (e) { console.error(`[cco] audit error: ${e.message}`); process.exit(0); }
}
