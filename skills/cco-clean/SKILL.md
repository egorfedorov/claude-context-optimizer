---
name: cco-clean
description: Clean up old tracking data and reset statistics
license: MIT
disable-model-invocation: true
argument-hint: "[--prune] [--sessions-older-than <days>] [--reset-all]"
allowed-tools:
  - "Bash(node ${CLAUDE_PLUGIN_ROOT}/src/tracker.js prune)"
  - Glob
---

# Clean Context Optimizer Data

> **Needs Claude Code** (or Cowork on your computer): this runs the plugin's local scripts. If `node` or `${CLAUDE_PLUGIN_ROOT}` isn't available, as in claude.ai chat, don't try to run anything. Say so in one line and offer the `fresh-start` or `token-check` skill instead.

The user wants to clean up tracking data. Parse $ARGUMENTS:

- If `--reset-all`: Delete all data in `~/.claude-context-optimizer/` and confirm
- If `--sessions-older-than N`: Delete session files older than N days
- If `--prune` (or the user just wants the safe cleanup): apply the retention policy now — per-session files older than 90 days (sessions, summaries, prompts) and live-session state older than 14 days (budget, read-cache, notices). Aggregated stats and learned patterns are kept. This also runs automatically once a day at session start.
  ```bash
  node ${CLAUDE_PLUGIN_ROOT}/src/tracker.js prune
  ```
- If no arguments: Show current data size and ask what to clean (suggest `--prune` first — it is non-destructive to stats)

To check data size, Glob `~/.claude-context-optimizer/sessions/*.json` and report
the session count.

`--reset-all` and `--sessions-older-than` delete files: state exactly what will
be removed and let the user approve the command — these are not pre-approved.
