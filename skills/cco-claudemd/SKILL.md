---
name: cco-claudemd
description: Analyze CLAUDE.md files for token bloat and suggest optimizations
license: MIT
disable-model-invocation: true
allowed-tools:
  - "Bash(node ${CLAUDE_PLUGIN_ROOT}/src/claudemd-analyzer.js:*)"
  - Read
---

# CLAUDE.md Analyzer

> **Needs Claude Code** (or Cowork on your computer): this runs the plugin's local scripts. If `node` or `${CLAUDE_PLUGIN_ROOT}` isn't available, as in claude.ai chat, don't try to run anything. Say so in one line and offer the `fresh-start` or `token-check` skill instead.

Analyze CLAUDE.md files in the current project for token bloat and optimization opportunities.

Run the analyzer:

```bash
node ${CLAUDE_PLUGIN_ROOT}/src/claudemd-analyzer.js "${CWD}"
```

Present the output to the user. The analyzer checks for:
- **Overall size** — files over 2K tokens get flagged
- **Large sections** — sections over 1K tokens
- **Duplicate lines** — repeated content
- **Verbose patterns** — "please make sure to", "it is important that", etc.
- **Long code blocks** — examples over 20 lines
- **Excessive whitespace** — empty lines eating tokens

For each issue found, explain the savings potential and suggest a concrete fix.

If the user wants to apply fixes, help them edit the CLAUDE.md directly using the Edit tool.
