#!/usr/bin/env node

/**
 * Read Cache v1.0
 *
 * PreToolUse hook that BLOCKS redundant file reads within the same session.
 * Maintains a per-session cache of files already read. If a file was fully
 * loaded and its mtime hasn't changed, the read is blocked to save tokens.
 * Partial reads (offset/limit) are allowed if they cover a new range.
 */

import { basename, extname, join } from 'path';
import { statSync } from 'fs';
import {
  READ_CACHE_DIR,
  estimateTokens, formatTokens, loadJSON, saveJSON, ensureDataDirs
} from './utils.js';

ensureDataDirs();

function loadCache(sessionId) {
  const file = join(READ_CACHE_DIR, `${sessionId}.json`);
  return loadJSON(file) || { files: {}, totalTokensSaved: 0, blockedReads: 0 };
}

function saveCache(sessionId, cache) {
  saveJSON(join(READ_CACHE_DIR, `${sessionId}.json`), cache);
}

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

function getMtime(filePath) {
  try { return statSync(filePath).mtimeMs; } catch { return null; }
}

function allow(sessionId, cache, filePath, mtime, offset, end, ext) {
  const tokens = estimateTokens(end - offset, ext);
  cache.files[filePath] = {
    mtime,
    lines: end - offset,
    tokens,
    readAt: new Date().toISOString(),
    ranges: [[offset, end]]
  };
  saveCache(sessionId, cache);
  process.exit(0);
}

async function main() {
  let input = '';
  for await (const chunk of process.stdin) { input += chunk; }
  if (!input.trim()) process.exit(0);

  let event;
  try { event = JSON.parse(input); } catch { process.exit(0); }

  if (event.hook_event_name !== 'PreToolUse') process.exit(0);
  if ((event.tool_name || '') !== 'Read') process.exit(0);

  const toolInput = event.tool_input || {};
  const filePath = toolInput.file_path || '';
  const sessionId = event.session_id || 'unknown';

  if (!filePath || filePath.startsWith('/dev/') || filePath.startsWith('/proc/')) {
    process.exit(0);
  }

  const offset = toolInput.offset || 0;
  const limit = toolInput.limit || 2000;
  const end = offset + limit;
  const ext = extname(filePath);
  const cache = loadCache(sessionId);
  const entry = cache.files[filePath];

  // First read — always allow
  if (!entry) {
    allow(sessionId, cache, filePath, getMtime(filePath), offset, end, ext);
  }

  // Check mtime
  const currentMtime = getMtime(filePath);
  if (currentMtime === null) process.exit(0); // file gone — allow, will fail naturally

  // File modified since last read — reset cache entry and allow
  if (currentMtime !== entry.mtime) {
    allow(sessionId, cache, filePath, currentMtime, offset, end, ext);
  }

  // File unchanged — check range coverage
  if (!isRangeCovered(entry.ranges, offset, end)) {
    // New range — allow and record
    entry.ranges.push([offset, end]);
    entry.lines += limit;
    entry.tokens += estimateTokens(limit, ext);
    entry.readAt = new Date().toISOString();
    saveCache(sessionId, cache);
    process.exit(0);
  }

  // Redundant read — BLOCK
  cache.totalTokensSaved += estimateTokens(limit, ext);
  cache.blockedReads += 1;
  saveCache(sessionId, cache);

  const reason =
    `\u26d4 [read-cache] Already loaded ${basename(filePath)} this session ` +
    `(${entry.lines} lines, ~${formatTokens(entry.tokens)} tokens). ` +
    `File unchanged. Use offset/limit to read a specific section, or Edit to modify it.`;

  console.log(JSON.stringify({ decision: 'block', reason }));
}

main().catch(() => process.exit(0));
