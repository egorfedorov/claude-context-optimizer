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
 * The core logic is pure (no I/O) so it is unit-testable; loadTasks/saveTasks
 * wrap it with disk access.
 */

import {
  TASKS_FILE, loadJSON, saveJSON, ensureDataDirs, isMainModule,
  formatTokens, getModelCost, loadConfig, getLatestSessionId, getSessionTokenTotal
} from './utils.js';

const STATE_VERSION = 1;

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
  const model = (loadConfig().model) || 'opus-4.8';
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
