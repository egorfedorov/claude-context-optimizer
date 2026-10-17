---
name: cco-export
description: Export context report as Markdown or HTML
license: MIT
disable-model-invocation: true
argument-hint: "[md|html] (default: md)"
allowed-tools:
  - "Bash(node ${CLAUDE_PLUGIN_ROOT}/src/export.js:*)"
---

# Export Context Report

> **Needs Claude Code** (or Cowork on your computer): this runs the plugin's local scripts. If `node` or `${CLAUDE_PLUGIN_ROOT}` isn't available, as in claude.ai chat, don't try to run anything. Say so in one line and offer the `fresh-start` or `token-check` skill instead.

Export the context optimizer report in the specified format.

Parse $ARGUMENTS for the format (default: md).

Run:
```bash
node ${CLAUDE_PLUGIN_ROOT}/src/export.js $ARGUMENTS
```

Show the user the path to the exported file. If HTML, mention they can open it in a browser for a visual dashboard with charts and color-coded metrics.
