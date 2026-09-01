#!/usr/bin/env node

/**
 * Task register — the "organize work by task" layer of the Context Control Center.
 *
 * A task is a named unit of work. While a task is active, the tokens your
 * session spends are attributed to it, so the dashboard can show cost *per task*
 * (not just per session). Combined with Smart Pack (/cco-pack), each task gets
 * the minimal context it needs and you can see which task is burning budget.
 *
 * Storage: one JSON file (TASKS_FILE), a flat list of tasks scoped by project +
 * session. At most one task is "active" per (project, session) at a time.
 *
 * Execution state (v4.10, after SKILL.state — Google/Purdue, 2026): each task
 * carries a small JSON `state` that Claude updates with PATCHES (set keys,
 * `null` deletes) instead of re-deriving progress from the transcript. It is
 * capped in size, so it stays O(1) however long the task runs, and it is
 * re-injected verbatim after /compact and on resume — the one moment where a
 * plugin can replace "re-read the history" with "read the state".
 *
 * The core logic is pure (no I/O) so it is unit-testable; loadTasks/saveTasks
 * wrap it with disk access.
 */

import { readFileSync } from 'fs';
import {
  TASKS_FILE, loadJSON, saveJSON, ensureDataDirs, isMainModule,
  formatTokens, getModelCost, loadConfig, getLatestSessionId, getSessionTokenTotal
} from './utils.js';

const STATE_VERSION = 1;

// Bound on the serialized task state. SKILL.state's whole point is a prompt
// that does not grow with the step count; ~1K tokens is enough for a goal,
// a done-list, open questions and the next action. Over the cap the patch is
// rejected and the caller is told to prune (set finished keys to null).
export const TASK_STATE_MAX_CHARS = 4000;

export function emptyState() {
  return { version: STATE_VERSION, tasks: [], nextId: 1 };
}

// ── Pure logic ────────────────────────────────────────────────────────────────

/** Find the active task for a (project, session), or null. */
export function getActiveTask(state, { project = null, sessionId = null } = {}) {
  for (let i = state.tasks.length - 1; i >= 0; i--) {
    const t = state.tasks[i];
    if (t.status !== 'active') continue;
    if (project != null && t.project !== project) continue;
    if (sessionId != null && t.sessionId !== sessionId) continue;
    return t;
  }
  return null;
}

/** Tokens attributed to a task: delta of session tokens over the task window. */
export function taskSpend(task, tokensNow) {
  const end = task.status === 'done' ? (task.tokensAtEnd ?? task.tokensAtStart) : tokensNow;
  return Math.max(0, (end || 0) - (task.tokensAtStart || 0));
}

/**
 * Start a new task. Any currently-active task in the same (project, session) is
 * completed first (one active task at a time). Returns { state, task }.
 */
export function addTask(state, { name, project = null, sessionId = null, tokensNow = 0, files = [], stamp = null }) {
  const next = { ...state, tasks: [...state.tasks] };
  // Close the current active task in this scope.
  const active = getActiveTask(next, { project, sessionId });
  if (active) {
    const idx = next.tasks.indexOf(active);
    next.tasks[idx] = { ...active, status: 'done', tokensAtEnd: tokensNow, completedAt: stamp };
  }
  const id = next.nextId || 1;
  const task = {
    id,
    name: String(name || 'untitled').trim().slice(0, 120),
    project,
    sessionId,
    status: 'active',
    createdAt: stamp,
    completedAt: null,
    tokensAtStart: tokensNow,
    tokensAtEnd: null,
    packedFiles: Array.isArray(files) ? files.slice(0, 200) : [],
    note: '',
    state: {},
    stateUpdatedAt: null,
  };
  next.tasks.push(task);
  next.nextId = id + 1;
  return { state: next, task };
}

/** Complete the active task in a scope. Returns { state, task|null }. */
export function completeActiveTask(state, { project = null, sessionId = null, tokensNow = 0, note = '', stamp = null } = {}) {
  const active = getActiveTask(state, { project, sessionId });
  if (!active) return { state, task: null };
  const next = { ...state, tasks: [...state.tasks] };
  const idx = next.tasks.indexOf(active);
  const done = { ...active, status: 'done', tokensAtEnd: tokensNow, completedAt: stamp, note: note || active.note };
  next.tasks[idx] = done;
  return { state: next, task: done };
}

/**
 * Apply a SKILL.state-style patch to a state object: every key in `patch` is
 * set; a `null` value deletes the key. Pure. Returns { state } or { error }
 * when the patch is not a plain object or the result exceeds the size cap.
 */
export function applyStatePatch(state, patch, maxChars = TASK_STATE_MAX_CHARS) {
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) {
    return { error: 'patch must be a JSON object: {"key": value, "finished_key": null}' };
  }
  const next = { ...(state && typeof state === 'object' ? state : {}) };
  for (const [k, v] of Object.entries(patch)) {
    if (v === null) delete next[k];
    else next[k] = v;
  }
  const size = JSON.stringify(next).length;
  if (size > maxChars) {
    return { error: `state would be ${size} chars (cap ${maxChars}) — prune finished keys with null before adding more` };
  }
  return { state: next };
}

/** Patch the active task's state in a scope. Returns { state, task, error? }. */
export function patchActiveTask(state, { project = null, sessionId = null, patch, stamp = null } = {}) {
  const active = getActiveTask(state, { project, sessionId });
  if (!active) return { state, task: null, error: 'no active task — start one with /cco-task add "<name>"' };
  const r = applyStatePatch(active.state || {}, patch);
  if (r.error) return { state, task: active, error: r.error };
  const next = { ...state, tasks: [...state.tasks] };
  const updated = { ...active, state: r.state, stateUpdatedAt: stamp };
  next.tasks[next.tasks.indexOf(active)] = updated;
  return { state: next, task: updated };
}

/**
 * The bounded block re-injected after /compact or on resume: instructions +
 * current state, nothing else. Null when there is nothing worth injecting.
 */
export function renderRehydration(task) {
  if (!task || task.status !== 'active') return null;
  const st = task.state && typeof task.state === 'object' ? task.state : {};
  if (!Object.keys(st).length) return null;
  return [
    `[cco-task] Active task #${task.id}: ${task.name}`,
    'Execution state (authoritative — trust this over any summary of earlier turns):',
    JSON.stringify(st),
    'Update it as you go: /cco-task patch \'{"key": value, "finished_key": null}\'',
  ].join('\n');
}

/** Should a SessionStart event re-inject task state? Only after compaction / resume. */
export function shouldRehydrate(source) {
  return source === 'compact' || source === 'resume';
}

/** Tasks for a project (newest first), optional limit. */
export function tasksForProject(state, project, limit = 20) {
  return state.tasks
    .filter(t => project == null || t.project === project)
    .slice()
    .reverse()
    .slice(0, limit);
}

// ── I/O ───────────────────────────────────────────────────────────────────────

export function loadTasks() {
  const data = loadJSON(TASKS_FILE);
  if (!data || !Array.isArray(data.tasks)) return emptyState();
  if (typeof data.nextId !== 'number') {
    data.nextId = data.tasks.reduce((m, t) => Math.max(m, (t.id || 0) + 1), 1);
  }
  return data;
}

export function saveTasks(state) {
  ensureDataDirs();
  saveJSON(TASKS_FILE, state);
}

// ── CLI (used by the cco-task skill) ───────────────────────────────────────────

function fmtCost(tokens, model) {
  // Rough blended estimate: treat attributed tokens as input for a conservative $.
  const c = getModelCost(model);
  return ((tokens / 1_000_000) * c.input).toFixed(3);
}

function printTasks(state, project, model) {
  const list = tasksForProject(state, project, 12);
  if (!list.length) {
    console.log('No tasks yet. Start one:  /cco-task add "<what you are working on>"');
    return;
  }
  console.log('  Tasks (newest first)');
  console.log('  ─────────────────────────────────────────────────────────────');
  for (const t of list) {
    const spent = taskSpend(t, t.tokensAtEnd || t.tokensAtStart);
    const mark = t.status === 'active' ? '▶' : '✓';
    const cost = fmtCost(spent, model);
    const files = t.packedFiles?.length ? ` · ${t.packedFiles.length} files` : '';
    console.log(`  ${mark} #${t.id} ${t.name}`);
    console.log(`      ~${formatTokens(spent)} tokens · $${cost}${files}`);
  }
}

function main() {
  const action = process.argv[2] || 'list';
  const rest = process.argv.slice(3).join(' ').trim();
  const project = process.env.CCO_PROJECT || process.cwd();
  const sessionId = getLatestSessionId();
  const model = (loadConfig().model) || 'opus-5';
  const tokensNow = getSessionTokenTotal(sessionId);
  const stamp = new Date().toISOString();
  let state = loadTasks();

  if (action === 'add') {
    if (!rest) { console.error('Usage: cco-task add "<name>"'); process.exit(1); }
    const r = addTask(state, { name: rest, project, sessionId, tokensNow, stamp });
    saveTasks(r.state);
    console.log(`▶ Started task #${r.task.id}: ${r.task.name}`);
    console.log('  Pack the minimal context for it:  /cco-pack "' + r.task.name + '"');
    return;
  }
  if (action === 'patch') {
    let patch;
    try { patch = JSON.parse(rest); } catch { console.error('Usage: cco-task patch \'{"key": value, "gone": null}\'  (valid JSON object)'); process.exit(1); }
    const r = patchActiveTask(state, { project, patch, stamp });
    if (r.error) { console.error(`[cco-task] ${r.error}`); process.exit(1); }
    saveTasks(r.state);
    const size = JSON.stringify(r.task.state).length;
    console.log(`✓ State of task #${r.task.id} updated (${Object.keys(r.task.state).length} keys, ${size}/${TASK_STATE_MAX_CHARS} chars)`);
    return;
  }
  if (action === 'state') {
    const active = getActiveTask(state, { project });
    if (!active) { console.log('No active task.'); return; }
    console.log(`#${active.id} ${active.name}`);
    console.log(JSON.stringify(active.state || {}, null, 2));
    return;
  }
  if (action === 'rehydrate') {
    // SessionStart hook: stdin carries { source, cwd, ... }. Print the bounded
    // state block to stdout (it enters Claude's context) only after a compact
    // or a resume — a fresh session should not inherit an old task by surprise.
    let event = {};
    try { event = JSON.parse(readFileSync(0, 'utf-8') || '{}'); } catch { /* no stdin */ }
    if (!shouldRehydrate(event.source)) return;
    const block = renderRehydration(getActiveTask(state, { project: event.cwd || project }));
    if (block) console.log(block);
    return;
  }
  if (action === 'done') {
    const r = completeActiveTask(state, { project, tokensNow, note: rest, stamp });
    if (!r.task) { console.log('No active task to complete.'); return; }
    saveTasks(r.state);
    const spent = taskSpend(r.task, tokensNow);
    console.log(`✓ Completed task #${r.task.id}: ${r.task.name}  (~${formatTokens(spent)} tokens, $${fmtCost(spent, model)})`);
    return;
  }
  // default: list
  printTasks(state, project, model);
}

if (isMainModule(import.meta.url)) {
  try { main(); } catch (e) { console.error(`[cco-task] ${e.message}`); process.exit(0); }
}
