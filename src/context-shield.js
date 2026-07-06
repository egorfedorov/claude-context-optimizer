#!/usr/bin/env node

/**
 * ContextShield v1.0
 *
 * PreToolUse hook that protects against wasteful file reads.
 * Checks historical patterns and warns before loading known-waste files.
 * Suggests alternatives: Grep instead of Read, offset/limit for large files.
 */

import { basename, extname, join, relative } from 'path';
import { existsSync, readFileSync, appendFileSync } from 'fs';
import {
  PATTERNS_FILE, SESSIONS_DIR,
  estimateTokens, formatTokens, loadJSON, ensureDataDirs, isMainModule
} from './utils.js';
import { emitNotice } from './notices.js';

ensureDataDirs();

function loadPatterns() {
  return loadJSON(PATTERNS_FILE) || { projects: {}, taskPatterns: {}, lastUpdated: null };
}

function getProjectPatterns(patterns, projectRoot) {
  const key = projectRoot || '_global';
  return patterns.projects[key] || { fileFrequency: {}, wastedReads: {}, coOccurrence: {} };
}

function findProjectForPath(patterns, filePath) {
  for (const key of Object.keys(patterns.projects)) {
    if (key !== '_global' && filePath.startsWith(key)) {
      return key;
    }
  }
  return null;
}

// ── .contextignore suggestions (close the loop: observation → rule) ─────────
// The shield WARNS about files wasted in 3+ sessions; this turns those
// observations into permanent .contextignore rules so the waste stops for good.

/**
 * Build suggestion list from historical waste patterns. Pure — for tests.
 * Returns [{ pattern, sessions, tokens }] sorted by tokens wasted, deduped
 * against lines already present in existingIgnore (array of pattern strings).
 */
export function buildIgnoreSuggestions(patterns, projectRoot, existingIgnore = [], minSessions = 3) {
  const existing = new Set(existingIgnore.map(l => l.trim()).filter(Boolean));
  const out = [];
  for (const [projKey, proj] of Object.entries(patterns.projects || {})) {
    if (projKey !== '_global' && projKey !== projectRoot) continue;
    for (const [filePath, d] of Object.entries(proj.wastedReads || {})) {
      if ((d.sessions || 0) < minSessions) continue;
      if (!filePath.startsWith(projectRoot + '/')) continue;
      const pattern = relative(projectRoot, filePath);
      if (!pattern || pattern.startsWith('..') || existing.has(pattern)) continue;
      out.push({ pattern, sessions: d.sessions, tokens: d.totalTokensWasted || 0 });
    }
  }
  return out.sort((a, b) => b.tokens - a.tokens).slice(0, 20);
}

function readIgnoreLines(cwd) {
  const file = join(cwd, '.contextignore');
  if (!existsSync(file)) return [];
  try { return readFileSync(file, 'utf-8').split('\n'); } catch { return []; }
}

function suggestOrApply(mode) {
  const cwd = process.cwd();
  const patterns = loadPatterns();
  const suggestions = buildIgnoreSuggestions(patterns, cwd, readIgnoreLines(cwd));

  if (!suggestions.length) {
    console.log('\n  No .contextignore candidates yet — nothing was wasted in 3+ sessions');
    console.log('  (or the waste files are already ignored). Keep working; patterns accrue.\n');
    return;
  }

  const total = suggestions.reduce((s, x) => s + x.tokens, 0);
  console.log(`\n  .CONTEXTIGNORE ${mode === 'apply' ? 'APPLIED' : 'SUGGESTIONS'} — ${suggestions.length} file(s), ~${formatTokens(total)} tokens/session saveable`);
  console.log('  ' + '─'.repeat(60));
  for (const s of suggestions) {
    console.log(`  ${s.pattern.padEnd(44)} wasted in ${s.sessions} sessions (~${formatTokens(s.tokens)})`);
  }

  if (mode === 'apply') {
    const file = join(cwd, '.contextignore');
    const block = `\n# Added by /cco-shield apply — files unused in 3+ sessions (${new Date().toISOString().slice(0, 10)})\n` +
      suggestions.map(s => s.pattern).join('\n') + '\n';
    appendFileSync(file, block);
    console.log(`\n  ✓ Appended ${suggestions.length} pattern(s) to ${file}`);
    console.log('  Reads of these files are now blocked (Grep still works). Edit the file to undo.\n');
  } else {
    console.log('\n  Run `/cco-shield apply` to append these to .contextignore.\n');
  }
}

async function main() {
  const action = process.argv[2];
  if (action === 'suggest' || action === 'apply') {
    suggestOrApply(action);
    return;
  }

  let input = '';
  for await (const chunk of process.stdin) {
    input += chunk;
  }

  if (!input.trim()) process.exit(0);

  let event;
  try { event = JSON.parse(input); } catch { process.exit(0); }

  if (event.hook_event_name !== 'PreToolUse') process.exit(0);

  const toolName = event.tool_name || '';
  const toolInput = event.tool_input || {};

  // Only shield Read operations
  if (toolName !== 'Read') process.exit(0);

  const filePath = toolInput.file_path || '';
  if (!filePath || filePath.startsWith('/dev/') || filePath.startsWith('/proc/')) process.exit(0);

  const sessionId = event.session_id || 'unknown';
  const patterns = loadPatterns();
  const projectRoot = findProjectForPath(patterns, filePath);
  const proj = getProjectPatterns(patterns, projectRoot);

  // ── Observation → rule: suggest .contextignore once per session ────────────
  // The shield already KNOWS which files were read-but-unused in 3+ sessions;
  // turning them into .contextignore rules stops that waste permanently.
  // Only interrupts when the recurring waste is real money (≥30K tokens/session).
  try {
    const cwd = event.cwd || process.cwd();
    const ignoreSuggestions = buildIgnoreSuggestions(patterns, cwd, readIgnoreLines(cwd));
    const totalWaste = ignoreSuggestions.reduce((s, x) => s + x.tokens, 0);
    if (ignoreSuggestions.length && totalWaste >= 30_000) {
      const top = ignoreSuggestions.slice(0, 3).map(s => s.pattern).join(', ');
      emitNotice(sessionId, {
        kind: 'shield:ignore-suggest',
        text:
          `[context-shield] ${ignoreSuggestions.length} file(s) in this project were read but never used in 3+ sessions ` +
          `(~${formatTokens(totalWaste)} tokens/session recurring). Top: ${top}. ` +
          `Run /cco-shield apply to add them to .contextignore for good.`,
      });
    }
  } catch { /* suggestion is best-effort — never block the Read */ }

  const warnings = [];
  let shouldBlock = false;

  // ── Check 1: Known waste file (3+ sessions wasted) ──
  const wasteData = proj.wastedReads[filePath];
  if (wasteData && wasteData.sessions >= 5) {
    warnings.push(
      `[context-shield] ${basename(filePath)} went unused in ${wasteData.sessions} past sessions ` +
      `(~${formatTokens(wasteData.totalTokensWasted)} tokens). ` +
      `Try Grep to find what you need instead of reading the whole file.`
    );
  } else if (wasteData && wasteData.sessions >= 3) {
    warnings.push(
      `[context-shield] Heads up: ${basename(filePath)} wasn't needed in ${wasteData.sessions} past sessions. ` +
      `Try Grep or offset/limit to grab just what you need.`
    );
  }

  // ── Check 2: Large file without offset/limit ──
  // Skip warning when the file has historically been useful (e.g. schemas,
  // type defs, specs) — it's read-only by nature but legitimately needed.
  const isPartial = !!(toolInput.offset || toolInput.limit);
  if (!isPartial) {
    const freqData = proj.fileFrequency[filePath];
    if (freqData && freqData.sessions >= 2) {
      const editRate = freqData.totalEdits / freqData.totalReads;
      const usefulRatio = (freqData.usefulness || 0) / freqData.sessions;
      const isLegitReadOnly = usefulRatio >= 0.5; // useful in half+ of sessions
      if (editRate < 0.1 && freqData.totalReads >= 5 && !isLegitReadOnly) {
        warnings.push(
          `[context-shield] ${basename(filePath)}: read ${freqData.totalReads}x but edited only ${freqData.totalEdits}x ` +
          `across ${freqData.sessions} sessions. Reading less = faster results — try offset/limit!`
        );
      }
    }
  }

  // ── Check 3: File frequently read with co-occurring files ──
  if (proj.coOccurrence[filePath]) {
    const related = Object.entries(proj.coOccurrence[filePath])
      .sort((a, b) => b[1] - a[1])
      .slice(0, 3)
      .filter(([, count]) => count >= 3);

    if (related.length > 0) {
      const names = related.map(([p]) => basename(p)).join(', ');
      warnings.push(
        `[context-shield] Pro tip: ${basename(filePath)} is often edited with: ${names}. ` +
        `Load them together to save time!`
      );
    }
  }

  // Emit at most one shield tip per file, gated by the session noise budget —
  // these are pure FYI, so they must never crowd out Claude's working context.
  if (warnings.length) {
    emitNotice(sessionId, { kind: `shield:${basename(filePath)}`, text: warnings[0] });
  }

  // ContextShield never blocks — only warns
  // Output empty JSON to allow the operation
  process.exit(0);
}

if (isMainModule(import.meta.url)) main().catch(() => process.exit(0));
