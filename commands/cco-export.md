---
description: Export context report as Markdown or HTML
argument-hint: [md|html] (default: md)
allowed-tools: [Bash]
---

# Export Context Report

Export the context optimizer report in the specified format.

Parse $ARGUMENTS for the format (default: md).

Run:
```bash
node /Users/egorfedorov/claude-context-optimizer/src/export.js $ARGUMENTS
```

Show the user the path to the exported file. If HTML, mention they can open it in a browser for a visual dashboard with charts and color-coded metrics.
