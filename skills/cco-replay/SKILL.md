---
name: cco-replay
description: Show recent session summaries for quick context recovery
license: MIT
disable-model-invocation: true
argument-hint: "[N] (number of sessions to show, default 5)"
allowed-tools:
  - "Bash(node ${CLAUDE_PLUGIN_ROOT}/src/replay.js:*)"
---

# Session Replay

> **Needs Claude Code** (or Cowork on your computer): this runs the plugin's local scripts. If `node` or `${CLAUDE_PLUGIN_ROOT}` isn't available, as in claude.ai chat, don't try to run anything. Say so in one line and offer the `fresh-start` or `token-check` skill instead.

Show the user summaries of their recent sessions so they can quickly recover context.

Parse $ARGUMENTS for the number of sessions to show (default: 5).

Run:
```bash
node ${CLAUDE_PLUGIN_ROOT}/src/replay.js $ARGUMENTS
```

Present the output to the user. It shows recent session summaries including:
1. When the session happened and how long it lasted
2. Which files were edited
3. Token usage and waste percentage

If no summaries exist yet, tell the user:
"No session summaries yet. They're generated automatically at the end of each session — just keep working!"
