---
description: Show git-aware context suggestions for current working directory
allowed-tools: [Bash, Read, Glob]
---

# Git-Aware Context Suggestions

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
