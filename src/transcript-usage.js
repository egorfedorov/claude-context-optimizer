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
      };
    }
  }
  return null;
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
