---
name: cco-claudemd
description: Analyze CLAUDE.md files for token bloat and suggest optimizations
license: MIT
allowed-tools: [Bash, Read]
---

# CLAUDE.md Analyzer

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
