#!/usr/bin/env node

/**
 * Notice ledger — keeps the optimizer from polluting Claude's context.
 *
 * A context optimizer that narrates on every tool call spends the very tokens
 * it claims to save. This module enforces a per-session budget on the plugin's
 * own advisory output and records how many tokens it injected, so the dashboard
 * can report NET savings (saved − overhead) and auto-silence if it ever goes
 * negative.
 *
 * Rules (pure, in shouldEmit):
 *   - priority 'critical'  → always allowed (e.g. "90% budget → /compact now")
 *   - priority 'normal'    → at most once per `kind`, and only while the session
 *                            is under `cap` total advisory lines (default 4)
 *
 * The hot-path hooks (tracker, budget, context-shield) gate every console.error
 * through this. read-cache block messages are NOT counted here — they replace a
 * far larger read, so they're accounted as savings, not overhead.
 *
 * Pure logic is exported for tests; load/save wrap it with disk I/O.
 */

import { join } from 'path';
import { NOTICES_DIR, loadJSON, saveJSON, ensureDataDirs, estimateTokensFromString } from './utils.js';

export const DEFAULT_NOTICE_CAP = 4;

export function emptyLedger() {
  return { count: 0, tokensInjected: 0, kinds: {} };
}

/** Decide whether a notice may be emitted, given the current ledger. Pure. */
export function shouldEmit(ledger, { kind, priority = 'normal', cap = DEFAULT_NOTICE_CAP } = {}) {
  if (priority === 'critical') return true;
  if (!kind) return false;
  if (ledger.kinds[kind]) return false;     // already said this kind this session
  if (ledger.count >= cap) return false;    // session noise budget exhausted
  return true;
}

/** Record that a notice was emitted (updates count, per-kind, injected tokens). Pure. */
export function recordEmit(ledger, { kind, text = '' }) {
  const next = {
    count: ledger.count + 1,
    tokensInjected: ledger.tokensInjected + estimateTokensFromString(text),
    kinds: { ...ledger.kinds, [kind]: (ledger.kinds[kind] || 0) + 1 },
  };
  return next;
}

// ── I/O ───────────────────────────────────────────────────────────────────────

function ledgerFile(sessionId) {
  return join(NOTICES_DIR, `${sessionId}.json`);
}

export function loadLedger(sessionId) {
  return loadJSON(ledgerFile(sessionId)) || emptyLedger();
}

export function saveLedger(sessionId, ledger) {
  ensureDataDirs();
  saveJSON(ledgerFile(sessionId), ledger);
}

/**
 * Convenience for hooks: print `text` to stderr only if the session noise
 * budget allows it, and record the cost. Returns true if it spoke.
 * `printFn` defaults to console.error (stderr → surfaces to Claude as context).
 */
export function emitNotice(sessionId, { kind, text, priority = 'normal', cap = DEFAULT_NOTICE_CAP }, printFn = console.error) {
  if (!sessionId || !text) return false;
  const ledger = loadLedger(sessionId);
  if (!shouldEmit(ledger, { kind, priority, cap })) return false;
  printFn(text);
  saveLedger(sessionId, recordEmit(ledger, { kind, text }));
  return true;
}
