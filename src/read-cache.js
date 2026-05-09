#!/usr/bin/env node

/**
 * Read Cache v2.0 — Smart Context-Aware Blocking
 *
 * PreToolUse hook that prevents redundant file reads while giving the AI
 * enough navigational context to work effectively.
 *
 * v2.0 improvements over v1.1:
 *   1. File Structure Digest — on block, returns a "file map" with function
 *      names, classes, sections and their line numbers (~100 tokens instead
 *      of re-reading ~18K tokens). Gives AI navigation ability.
 *   2. Staleness Detection — allows re-reads when context has likely shifted:
 *      - 20K+ tokens of other files loaded since this file (displacement)
 *      - OR 8+ other files loaded since (displacement by count)
 *      - OR 10+ minutes since last read (time decay)
 *   3. Better Messages — actionable hints with specific offset/limit examples
 *      derived from the file's structural map.
 *
 * v1.1 features preserved:
 *   - PPID tracking for Agent subprocess isolation
 *   - Range tracking for partial reads
 *   - Edit/Write invalidation
 *   - PreCompact cache clearing
 *   - .contextignore integration
 */

import { basename, extname, join } from 'path';
import { statSync } from 'fs';
import {
  READ_CACHE_DIR,
  estimateTokens, formatTokens, loadJSON, saveJSON, ensureDataDirs,
  loadConfig, getEffectiveBudget
} from './utils.js';
import { isContextIgnored } from './contextignore.js';
import { parseFileStructure, formatDigest } from './file-digest.js';

ensureDataDirs();

// ── Adaptive staleness configuration ──────────────────────────────────────────
// Thresholds scale with the user's effective context budget so the cache
// behaves correctly on both 200K (Sonnet) and 1M (Opus 4.7 1M) windows.
//
// Default ratios (calibrated against 200K window where the previous fixed
// values were 20K/8/10min) — the same fractions on 1M give ~100K/40/10min
// which keeps Read Cache aggressive without false re-allows.

const STALE_TOKEN_RATIO = 0.10;   // 10% of budget moved → other file likely evicted
const STALE_FILES_FRACTION_BASE = 8;  // base value for 200K
const STALE_TIME_MS_DEFAULT = 10 * 60 * 1000;

let _thresholdCache = null;
function getStaleThresholds() {
  if (_thresholdCache) return _thresholdCache;
  const config = loadConfig();
  const budget = getEffectiveBudget(config);
  // Tokens: 10% of effective budget, clamped to [10K, 200K]
  const tokens = Math.max(10_000, Math.min(200_000, Math.round(budget * STALE_TOKEN_RATIO)));
  // Files: scale gently with budget (8 @ 200K, 32 @ 1M)
  const files = Math.max(6, Math.min(40, Math.round(STALE_FILES_FRACTION_BASE * (budget / 200_000))));
  // Time: respect env override
  const timeMs = parseInt(process.env.CCO_STALE_TIME_MS || '', 10) || STALE_TIME_MS_DEFAULT;
  _thresholdCache = { tokens, files, timeMs, budget };
  return _thresholdCache;
}

// ── Cache I/O ─────────────────────────────────────────────────────────────────

function loadCache(sessionId) {
  const file = join(READ_CACHE_DIR, `${sessionId}.json`);
  return loadJSON(file) || { files: {}, totalTokensSaved: 0, blockedReads: 0 };
}

function saveCache(sessionId, cache) {
  saveJSON(join(READ_CACHE_DIR, `${sessionId}.json`), cache);
}

// ── Range coverage ────────────────────────────────────────────────────────────

/** Check if [offset, end] is fully covered by existing ranges. */
function isRangeCovered(ranges, offset, end) {
  if (!ranges || ranges.length === 0) return false;
  const sorted = [...ranges].sort((a, b) => a[0] - b[0]);
  const merged = [sorted[0]];
  for (let i = 1; i < sorted.length; i++) {
    const last = merged[merged.length - 1];
    if (sorted[i][0] <= last[1]) {
      last[1] = Math.max(last[1], sorted[i][1]);
    } else {
      merged.push(sorted[i]);
    }
  }
  for (const [s, e] of merged) {
    if (s <= offset && e >= end) return true;
  }
  return false;
}

// ── Staleness detection ───────────────────────────────────────────────────────

/**
 * Check if a cache entry is "stale" — meaning the file's content has likely
 * been evicted from the AI's active context.
 *
 * Two signals:
 *   1. Displacement: enough other files/tokens were loaded after this file
 *      that the original content was probably compressed/evicted.
 *   2. Time decay: enough real time passed that context has likely shifted.
 *
 * Returns { stale: boolean, reason: string }.
 */
function checkStaleness(cache, filePath) {
  const entry = cache.files[filePath];
  if (!entry || !entry.readAtMs) return { stale: false, reason: '' };

  const { tokens: tokTh, files: fileTh, timeMs } = getStaleThresholds();

  const readTime = entry.readAtMs;
  let newerFiles = 0;
  let newerTokens = 0;

  for (const [path, other] of Object.entries(cache.files)) {
    if (path === filePath) continue;
    if ((other.readAtMs || 0) > readTime) {
      newerFiles++;
      newerTokens += other.tokens || 0;
    }
  }

  if (newerTokens >= tokTh) {
    return {
      stale: true,
      reason: `${formatTokens(newerTokens)} tokens of other files loaded since last read`
    };
  }

  if (newerFiles >= fileTh) {
    return {
      stale: true,
      reason: `${newerFiles} other files loaded since last read`
    };
  }

  const elapsed = Date.now() - readTime;
  if (elapsed >= timeMs) {
    const mins = Math.round(elapsed / 60_000);
    return {
      stale: true,
      reason: `${mins} min since last read`
    };
  }

  return { stale: false, reason: '' };
}

// Exposed for testing — recreate threshold lookup in unit tests.
export const _staleConfig = getStaleThresholds;

// ── Helpers ───────────────────────────────────────────────────────────────────

function getMtime(filePath) {
  try { return statSync(filePath).mtimeMs; } catch { return null; }
}

/** Cap PPID list to last N entries to bound memory. */
function trimPpids(ppids, max = 20) {
  const unique = [...new Set(ppids)];
  return unique.slice(-max);
}

function allow(sessionId, cache, filePath, mtime, offset, end, ext, ppid, logMsg) {
  const tokens = estimateTokens(end - offset, ext);
  const existing = cache.files[filePath];
  cache.files[filePath] = {
    mtime,
    lines: end - offset,
    tokens,
    readAt: new Date().toISOString(),
    readAtMs: Date.now(),
    ranges: [[offset, end]],
    ppids: trimPpids(existing ? [...(existing.ppids || []), ppid] : [ppid])
  };
  saveCache(sessionId, cache);
  if (logMsg) console.error(logMsg);
  process.exit(0);
}

// ── Build digest block message ────────────────────────────────────────────────

function buildBlockMessage(filePath, entry, wasPartialRequest) {
  const name = basename(filePath);
  let landmarks, digest;
  try {
    landmarks = parseFileStructure(filePath);
    digest = formatDigest(landmarks, entry.lines);
  } catch {
    landmarks = [];
    digest = '';
  }

  // Pick a useful offset/limit suggestion from the landmarks
  let suggestion = '';
  if (landmarks.length > 1) {
    const mid = landmarks[Math.floor(landmarks.length / 2)];
    suggestion = `\n→ Example: Read with offset=${mid.line - 1}, limit=50 to see ${mid.label}`;
  }

  const partialHint = wasPartialRequest ? ' This section is already loaded.' : '';

  const reason =
    `⛔ [read-cache] Already loaded ${name} this session ` +
    `(${entry.lines} lines, ~${formatTokens(entry.tokens)} tokens).` +
    `${partialHint} File unchanged.\n${digest}${suggestion}`;

  return reason;
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  let input = '';
  for await (const chunk of process.stdin) { input += chunk; }
  if (!input.trim()) process.exit(0);

  let event;
  try { event = JSON.parse(input); } catch { process.exit(0); }

  // ── PreCompact: clear cache (context is being compressed) ───────────
  if (event.hook_event_name === 'PreCompact') {
    const sessionId = event.session_id || 'unknown';
    const cache = loadCache(sessionId);
    const fileCount = Object.keys(cache.files).length;
    if (fileCount > 0) {
      cache.files = {};
      saveCache(sessionId, cache);
      console.error(`[read-cache] Context compacted — ${fileCount} file(s) cleared from cache. Fresh reads welcome!`);
    }
    process.exit(0);
  }

  // ── PostToolUse: invalidate cache on Edit/Write ─────────────────────
  if (event.hook_event_name === 'PostToolUse' && (event.tool_name === 'Edit' || event.tool_name === 'Write')) {
    const filePath = (event.tool_input || {}).file_path || '';
    if (filePath) {
      const sessionId = event.session_id || 'unknown';
      const cache = loadCache(sessionId);
      if (cache.files[filePath]) {
        delete cache.files[filePath];
        saveCache(sessionId, cache);
      }
    }
    process.exit(0);
  }

  if (event.hook_event_name !== 'PreToolUse') process.exit(0);
  if ((event.tool_name || '') !== 'Read') process.exit(0);

  const toolInput = event.tool_input || {};
  const filePath = toolInput.file_path || '';
  const sessionId = event.session_id || 'unknown';
  const ppid = process.ppid;

  if (!filePath || filePath.startsWith('/dev/') || filePath.startsWith('/proc/')) {
    process.exit(0);
  }

  // ── .contextignore check ────────────────────────────────────────────
  const ignoreResult = isContextIgnored(filePath);
  if (ignoreResult.ignored) {
    const reason = `🚫 [contextignore] ${basename(filePath)} matches pattern "${ignoreResult.pattern}" in .contextignore. ` +
      `Use Grep to search inside, or remove the pattern from .contextignore to allow reading.`;
    console.log(JSON.stringify({ decision: 'block', reason }));
    process.exit(0);
  }

  const offset = toolInput.offset || 0;
  const limit = toolInput.limit || 2000;
  const end = offset + limit;
  const ext = extname(filePath);
  const cache = loadCache(sessionId);
  const entry = cache.files[filePath];

  // ── First read — always allow ───────────────────────────────────────
  if (!entry) {
    allow(sessionId, cache, filePath, getMtime(filePath), offset, end, ext, ppid);
  }

  // ── File deleted — allow (Read tool will return error naturally) ─────
  const currentMtime = getMtime(filePath);
  if (currentMtime === null) process.exit(0);

  // ── File modified since last read — allow ───────────────────────────
  if (currentMtime !== entry.mtime) {
    allow(sessionId, cache, filePath, currentMtime, offset, end, ext, ppid,
      `[read-cache] ${basename(filePath)} changed on disk — cache refreshed.`);
  }

  // ── Different process context (Agent subprocess) — allow ────────────
  if (!(entry.ppids || []).includes(ppid)) {
    entry.ppids = trimPpids([...(entry.ppids || []), ppid]);
    entry.readAt = new Date().toISOString();
    entry.readAtMs = Date.now();
    saveCache(sessionId, cache);
    process.exit(0);
  }

  // ── New range not yet covered — allow ───────────────────────────────
  if (!isRangeCovered(entry.ranges, offset, end)) {
    entry.ranges.push([offset, end]);
    entry.ppids = trimPpids([...(entry.ppids || []), ppid]);
    entry.lines += limit;
    entry.tokens += estimateTokens(limit, ext);
    entry.readAt = new Date().toISOString();
    entry.readAtMs = Date.now();
    saveCache(sessionId, cache);
    process.exit(0);
  }

  // ── Staleness check — context may have shifted ──────────────────────
  const staleness = checkStaleness(cache, filePath);
  if (staleness.stale) {
    allow(sessionId, cache, filePath, currentMtime, offset, end, ext, ppid,
      `[read-cache] Re-read allowed: ${basename(filePath)} context is stale (${staleness.reason}).`);
  }

  // ── Redundant read — BLOCK with structural digest ───────────────────
  cache.totalTokensSaved += estimateTokens(limit, ext);
  cache.blockedReads += 1;
  saveCache(sessionId, cache);

  const wasPartialRequest = !!(toolInput.offset || toolInput.limit);
  const reason = buildBlockMessage(filePath, entry, wasPartialRequest);

  console.log(JSON.stringify({ decision: 'block', reason }));
}

main().catch(() => process.exit(0));
