---
name: cco-anatomy
description: Generate a compact project map so Claude understands the codebase without opening every file
license: MIT
allowed-tools: [Bash, Read]
---

# Project Anatomy Generator

Generate a compact project map showing every file with its size, token estimate, and category.
This lets Claude understand the codebase structure by reading one file instead of twenty.

Run the anatomy generator for the current working directory:

```bash
node ${CLAUDE_PLUGIN_ROOT}/src/anatomy.js "${CWD}"
```

Present the output to the user. Highlight:
1. **Total token cost** if all files were read
2. **Heaviest files** that should use offset/limit
3. **Category breakdown** — where most tokens live (source, config, tests, docs)

Suggest saving the output to `PROJECT_ANATOMY.md` in the project root if the user wants to use it as persistent context.
