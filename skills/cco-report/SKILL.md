---
name: cco-report
description: Show detailed token ROI report across all tracked sessions
license: MIT
disable-model-invocation: true
allowed-tools:
  - "Bash(node ${CLAUDE_PLUGIN_ROOT}/src/report.js:*)"
  - "Bash(node ${CLAUDE_PLUGIN_ROOT}/src/tracker.js:*)"
  - Read
---

# Context Token ROI Report

> **Needs Claude Code** (or Cowork on your computer): this runs the plugin's local scripts. If `node` or `${CLAUDE_PLUGIN_ROOT}` isn't available, as in claude.ai chat, don't try to run anything. Say so in one line and offer the `fresh-start` or `token-check` skill instead.

Generate and display a comprehensive token usage report across all tracked sessions.

Run:
```bash
node ${CLAUDE_PLUGIN_ROOT}/src/report.js full
```

Present the full report to the user. After showing it, provide actionable insights:

1. If the waste trend is WORSENING, warn the user and suggest specific changes
2. If there are top wasted files, suggest the user avoid reading those files in future sessions or use more targeted reads (offset/limit)
3. If average tokens per session is high, suggest task splitting strategies
4. Calculate the estimated monthly cost savings if the user maintains current improvement trends

Also run:
```bash
node ${CLAUDE_PLUGIN_ROOT}/src/tracker.js suggest
```

And present the smart suggestions (files to preload, files to avoid) for the current project directory.
