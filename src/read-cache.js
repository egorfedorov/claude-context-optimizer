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
  estimateTokens, formatTokens, loadJSON, saveJSON, ensureDataDirs
} from './utils.js';
import { isContextIgnored } from './contextignore.js';
import { parseFileStructure, formatDigest } from './file-digest.js';

ensureDataDirs();

// ── Configuration ─────────────────────────────────────────────────────────────

/** Tokens loaded by other files since last read that triggers staleness. */
const STALE_DISPLACEMENT_TOKENS = 20_000;

/** Number of other files loaded since last read that triggers staleness. */
const STALE_DISPLACEMENT_FILES = 8;

/** Time in ms since last read that triggers staleness (10 minutes). */
const STALE_TIME_MS = 10 * 60 * 1000;

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

  // Displacement check — token-based
  if (newerTokens >= STALE_DISPLACEMENT_TOKENS) {
    return {
      stale: true,
      reason: `${formatTokens(newerTokens)} tokens of other files loaded since last read`
    };
  }

  // Displacement check — file count based
  if (newerFiles >= STALE_DISPLACEMENT_FILES) {
    return {
      stale: true,
      reason: `${newerFiles} other files loaded since last read`
    };
  }

  // Time decay check
  const elapsed = Date.now() - readTime;
  if (elapsed >= STALE_TIME_MS) {
    const mins = Math.round(elapsed / 60_000);
    return {
      stale: true,
      reason: `${mins} min since last read`
    };
  }

  return { stale: false, reason: '' };
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function getMtime(filePath) {
  try { return statSync(filePath).mtimeMs; } catch { return null; }
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
    ppids: existing ? [...new Set([...(existing.ppids || []), ppid])] : [ppid]
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
    entry.ppids = [...new Set([...(entry.ppids || []), ppid])];
    entry.readAt = new Date().toISOString();
    entry.readAtMs = Date.now();
    saveCache(sessionId, cache);
    process.exit(0);
  }

  // ── New range not yet covered — allow ───────────────────────────────
  if (!isRangeCovered(entry.ranges, offset, end)) {
    entry.ranges.push([offset, end]);
    entry.ppids = [...new Set([...(entry.ppids || []), ppid])];
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
