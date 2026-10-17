#!/usr/bin/env node

/**
 * Hook dispatcher — the one script hooks.json runs.
 *
 * Every feature used to be its own hook command, which cost a Node start per
 * feature per tool call and, worse, could not talk: Claude Code ignores a
 * hook's stderr when it exits 0, and reads stdout as JSON only when the whole
 * of it is one object. So each feature now hands its result back here, and
 * this file writes the single reply for the event:
 *
 *   hookSpecificOutput.permissionDecision  read-cache / .contextignore refusals
 *   hookSpecificOutput.additionalContext   notices meant for Claude
 *   systemMessage                          notices meant for the user
 *
 * A failing feature is skipped, never fatal: the hook always exits 0.
 */

import { join } from 'path';
import { DATA_DIR, loadJSON, saveJSON, isMainModule, toPosixPath, acquireFileLock, loadConfig } from './utils.js';
import { collectNotices, takeNotices, recordInjected } from './notices.js';

/** Tools whose results enter the context — the ones worth accounting. */
export const TRACKED_TOOLS = /^(Bash|Read|Edit|MultiEdit|Write|NotebookEdit|Glob|Grep|Agent|Task|WebFetch|WebSearch|mcp__.+)$/;

/** Events whose JSON output can carry additionalContext for Claude. */
const CONTEXT_EVENTS = new Set(['PreToolUse', 'PostToolUse', 'UserPromptSubmit', 'SessionStart']);

const RECAPS_FILE = join(DATA_DIR, 'recaps.json');
const RECAP_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

/** Run one feature; a throw costs that feature only. */
async function safely(fn) {
  try { return await fn(); } catch { return undefined; }
}

// ── Session recap ─────────────────────────────────────────────────────────────
// SessionEnd output reaches no one, and all SessionEnd hooks share a 1.5 s
// budget — too little to price a long transcript. So SessionEnd only finalizes
// the session and leaves a note per project; the next session started there
// prices it and shows the user the verdict.

function recapKey(cwd) { return toPosixPath(cwd || ''); }

export function saveRecap(cwd, recap, now = Date.now(), file = RECAPS_FILE) {
  if (!recap || !recap.sessionId) return;
  const all = loadJSON(file) || {};
  all[recapKey(cwd)] = { ...recap, at: now };
  // Keep the 20 most recent projects.
  const keys = Object.keys(all).sort((a, b) => all[b].at - all[a].at);
  for (const k of keys.slice(20)) delete all[k];
  saveJSON(file, all);
}

/** The pending recap for a project (consumed), or null if none or too old. */
export function takeRecap(cwd, now = Date.now(), file = RECAPS_FILE) {
  const all = loadJSON(file);
  const key = recapKey(cwd);
  if (!all || !all[key]) return null;
  const recap = all[key];
  delete all[key];
  saveJSON(file, all);
  return now - recap.at <= RECAP_MAX_AGE_MS ? recap : null;
}

/** The user-facing verdict on a finished session ('' when nothing to say). */
export async function renderRecap(recap) {
  if (!recap) return '';
  const summary = await safely(async () => (await import('./dashboard.js')).endSession(recap.sessionId));
  const body = [(recap.endLine || '').replace(/^\[cco\] /, '  '), summary].filter(Boolean).join('\n');
  return body ? `[cco] Last session here:\n${body}` : '';
}

// ── Cost policy ───────────────────────────────────────────────────────────────
// The cheapest token is one the main model never reads. The plugin ships two
// Haiku subagents (agents/scout.md, agents/runner.md); this tells the main
// model, once per conversation, when to use them. Off with
// `"orchestrate": false` in ~/.claude-context-optimizer/config.json.

export const COST_POLICY =
  '[context-optimizer] Token policy for this session: hand reading-heavy work — exploring several files, ' +
  'wide searches — to the `context-optimizer:scout` subagent, and long-output commands — test ' +
  'suites, builds — to `context-optimizer:runner`. Both run on Haiku 5.5 (~40× cheaper than Opus) and return ' +
  'only a short summary, so this context stays small. Do a single known file or one grep yourself, and keep ' +
  'edits and design decisions here.';

/** The policy text for a SessionStart, or '' (off, or already in context). */
export function costPolicy(source, cfg = {}) {
  if (cfg.orchestrate === false) return '';
  // A resumed or forked conversation still carries the earlier copy.
  if (source === 'resume' || source === 'fork') return '';
  return COST_POLICY;
}

// ── Output ────────────────────────────────────────────────────────────────────

// Claude Code caps additionalContext and systemMessage at 10,000 characters.
const MAX_FIELD_CHARS = 9_500;

export function clip(text, max = MAX_FIELD_CHARS) {
  return text.length <= max ? text : text.slice(0, max - 1) + '…';
}

/**
 * The single JSON reply for an event, or null when there is nothing to say.
 * Pure — unit-tested.
 */
export function buildOutput(eventName, { deny = null, context = [], user = [] } = {}) {
  const specific = {};
  if (deny && eventName === 'PreToolUse') {
    specific.permissionDecision = 'deny';
    specific.permissionDecisionReason = clip(deny);
  }
  const ctx = context.filter(Boolean);
  if (ctx.length && CONTEXT_EVENTS.has(eventName)) specific.additionalContext = clip(ctx.join('\n\n'));

  const out = {};
  if (Object.keys(specific).length) out.hookSpecificOutput = { hookEventName: eventName, ...specific };
  const msg = user.filter(Boolean);
  if (msg.length) out.systemMessage = clip(msg.join('\n'));
  return Object.keys(out).length ? out : null;
}

// ── Dispatch ──────────────────────────────────────────────────────────────────

export async function dispatch(event) {
  const name = event.hook_event_name || '';
  const tool = event.tool_name || '';
  const context = [];
  const user = [];
  let deny = null;

  // Claude often runs tools in parallel, and Claude Code fires their hooks in
  // parallel too. Every feature does read-modify-write on per-session JSON, so
  // without this, parallel reads lose each other's updates (8 parallel Reads
  // used to book 5). Waits ~0.6 s at most, then proceeds unlocked.
  const release = acquireFileLock(`session-${String(event.session_id || 'unknown').replace(/[^\w-]/g, '_')}`);
  collectNotices();
  try {
    switch (name) {
      case 'PreToolUse': {
        if (tool !== 'Read') break;
        const r = await safely(async () => (await import('./read-cache.js')).decideRead(event)) || {};
        if (r.deny) { deny = r.deny; break; }
        // Shield tips are only worth their tokens when the read goes ahead.
        await safely(async () => (await import('./context-shield.js')).shieldRead(event));
        break;
      }

      case 'PostToolUse': {
        if (tool === 'Edit' || tool === 'MultiEdit' || tool === 'Write' || tool === 'NotebookEdit') {
          await safely(async () => (await import('./read-cache.js')).onFileWritten(event));
        }
        if (!TRACKED_TOOLS.test(tool)) break;
        // Sequential on purpose: both write the session's notice ledger.
        await safely(async () => (await import('./tracker.js')).trackEvent(event));
        await safely(async () => (await import('./budget.js')).budgetEvent(event));
        break;
      }

      case 'UserPromptSubmit': {
        context.push(await safely(async () => (await import('./prompt-coach.js')).coachPrompt(event)));
        await safely(async () => (await import('./budget.js')).noteSession(event));
        break;
      }

      case 'PreCompact': {
        await safely(async () => (await import('./read-cache.js')).onCompact(event));
        await safely(async () => (await import('./tracker.js')).trackEvent(event));
        break;
      }

      case 'SessionStart': {
        await safely(async () => (await import('./tracker.js')).trackEvent(event));
        context.push(await safely(async () => (await import('./tasks.js')).rehydrateText(event)));
        const policy = costPolicy(event.source, loadConfig());
        if (policy) {
          context.push(policy);
          // It enters Claude's context, so it counts against NET savings.
          await safely(() => recordInjected(event.session_id, policy));
        }
        // A brand-new conversation in this project: say how the last one went.
        if (!event.source || event.source === 'startup' || event.source === 'clear') {
          user.push(await renderRecap(await safely(() => takeRecap(event.cwd))));
        }
        break;
      }

      case 'SessionEnd': {
        const t = await safely(async () => (await import('./tracker.js')).trackEvent(event)) || {};
        await safely(() => saveRecap(event.cwd, { sessionId: event.session_id, endLine: t.endLine || '' }));
        break;
      }

      default:
        break;
    }
  } finally {
    release();
    for (const n of takeNotices()) (n.audience === 'user' ? user : context).push(n.text);
  }

  return buildOutput(name, { deny, context, user });
}

async function main() {
  let input = '';
  for await (const chunk of process.stdin) input += chunk;
  if (!input.trim()) return;
  let event;
  try { event = JSON.parse(input); } catch { return; }
  const out = await dispatch(event);
  if (out) process.stdout.write(JSON.stringify(out) + '\n');
}

if (isMainModule(import.meta.url)) main().catch(() => process.exit(0));
