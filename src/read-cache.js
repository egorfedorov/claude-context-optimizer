#!/usr/bin/env node

/**
 * Read Cache v1.1
 *
 * PreToolUse hook that BLOCKS redundant file reads within the same session.
 * Maintains a per-session cache of files already read. If a file was fully
 * loaded and its mtime hasn't changed, the read is blocked to save tokens.
 * Partial reads (offset/limit) are allowed if they cover a new range.
 *
 * v1.1: Tracks process context (PPID) so Agent subprocess reads don't
 * block reads in the main conversation. Smarter hint messages.
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

function allow(sessionId, cache, filePath, mtime, offset, end, ext, ppid) {
  const tokens = estimateTokens(end - offset, ext);
  const existing = cache.files[filePath];
  cache.files[filePath] = {
    mtime,
    lines: end - offset,
    tokens,
    readAt: new Date().toISOString(),
    ranges: [[offset, end]],
    ppids: existing ? [...new Set([...(existing.ppids || []), ppid])] : [ppid]
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

  // On compaction, Claude forgets file contents — clear the cache
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

  // On Edit/Write, the file content changed — invalidate its cache entry
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

  const offset = toolInput.offset || 0;
  const limit = toolInput.limit || 2000;
  const end = offset + limit;
  const ext = extname(filePath);
  const cache = loadCache(sessionId);
  const entry = cache.files[filePath];

  // First read — always allow
  if (!entry) {
    allow(sessionId, cache, filePath, getMtime(filePath), offset, end, ext, ppid);
  }

  // Check mtime
  const currentMtime = getMtime(filePath);
  if (currentMtime === null) process.exit(0); // file gone — allow, will fail naturally

  // File modified since last read — reset cache entry and allow
  if (currentMtime !== entry.mtime) {
    allow(sessionId, cache, filePath, currentMtime, offset, end, ext, ppid);
  }

  // Different process context (e.g., main conversation vs Agent subprocess).
  // Agent reads go into the agent's context, not the main conversation,
  // so we must not block reads from a different process context.
  if (!(entry.ppids || []).includes(ppid)) {
    entry.ppids = [...new Set([...(entry.ppids || []), ppid])];
    entry.readAt = new Date().toISOString();
    saveCache(sessionId, cache);
    process.exit(0); // allow — different context
  }

  // File unchanged — check range coverage
  if (!isRangeCovered(entry.ranges, offset, end)) {
    // New range — allow and record
    entry.ranges.push([offset, end]);
    entry.ppids = [...new Set([...(entry.ppids || []), ppid])];
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

  // Smart hint: if user specified offset/limit and it's cached, say so.
  // If full-file read, suggest offset/limit for a different section.
  const wasPartialRequest = !!(toolInput.offset || toolInput.limit);
  const hint = wasPartialRequest
    ? 'This section is already loaded.'
    : 'Tip: use offset/limit to read a different section.';

  const reason =
    `💾 [read-cache] ${basename(filePath)} is already in context ` +
    `(${entry.lines} lines, ~${formatTokens(entry.tokens)} tokens saved). ` +
    `File unchanged — no need to re-read! ${hint}`;

  console.log(JSON.stringify({ decision: 'block', reason }));
}

main().catch(() => process.exit(0));
