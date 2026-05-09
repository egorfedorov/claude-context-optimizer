---
name: cco-pack
description: Build an optimal context pack for the user's task — ranked file list with offset/limit suggestions, based on git state, mentioned paths, and historical patterns
license: MIT
allowed-tools: [Bash, Read]
---

# Smart Context Pack

When the user runs `/cco-pack` or asks "what files do I need for X", build a curated, token-budget-aware list of files to load instead of guessing or reading the whole repo.

## How to use

```bash
node ${CLAUDE_PLUGIN_ROOT}/src/smart-pack.js "the task description"
```

Or for the current git state without a description:
```bash
node ${CLAUDE_PLUGIN_ROOT}/src/smart-pack.js
```

Or to feed it back into automation as JSON:
```bash
node ${CLAUDE_PLUGIN_ROOT}/src/smart-pack.js --json "..."
```

## How it ranks files

Priority order:
1. **Mentioned in prompt** — explicit file paths or recognisable names → relevance 100
2. **Modified in git working tree** → 85
3. **Historically useful** in this project (high confidence, edited often) → up to 70
4. **Keyword match** against the task → up to 70

For each file the pack also suggests `offset` / `limit` — pointing at the structurally relevant section based on file landmarks (function/class declarations near task keywords).

## Token budget awareness

Pack stops adding files once it would exceed 25% of the user's effective context budget. The budget itself respects the configured model (e.g. 1M for `opus-4.7-1m`).

## Presentation

After running, present the list to the user and offer to:
- Read the top N files with the suggested offset/limit
- Save the set as a template (`/cco-templates create <name>`)
- Drop low-relevance items if they want a tighter pack
