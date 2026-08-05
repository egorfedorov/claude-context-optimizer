#!/usr/bin/env node

/**
 * Self-learning tool cost estimates — #38
 *
 * MCP and Agent costs were hardcoded guesses (`Agent` ≈ 500 in, `mcp__*` ≈ 200).
 * Real results vary by orders of magnitude: a Linear "list all issues" and a
 * one-row lookup are the same tool name and nowhere near the same token cost.
 * On MCP-heavy sessions the budget meter was guessing at the biggest line item.
 *
 * PostToolUse already measures the real `tool_response` size. This records it
 * per tool name and hands the learned average back to the estimator, so the
 * second time you call a tool the estimate reflects what it actually costs
 * YOU — not a constant someone picked once.
 *
 * Usage:
 *   node src/tool-costs.js          # what CCO has learned so far
 *   node src/tool-costs.js reset
 */

import {
  TOOL_COSTS_FILE, loadJSON, saveJSON, formatTokens, ensureDataDirs,
  isMainModule, acquireFileLock,
} from './utils.js';

// An EMA, not a plain mean: tool costs drift (an MCP server gets chattier, a
// repo grows) and recent calls should win. Same alpha as the estimate
// self-calibration, for one less magic number in the codebase.
export const ALPHA = 0.25;

// Below this, one freak 200K response would become "the estimate". The
// constant is a safer guess until we've seen the tool behave a few times.
export const MIN_SAMPLES = 3;

// Bound the file: a long-lived install with many MCP servers shouldn't grow
// without limit. Least-used entries go first.
export const MAX_TOOLS = 200;

// ── Pure core (exported for tests) ──────────────────────────────────────────

/**
 * Fold one observation into a tool's rolling stat.
 * Pure. `prev` may be undefined (first sighting).
 */
export function updateToolStat(prev, tokens, alpha = ALPHA) {
  const t = Math.max(0, Math.round(tokens || 0));
  if (!prev || !prev.samples) {
    return { samples: 1, avg: t, max: t, total: t };
  }
  return {
    samples: prev.samples + 1,
    avg: Math.round(prev.avg * (1 - alpha) + t * alpha),
    max: Math.max(prev.max || 0, t),
    total: (prev.total || 0) + t,
  };
}

/**
 * The learned input-token cost for a tool, or null when the evidence is too
 * thin to beat the hardcoded constant.
 */
export function learnedCost(stats, toolName, minSamples = MIN_SAMPLES) {
  const s = stats && stats[toolName];
  if (!s || s.samples < minSamples) return null;
  return s.avg;
}

/** Drop the least-observed tools once the table outgrows MAX_TOOLS. */
export function pruneTools(stats, max = MAX_TOOLS) {
  const entries = Object.entries(stats || {});
  if (entries.length <= max) return stats;
  entries.sort((a, b) => (b[1].samples || 0) - (a[1].samples || 0));
  return Object.fromEntries(entries.slice(0, max));
}

/**
 * Which tools are worth learning from. Read/Edit/Write already derive their
 * estimate from the actual arguments (file size, string lengths) — an average
 * would be strictly worse than what we can compute. The guessed ones are
 * everything else.
 */
export function isLearnable(toolName) {
  if (!toolName) return false;
  return !['Read', 'Edit', 'Write', 'MultiEdit', 'NotebookEdit'].includes(toolName);
}

// ── Storage ─────────────────────────────────────────────────────────────────

let _cache = null;

export function loadToolCosts() {
  if (_cache) return _cache;
  _cache = loadJSON(TOOL_COSTS_FILE) || { version: 1, tools: {} };
  if (!_cache.tools) _cache.tools = {};
  return _cache;
}

/** Test seam. */
export function clearToolCostCache() { _cache = null; }

/**
 * Record one observed result size. Called from the PostToolUse hook, so it
 * must never throw and never block — a failed learn is not worth a failed hook.
 */
export function recordToolCost(toolName, tokens) {
  if (!isLearnable(toolName) || !(tokens > 0)) return;
  let release;
  try {
    ensureDataDirs();
    // Concurrent hooks would otherwise clobber each other's samples.
    release = acquireFileLock('tool-costs');
    const data = loadJSON(TOOL_COSTS_FILE) || { version: 1, tools: {} };
    if (!data.tools) data.tools = {};
    data.tools[toolName] = updateToolStat(data.tools[toolName], tokens);
    data.tools = pruneTools(data.tools);
    data.updatedAt = new Date().toISOString();
    saveJSON(TOOL_COSTS_FILE, data);
    _cache = data;
  } catch { /* learning is best-effort */ } finally {
    if (release) { try { release(); } catch { /* ignore */ } }
  }
}

/** Learned cost for a tool, or null. Cached — this is on the hook hot path. */
export function getLearnedToolCost(toolName) {
  if (!isLearnable(toolName)) return null;
  try {
    return learnedCost(loadToolCosts().tools, toolName);
  } catch {
    return null;
  }
}

// ── CLI ─────────────────────────────────────────────────────────────────────

function report() {
  const data = loadToolCosts();
  const rows = Object.entries(data.tools || {})
    .map(([name, s]) => ({ name, ...s }))
    .sort((a, b) => b.total - a.total);

  if (!rows.length) {
    console.log('\n  No tool costs learned yet — use some tools and check back.\n');
    return;
  }

  console.log('\n  LEARNED TOOL COSTS  (what tools really cost you, not a constant)');
  console.log('  ' + '─'.repeat(72));
  console.log(`  ${'tool'.padEnd(38)} ${'calls'.padStart(6)} ${'avg'.padStart(8)} ${'max'.padStart(8)} ${'total'.padStart(8)}`);
  for (const r of rows.slice(0, 25)) {
    const active = r.samples >= MIN_SAMPLES ? ' ' : '·';
    console.log(`  ${active}${r.name.slice(0, 37).padEnd(37)} ${String(r.samples).padStart(6)} ` +
      `${formatTokens(r.avg).padStart(8)} ${formatTokens(r.max).padStart(8)} ${formatTokens(r.total).padStart(8)}`);
  }
  console.log('  ' + '─'.repeat(72));
  console.log(`  · = fewer than ${MIN_SAMPLES} samples, still using the built-in constant`);
  if (rows.length > 25) console.log(`  (${rows.length - 25} more)`);
  console.log();
}

function main() {
  const cmd = process.argv[2];
  if (cmd === 'reset') {
    saveJSON(TOOL_COSTS_FILE, { version: 1, tools: {} });
    _cache = null;
    console.log('✓ learned tool costs reset');
    return;
  }
  report();
}

if (isMainModule(import.meta.url)) main();
