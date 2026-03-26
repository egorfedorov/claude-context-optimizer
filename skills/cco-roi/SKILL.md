---
name: cco-roi
description: Calculate monthly token savings and ROI by model
license: MIT
argument-hint: "[sessions-per-day] (default: 5)"
allowed-tools: [Bash]
---

# ROI Calculator

Calculate and display the return on investment from using Context Optimizer.

Parse $ARGUMENTS for sessions per day (default: 5).

Run:
```bash
node ${CLAUDE_PLUGIN_ROOT}/src/roi.js $ARGUMENTS
```

Present the ROI report to the user. Highlight:
1. The effective context multiplier — how much more efficient their budget is
2. Monthly and yearly dollar savings for their current model
3. Team-level savings if they work in a team
4. If data comes from real sessions, note how many sessions were analyzed

If the user has no session data yet, explain that the estimate uses industry averages (35% waste) and will become more accurate as they use CCO.
