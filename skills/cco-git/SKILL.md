---
name: cco-git
description: Show git-aware context suggestions for current working directory
license: MIT
allowed-tools:
  - "Bash(node ${CLAUDE_PLUGIN_ROOT}/src/git-context.js:*)"
  - Read
  - Glob
---

# Git-Aware Context Suggestions

> **Needs Claude Code** (or Cowork on your computer): this runs the plugin's local scripts. If `node` or `${CLAUDE_PLUGIN_ROOT}` isn't available, as in claude.ai chat, don't try to run anything. Say so in one line and offer the `fresh-start` or `token-check` skill instead.

Analyze the current git state and suggest which files Claude should read for the current task.

Run:
```bash
node ${CLAUDE_PLUGIN_ROOT}/src/git-context.js
```

Present the results:
1. **Current branch** and modified files
2. **Suggested files** based on git diff (modified + related test files + configs)
3. **Historical patterns** — files that were frequently useful in this project
4. Ask the user if they want to load any of the suggested files

Do NOT auto-read files. Only suggest and let the user decide.
