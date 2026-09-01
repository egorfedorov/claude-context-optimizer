#!/usr/bin/env node

/**
 * Real token usage from the Claude Code session transcript.
 *
 * Every hook event carries `transcript_path` — the session's JSONL transcript,
 * where each assistant message includes `message.usage` with EXACT token
 * counts from the API (input, cache reads/writes, output). Reading it replaces
 * the chars-per-token heuristic with ground truth wherever it's available;
 * estimation remains the fallback (fresh sessions, missing/rotated files).
 *
 * Only the file's tail is read (the last assistant message is what matters),
 * so this stays cheap enough for the PostToolUse hot path.
 */

import { openSync, readSync, fstatSync, closeSync } from 'fs';

/** '1h' when the usage record carries any 1-hour cache write, else '5m'. */
export function cacheTtlOf(u) {
  const cc = u && u.cache_creation;
  return cc && (cc.ephemeral_1h_input_tokens || 0) > 0 ? '1h' : '5m';
}

/**
 * Scan transcript lines from the end for the most recent assistant usage.
 * Pure — exported for tests. Returns { contextTokens, outputTokens } or null.
 * contextTokens = what the context window currently holds (input + all cache).
 */
export function parseUsageFromLines(lines) {
  for (let i = lines.length - 1; i >= 0; i--) {
    let obj;
    try { obj = JSON.parse(lines[i]); } catch { continue; }
    const u = obj && obj.message && obj.message.usage;
    if (u && typeof u.input_tokens === 'number') {
      return {
        contextTokens:
          (u.input_tokens || 0) +
          (u.cache_read_input_tokens || 0) +
          (u.cache_creation_input_tokens || 0),
        outputTokens: u.output_tokens || 0,
        // The session's REAL model id (e.g. "claude-fable-5-1") — lets budget /
        // dashboard / read-cache adapt window+pricing per session instead of
        // trusting the static config.model.
        model: (obj.message.model || null),
        // Which prompt-cache TTL this session is on. Claude Code writes 1-hour
        // entries on most sessions now (2× write rate, 60-min break window).
        cacheTtl: cacheTtlOf(u),
      };
    }
  }
  return null;
}

/**
 * Full-session cache economics from every assistant usage record, in order.
 * Pure — exported for tests.
 *
 * Returns { turns, totals: {input, cacheRead, cacheCreation, cacheCreation1h,
 * output}, breaks }. `cacheCreation1h` is the share of `cacheCreation` written
 * with the 1-hour TTL (billed at 2× instead of 1.25×).
 * A cache BREAK is a turn where the previously-cached context stopped being
 * read from cache (gap > cache TTL, mid-session system-prompt change, model
 * switch): cache_read drops far below the previous turn's cached total and the
 * whole context is re-written at the cache-write rate (1.25× / 2× for 1h TTL). `lostTokens` is the
 * cached prefix that had to be paid for again.
 */
export function parseEconomicsFromLines(lines) {
  const totals = { input: 0, cacheRead: 0, cacheCreation: 0, cacheCreation1h: 0, output: 0 };
  const breaks = [];
  let turns = 0;
  let prevCached = 0;

  for (const line of lines) {
    let obj;
    try { obj = JSON.parse(line); } catch { continue; }
    const u = obj && obj.message && obj.message.usage;
    if (!u || typeof u.input_tokens !== 'number') continue;

    const cacheRead = u.cache_read_input_tokens || 0;
    const cacheCreation = u.cache_creation_input_tokens || 0;
    turns++;
    totals.input += u.input_tokens || 0;
    totals.cacheRead += cacheRead;
    totals.cacheCreation += cacheCreation;
    totals.cacheCreation1h += Math.min(cacheCreation, (u.cache_creation && u.cache_creation.ephemeral_1h_input_tokens) || 0);
    totals.output += u.output_tokens || 0;

    // Warm cache suddenly went cold: >20K was cached, but this turn read back
    // less than half of it. (Threshold filters out normal turn-to-turn noise.)
    if (prevCached > 20_000 && cacheRead < prevCached * 0.5) {
      breaks.push({ turn: turns, lostTokens: prevCached - cacheRead });
      prevCached = cacheRead + cacheCreation; // prefix restarts from this turn
    } else {
      prevCached = Math.max(prevCached, cacheRead + cacheCreation);
    }
  }

  return turns > 0 ? { turns, totals, breaks } : null;
}

/** Read full-session economics from a transcript file. Null on any failure. */
export function readTranscriptEconomics(transcriptPath, maxBytes = 64 * 1024 * 1024) {
  if (!transcriptPath) return null;
  try {
    const fd = openSync(transcriptPath, 'r');
    try {
      const size = fstatSync(fd).size;
      if (size === 0 || size > maxBytes) return null;
      const buf = Buffer.alloc(size);
      readSync(fd, buf, 0, size, 0);
      return parseEconomicsFromLines(buf.toString('utf-8').split('\n').filter(Boolean));
    } finally {
      closeSync(fd);
    }
  } catch {
    return null;
  }
}

/** Read real usage from a transcript file, tail-only. Null on any failure. */
export function readRealUsage(transcriptPath, tailBytes = 256 * 1024) {
  if (!transcriptPath) return null;
  try {
    const fd = openSync(transcriptPath, 'r');
    try {
      const size = fstatSync(fd).size;
      if (size === 0) return null;
      const start = Math.max(0, size - tailBytes);
      const buf = Buffer.alloc(size - start);
      readSync(fd, buf, 0, buf.length, start);
      const lines = buf.toString('utf-8').split('\n');
      if (start > 0) lines.shift(); // first line may be cut mid-record
      return parseUsageFromLines(lines.filter(Boolean));
    } finally {
      closeSync(fd);
    }
  } catch {
    return null;
  }
}
