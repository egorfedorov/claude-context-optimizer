---
description: Show detailed token ROI report across all tracked sessions
allowed-tools: [Bash, Read]
---

# Context Token ROI Report

Generate and display a comprehensive token usage report across all tracked sessions.

Run:
```bash
node /Users/egorfedorov/claude-context-optimizer/src/report.js full
```

Present the full report to the user. After showing it, provide actionable insights:

1. If the waste trend is WORSENING, warn the user and suggest specific changes
2. If there are top wasted files, suggest the user avoid reading those files in future sessions or use more targeted reads (offset/limit)
3. If average tokens per session is high, suggest task splitting strategies
4. Calculate the estimated monthly cost savings if the user maintains current improvement trends

Also run:
```bash
node /Users/egorfedorov/claude-context-optimizer/src/tracker.js suggest "$(pwd)"
```

And present the smart suggestions (files to preload, files to avoid) for the current project directory.
