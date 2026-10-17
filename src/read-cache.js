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
 *   - Per-agent isolation: a subagent (hook input carries `agent_id`) starts
 *     with an empty context, so its first read of a file is always allowed.
 *     This used to key on process.ppid, which is the transient /bin/sh when
 *     sh is dash — every read looked new and nothing was ever deduped.
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
  loadConfig, getEffectiveBudget, isMainModule, getFileLines, shouldSkipFile,
  getSessionModel, getThresholds
} from './utils.js';
import { isContextIgnored } from './contextignore.js';
import { parseFileStructure, formatDigest } from './file-digest.js';

ensureDataDirs();

// ── Adaptive staleness configuration ──────────────────────────────────────────
// Thresholds scale with the user's effective context budget so the cache
// behaves correctly on both 200K (Haiku 4.5) and 1M (Opus 4.8 / Opus 4.7 /
// Sonnet 4.6 — all 1M at standard price) windows.
//
// Default ratios (calibrated against 200K window where the previous fixed
// values were 20K/8/10min) — the same fractions on 1M give ~100K/40/10min
// which keeps Read Cache aggressive without false re-allows.

// The base ratios are user-tunable (#39): config.thresholds.staleTokenRatio /
// .staleFiles / .staleTimeMs, each range-validated. CCO_STALE_TIME_MS still
// wins over config, for one-off experiments without editing anything.

let _thresholdCache = null;
let _sessionModel = null;
/** Adapt thresholds to the model the SESSION really runs on (from budget state). */
export function setSessionModel(rawModel) {
  _sessionModel = rawModel || null;
  _thresholdCache = null;
}
function getStaleThresholds() {
  if (_thresholdCache) return _thresholdCache;
  const config = loadConfig();
  const t = getThresholds();
  const budget = getEffectiveBudget(config, _sessionModel);
  // Tokens: share of effective budget, clamped to [10K, 200K]
  const tokens = Math.max(10_000, Math.min(200_000, Math.round(budget * t.staleTokenRatio)));
  // Files: scale gently with budget (8 @ 200K, 32 @ 1M by default)
  const files = Math.max(6, Math.min(40, Math.round(t.staleFiles * (budget / 200_000))));
  // Time: env override beats config
  const timeMs = parseInt(process.env.CCO_STALE_TIME_MS || '', 10) || t.staleTimeMs;
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
 *
 * Pure given `thresholds` and `now` — both injectable so tests can drive the
 * table without a real clock or a real config file. Production passes neither.
 */
export function checkStaleness(cache, filePath, thresholds = null, now = null) {
  const entry = cache.files[filePath];
  if (!entry || !entry.readAtMs) return { stale: false, reason: '' };

  const { tokens: tokTh, files: fileTh, timeMs } = thresholds || getStaleThresholds();

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

  const elapsed = (now === null ? Date.now() : now) - readTime;
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

// ── Big-file first-read nudge ─────────────────────────────────────────────────
/**
 * Decide whether to show a file's structural map instead of loading the whole
 * thing on its FIRST full read. Pure — unit-tested.
 *
 * Fires only when: enabled, this is the first time we see the file (no entry),
 * the read is untargeted (no offset/limit — Claude is about to slurp it all),
 * and the file is very large. The block is one-shot: it creates a placeholder
 * entry, so the very next read (targeted or full) is allowed and cached. Worst
 * case is a single cheap extra round-trip; best case saves ~14K+ tokens when
 * Claude only needed one section.
 */
export function shouldNudgeBigFile({ entry, hasOffset, hasLimit, lines, threshold, enabled }) {
  if (!enabled) return false;
  if (entry) return false;
  if (hasOffset || hasLimit) return false;
  if (!lines || lines < threshold) return false;
  return true;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function getMtime(filePath) {
  try { return statSync(filePath).mtimeMs; } catch { return null; }
}

/**
 * Which context a read lands in. Subagents run in-process (same ppid as the
 * main loop), but Claude Code stamps their hook events with `agent_id`.
 */
export function readContextKey(event) {
  return event.agent_id ? `agent:${event.agent_id}` : 'main';
}

/**
 * Last line a read covers. Capped at the file's real length so a full read of
 * an 800-line file is booked as 800 lines, not the tool's 2000-line default.
 */
export function readEnd(offset, limit, fileLines) {
  const end = offset + limit;
  return fileLines > 0 ? Math.max(offset, Math.min(end, fileLines)) : end;
}

/**
 * The slice of the cache one context owns. The main loop keeps the top-level
 * `files` map (what /cco and the tracker read); each subagent gets its own,
 * since it starts with an empty context and has read nothing the main loop has.
 */
export function contextScope(cache, ctxKey) {
  if (ctxKey === 'main') return cache;
  cache.agents ||= {};
  if (!cache.agents[ctxKey]) {
    // Bound memory: keep the 20 most recently created subagent scopes.
    const keys = Object.keys(cache.agents);
    if (keys.length >= 20) delete cache.agents[keys[0]];
    cache.agents[ctxKey] = { files: {} };
  }
  return cache.agents[ctxKey];
}

function record(scope, filePath, mtime, offset, end, ext) {
  scope.files[filePath] = {
    mtime,
    lines: end - offset,
    tokens: estimateTokens(end - offset, ext),
    readAt: new Date().toISOString(),
    readAtMs: Date.now(),
    ranges: [[offset, end]],
  };
}

// ── Build digest block message ────────────────────────────────────────────────

function buildBlockMessage(filePath, entry, wasPartialRequest) {
  const name = basename(filePath);
  let landmarks = [], digest = '';
  try {
    landmarks = parseFileStructure(filePath);
    // A "no landmarks" line tells Claude nothing — only show a real map.
    if (landmarks.length) digest = '\n' + formatDigest(landmarks, entry.lines);
  } catch { /* map is best-effort */ }

  // Pick a useful offset/limit suggestion from the landmarks
  let suggestion = '';
  if (landmarks.length > 1) {
    const mid = landmarks[Math.floor(landmarks.length / 2)];
    suggestion = `\n→ Need a different part? Read with offset=${mid.line - 1}, limit=50 to see ${mid.label}`;
  }

  // Claude Code labels every refusal "hook error", and a model that takes it
  // for a failure retries or reports being blocked. Say plainly that it is a
  // skip, and that the copy it already has is the one to use.
  const what = wasPartialRequest ? 'That section of' : 'The full';
  return (
    `✅ [read-cache] Not an error — re-read skipped to save tokens. ${what} ${name} is already in your context ` +
    `from an earlier Read this session, and the file is unchanged since (${entry.lines} lines, ~${formatTokens(entry.tokens)} tokens). ` +
    `Use that copy.${digest}${suggestion}` +
    `\nIf it is no longer in your context (older tool results cleared), repeat the same Read and it will go through.`
  );
}

// ── Hook handlers ─────────────────────────────────────────────────────────────
// Pure of process state: each returns what the dispatcher (hook.js) should do
// and never calls process.exit, so several handlers can share one process.

/** PreCompact: the context is being rewritten — every cached read is gone. */
export function onCompact(event) {
  const sessionId = event.session_id || 'unknown';
  const cache = loadCache(sessionId);
  const fileCount = Object.keys(cache.files).length;
  if (fileCount === 0 && !cache.agents) return 0;
  cache.files = {};
  delete cache.agents;
  saveCache(sessionId, cache);
  return fileCount;
}

/** PostToolUse Edit/Write: the file changed — no context holds the new text. */
export function onFileWritten(event) {
  const filePath = (event.tool_input || {}).file_path || '';
  if (!filePath) return;
  const sessionId = event.session_id || 'unknown';
  const cache = loadCache(sessionId);
  let changed = false;
  for (const scope of [cache, ...Object.values(cache.agents || {})]) {
    if (scope.files?.[filePath]) { delete scope.files[filePath]; changed = true; }
  }
  if (changed) saveCache(sessionId, cache);
}

/**
 * PreToolUse Read: allow, or deny with a file map instead of the content.
 * Returns { deny: reason } or { log?: message } (allowed).
 */
export function decideRead(event) {
  const toolInput = event.tool_input || {};
  const filePath = toolInput.file_path || '';
  const sessionId = event.session_id || 'unknown';
  const ctxKey = readContextKey(event);

  if (!filePath || filePath.startsWith('/dev/') || filePath.startsWith('/proc/')) return {};

  // ── .contextignore check ────────────────────────────────────────────
  const ignoreResult = isContextIgnored(filePath);
  if (ignoreResult.ignored) {
    return {
      deny: `🚫 [contextignore] ${basename(filePath)} matches pattern "${ignoreResult.pattern}" in .contextignore. ` +
        `Use Grep to search inside, or remove the pattern from .contextignore to allow reading.`,
    };
  }

  const offset = toolInput.offset || 0;
  const limit = toolInput.limit || 2000;
  const ext = extname(filePath);
  // Binaries (images, archives, locks) have no meaningful line count.
  const fileLines = shouldSkipFile(filePath) ? 0 : getFileLines(filePath);
  const end = readEnd(offset, limit, fileLines);
  setSessionModel(getSessionModel(sessionId));
  const cache = loadCache(sessionId);
  const scope = contextScope(cache, ctxKey);
  const entry = scope.files[filePath];
  if (entry) {
    // Legacy/placeholder entries may lack these fields — default them so the
    // range/token accounting below can't throw (a throw silently kills caching).
    entry.ranges ||= [];
    entry.lines ||= 0;
    entry.tokens ||= 0;
  }

  // ── First read — map-then-load nudge for very large files ───────────
  if (!entry) {
    const cfg = loadConfig();
    const enabled = cfg.bigFileDigest !== false;
    const threshold = cfg.bigFileThreshold || 1500;
    // Never map binaries (images, archives, locks): "2411 lines" of PNG bytes
    // has no structure to map, and the Read tool renders images natively.
    const mappable = enabled && !toolInput.offset && !toolInput.limit;
    const lines = mappable ? fileLines : 0;

    if (shouldNudgeBigFile({
      entry, hasOffset: !!toolInput.offset, hasLimit: !!toolInput.limit, lines, threshold, enabled,
    })) {
      // Placeholder entry (no covered ranges) so the NEXT read is allowed & cached.
      scope.files[filePath] = {
        mtime: getMtime(filePath), lines, tokens: estimateTokens(lines, ext),
        readAt: new Date().toISOString(), readAtMs: Date.now(),
        ranges: [], nudged: true,
      };
      cache.bigFileNudges = (cache.bigFileNudges || 0) + 1;
      saveCache(sessionId, cache);

      let digest = '';
      try { digest = formatDigest(parseFileStructure(filePath), lines); } catch { /* best-effort */ }
      return {
        deny: `🗺️ [read-cache] ${basename(filePath)} is ${lines} lines (~${formatTokens(estimateTokens(lines, ext))} tokens). ` +
          `Here's its map — Read with offset/limit for the section you need, or Read it again to load the whole file.\n${digest}`,
      };
    }

    record(scope, filePath, getMtime(filePath), offset, end, ext);
    saveCache(sessionId, cache);
    return {};
  }

  // ── File deleted — allow (Read tool will return error naturally) ─────
  const currentMtime = getMtime(filePath);
  if (currentMtime === null) return {};

  // ── File modified since last read — allow ───────────────────────────
  if (currentMtime !== entry.mtime) {
    record(scope, filePath, currentMtime, offset, end, ext);
    saveCache(sessionId, cache);
    return { log: `[read-cache] ${basename(filePath)} changed on disk — cache refreshed.` };
  }

  // ── Claude asked again right after a refusal — it needs the text ────
  // Older tool results can be cleared from context without a PreCompact
  // (context editing). A model that repeats the Read after being told it
  // already has the file most likely doesn't: let it through, and take
  // back the savings the refusal claimed, since they never happened.
  if (entry.denied && entry.denied.offset === offset && entry.denied.end === end) {
    cache.totalTokensSaved = Math.max(0, (cache.totalTokensSaved || 0) - (entry.denied.credit || 0));
    cache.blockedReads = Math.max(0, (cache.blockedReads || 0) - 1);
    cache.insistedReads = (cache.insistedReads || 0) + 1;
    record(scope, filePath, currentMtime, offset, end, ext);
    saveCache(sessionId, cache);
    return { log: `[read-cache] ${basename(filePath)} re-read on request after a refusal.` };
  }

  // ── New range not yet covered — allow ───────────────────────────────
  if (!isRangeCovered(entry.ranges, offset, end)) {
    entry.ranges.push([offset, end]);
    entry.lines += end - offset;
    entry.tokens += estimateTokens(end - offset, ext);
    entry.readAt = new Date().toISOString();
    entry.readAtMs = Date.now();
    saveCache(sessionId, cache);
    return {};
  }

  // ── Staleness check — context may have shifted ──────────────────────
  const staleness = checkStaleness(scope, filePath);
  if (staleness.stale) {
    record(scope, filePath, currentMtime, offset, end, ext);
    saveCache(sessionId, cache);
    return { log: `[read-cache] Re-read allowed: ${basename(filePath)} context is stale (${staleness.reason}).` };
  }

  // ── Redundant read — BLOCK with structural digest ───────────────────
  // Count what the re-read would ACTUALLY have reloaded — capped at the tokens
  // already cached for this file — not the raw `limit` (default 2000 lines),
  // which would wildly over-credit re-reads of small files. Honest accounting.
  const wouldReload = Math.min(estimateTokens(end - offset, ext), entry.tokens || estimateTokens(end - offset, ext));
  cache.totalTokensSaved = (cache.totalTokensSaved || 0) + wouldReload;
  cache.blockedReads = (cache.blockedReads || 0) + 1;
  entry.denied = { offset, end, credit: wouldReload };
  saveCache(sessionId, cache);

  const wasPartialRequest = !!(toolInput.offset || toolInput.limit);
  return { deny: buildBlockMessage(filePath, entry, wasPartialRequest) };
}

/** The PreToolUse output that refuses a tool call; the reason is shown to Claude. */
export function denyOutput(reason) {
  return {
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'deny',
      permissionDecisionReason: reason,
    },
  };
}

// Standalone entry (kept for direct invocation); hooks.json goes through hook.js.
async function main() {
  let input = '';
  for await (const chunk of process.stdin) { input += chunk; }
  if (!input.trim()) return;
  let event;
  try { event = JSON.parse(input); } catch { return; }

  if (event.hook_event_name === 'PreCompact') { onCompact(event); return; }
  if (event.hook_event_name === 'PostToolUse' && (event.tool_name === 'Edit' || event.tool_name === 'Write')) {
    onFileWritten(event);
    return;
  }
  if (event.hook_event_name !== 'PreToolUse' || event.tool_name !== 'Read') return;
  const r = decideRead(event);
  if (r.log) console.error(r.log);
  if (r.deny) console.log(JSON.stringify(denyOutput(r.deny)));
}

if (isMainModule(import.meta.url)) main().catch(() => process.exit(0));
