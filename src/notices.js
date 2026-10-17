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
 * The hot-path hooks (tracker, budget, context-shield) gate every notice
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

/** Book context tokens a hook injected outside emitNotice (prompt coach). */
export function recordInjected(sessionId, text) {
  if (!sessionId || !text) return;
  const ledger = loadLedger(sessionId);
  ledger.tokensInjected = (ledger.tokensInjected || 0) + estimateTokensFromString(text);
  saveLedger(sessionId, ledger);
}

// ── Delivery ─────────────────────────────────────────────────────────────────
// Claude Code ignores a hook's stderr when it exits 0 (debug log only), so a
// notice has to travel in the hook's JSON output: `additionalContext` reaches
// Claude, `systemMessage` reaches the user. hook.js opens a sink, runs the
// handlers, then turns what they emitted into that JSON.

let _sink = null;

/** Start collecting notices instead of printing them (hook.js). */
export function collectNotices() { _sink = []; }

/** Stop collecting; returns [{ text, audience }] in emit order. */
export function takeNotices() {
  const out = _sink || [];
  _sink = null;
  return out;
}

/**
 * Convenience for hooks: speak only if the session noise budget allows it, and
 * record the cost. Returns true if it spoke.
 *
 * `audience`: 'claude' (enters the model's context, counted as CCO overhead)
 * or 'user' (shown in the UI only — costs no context tokens).
 * Outside hook.js (no sink) it falls back to `printFn` for CLI use.
 */
export function emitNotice(sessionId, { kind, text, priority = 'normal', cap = DEFAULT_NOTICE_CAP, audience = 'claude' }, printFn = console.error) {
  if (!sessionId || !text) return false;
  const ledger = loadLedger(sessionId);
  if (!shouldEmit(ledger, { kind, priority, cap })) return false;
  if (_sink) _sink.push({ text, audience });
  else printFn(text);
  saveLedger(sessionId, recordEmit(ledger, { kind, text: audience === 'claude' ? text : '' }));
  return true;
}
