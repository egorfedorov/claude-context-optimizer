---
description: Show context usage heatmap for current session
allowed-tools: [Bash, Read]
---

# Context Heatmap

Show the user a visual heatmap of their context usage in the current session.

Run the following command to get the current session's tracking data (uses the most recent session automatically):

```bash
node /Users/egorfedorov/claude-context-optimizer/src/tracker.js heatmap
```

If no data is available yet (empty session), tell the user:
"No context data tracked yet in this session. Keep working and the optimizer will track file reads, edits, and searches automatically."

Present the heatmap output to the user and highlight:
1. Files marked with a warning icon that were read but never used — suggest avoiding them next time
2. Files marked with an edit icon that were actually edited — these are high-value context
3. The total estimated token usage and waste percentage

If waste is over 30%, suggest specific ways to reduce it based on the files shown.
