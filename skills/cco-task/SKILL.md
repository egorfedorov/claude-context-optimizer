---
name: cco-task
description: Organize work by task, track tokens/cost per task, and keep a small patchable execution state that is re-injected after /compact (SKILL.state-style) — start a task, patch its state, list tasks, or mark the active one done. Pairs with /cco-pack to load minimal context per task.
license: MIT
argument-hint: "[add \"<name>\" | patch '<json>' | state | list | done [note]]"
allowed-tools: [Bash]
---

# Tasks — per-task context, cost, and execution state

A task is a named unit of work. While a task is active, the tokens the session
spends are attributed to it, so the Control Center (`/cco`) can show cost **per
task**, not just per session.

Each task also carries a small JSON **execution state** — goal, what is done,
what is open, the next action. You update it with *patches* instead of
re-deriving progress from the transcript, it is capped at ~1K tokens so it never
grows with the number of steps, and it is re-injected verbatim right after
`/compact` (and on `--resume`). That is the SKILL.state idea (Google / Purdue,
2026) applied where a plugin can apply it: the compaction summary is lossy and
free-form; the state is exact and bounded.

## Commands

Parse the user's argument and run the matching command (working directory scopes
the tasks to the current project):

**Start / switch task** (also closes the previous active task):
```bash
node ${CLAUDE_PLUGIN_ROOT}/src/tasks.js add "<task name>"
```
After starting, suggest packing the minimal context for it:
`/cco-pack "<task name>"`, and seed the state with the goal and the plan:
`/cco-task patch '{"goal": "...", "plan": ["...", "..."], "next": "..."}'`.

**Patch the execution state** (set keys; `null` deletes a key):
```bash
node ${CLAUDE_PLUGIN_ROOT}/src/tasks.js patch '{"done": ["read auth.ts"], "next": "write the failing test", "scratch": null}'
```
The patch must be a JSON object. If the state would exceed the cap the patch is
rejected — prune finished keys with `null` first.

**Show the current state**:
```bash
node ${CLAUDE_PLUGIN_ROOT}/src/tasks.js state
```

**List tasks** (newest first, with per-task tokens + $):
```bash
node ${CLAUDE_PLUGIN_ROOT}/src/tasks.js list
```

**Complete the active task**:
```bash
node ${CLAUDE_PLUGIN_ROOT}/src/tasks.js done
```

## State discipline (what makes it worth keeping)

- Keep it a *state*, not a log: `done`, `open`, `next`, `decisions`, `files` —
  facts needed to continue, not the history of how you got there. Reasoning is
  ephemeral; the state is what survives.
- Patch after each milestone (a test passing, a decision made, a file finished),
  and delete keys the moment they stop mattering.
- After `/compact` the SessionStart hook prints the active task's state into the
  new context automatically — treat it as authoritative over the summary.
- When delegating to a subagent, pass the state (not the conversation) as the
  brief; it is already the minimal, current description of the task.

## Flow to recommend

1. `/cco-task add "implement X"` — start the task
2. `/cco-pack "implement X"` — load only the files that task needs
3. `/cco-task patch '{"goal": "...", "next": "..."}'` — seed the state; patch as you go
4. `/cco` — see budget, savings, and this task's cost
5. `/cco-task done` — freeze the task's token/$ total

Only one task is active per project at a time; starting a new one finalizes the
previous task's cost automatically.
