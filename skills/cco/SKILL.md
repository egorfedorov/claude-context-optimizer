---
name: cco
description: "In Claude Code: what this session costs and where the tokens go, plus the tools to cut it — /cco for the board, /cco audit, /cco task, /cco pack and more. Use when the user asks about session cost, context size, savings, or wants a task tracked across /compact."
argument-hint: "[command] [args]  (empty for the board, 'help' for all)"
license: MIT
allowed-tools:
  - "Bash(node ${CLAUDE_PLUGIN_ROOT}/src/dashboard.js:*)"
  - "Bash(node ${CLAUDE_PLUGIN_ROOT}/src/tracker.js:*)"
  - "Bash(node ${CLAUDE_PLUGIN_ROOT}/src/audit.js:*)"
  - "Bash(node ${CLAUDE_PLUGIN_ROOT}/src/wrapped.js:*)"
  - "Bash(node ${CLAUDE_PLUGIN_ROOT}/src/tasks.js:*)"
  - "Bash(node ${CLAUDE_PLUGIN_ROOT}/src/smart-pack.js:*)"
  - "Bash(node ${CLAUDE_PLUGIN_ROOT}/src/anatomy.js:*)"
  - "Bash(node ${CLAUDE_PLUGIN_ROOT}/src/git-context.js:*)"
  - "Bash(node ${CLAUDE_PLUGIN_ROOT}/src/claudemd-analyzer.js:*)"
  - "Bash(node ${CLAUDE_PLUGIN_ROOT}/src/prompt-coach.js:*)"
  - "Bash(node ${CLAUDE_PLUGIN_ROOT}/src/context-shield.js:*)"
  - "Bash(node ${CLAUDE_PLUGIN_ROOT}/src/report.js:*)"
  - "Bash(node ${CLAUDE_PLUGIN_ROOT}/src/roi.js:*)"
  - "Bash(node ${CLAUDE_PLUGIN_ROOT}/src/digest.js:*)"
  - "Bash(node ${CLAUDE_PLUGIN_ROOT}/src/replay.js:*)"
  - "Bash(node ${CLAUDE_PLUGIN_ROOT}/src/tool-costs.js:*)"
  - "Bash(node ${CLAUDE_PLUGIN_ROOT}/src/overhead.js:*)"
  - "Bash(node ${CLAUDE_PLUGIN_ROOT}/src/config.js:*)"
  - "Bash(node ${CLAUDE_PLUGIN_ROOT}/src/export.js:*)"
  - "Bash(node ${CLAUDE_PLUGIN_ROOT}/src/patterns-share.js:*)"
  - "Bash(node ${CLAUDE_PLUGIN_ROOT}/src/doctor.js:*)"
  - Read
  - Glob
---

# Context Optimizer

> **Needs Claude Code** (or Cowork on your computer): this runs the plugin's local scripts. If `node` or `${CLAUDE_PLUGIN_ROOT}` isn't available, as in claude.ai chat, don't try to run anything. Say so in one line and offer the `fresh-start` or `token-check` skill instead.

Arguments: `$ARGUMENTS`. The first word is the command; the rest are its
`<args>`. No command means `board`. `help`, or a command not in the table,
means: print the table below as a short menu and stop.

For a command, read its instructions in
`${CLAUDE_PLUGIN_ROOT}/skills/cco/commands/<command>.md` and follow them.
Those files write the plugin's path as `${CLAUDE_PLUGIN_ROOT}`: use
`${CLAUDE_PLUGIN_ROOT}` in its place, and the user's `<args>` where they say
`<args>`. When the user typed only a command that just runs its script, run
the script from the table directly and skip reading the file.

## See where the tokens go

| Command | What it shows | Script |
|---|---|---|
| *(none)* / `board` | This session: budget, $ spent, saved, waste, active task, next actions | `node ${CLAUDE_PLUGIN_ROOT}/src/dashboard.js board` |
| `audit` | Your real transcripts: where the money went and what CCO saved | `node ${CLAUDE_PLUGIN_ROOT}/src/audit.js <args>` |
| `wrapped` | A recap of your last week: spend, busiest day, priciest projects, one tip | `node ${CLAUDE_PLUGIN_ROOT}/src/wrapped.js <args>` |
| `report` | Token ROI across all tracked sessions | `node ${CLAUDE_PLUGIN_ROOT}/src/report.js full` |
| `roi` | Monthly savings by model | `node ${CLAUDE_PLUGIN_ROOT}/src/roi.js` |
| `digest` | Efficiency score and trend for the last N days | `node ${CLAUDE_PLUGIN_ROOT}/src/digest.js <args>` |
| `replay` | Recent session summaries | `node ${CLAUDE_PLUGIN_ROOT}/src/replay.js <args>` |
| `tools` | What each tool really costs in tokens | `node ${CLAUDE_PLUGIN_ROOT}/src/tool-costs.js` |
| `overhead` | The fixed context every session starts with | `node ${CLAUDE_PLUGIN_ROOT}/src/overhead.js` |

## Spend less

| Command | What it does |
|---|---|
| `orchestrate <task>` | Do a task with Haiku subagents doing the reading and test runs |
| `task` | Track a task's cost and keep its state across `/compact` |
| `pack <task>` | The files a task needs, with line ranges, before reading anything |
| `anatomy` | A compact map of the project |
| `git` | Context suggestions from the git working tree |
| `claudemd` | Find bloat in CLAUDE.md |
| `coach` | Grade the last prompt and sharpen it |
| `shield` | `.contextignore` rules from what was never used |
| `templates` | Saved context sets for recurring tasks |

## Settings and data

| Command | What it does |
|---|---|
| `config` | Tune thresholds (re-read warnings, cache staleness, coach) |
| `budget` | Context budget and auto-compact settings |
| `export` | Save a report as Markdown or an offline HTML page |
| `patterns` | Share learned file patterns with a team |
| `clean` | Prune or reset tracked data |
| `doctor` | Check the install end to end |
