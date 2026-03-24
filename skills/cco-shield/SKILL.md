---
name: cco-shield
description: Show ContextShield status and waste protection stats
license: MIT
allowed-tools: [Bash, Read]
---

# ContextShield Status

Show the user the current ContextShield protection status and historical waste prevention stats.

Run the following command to get pattern data:

```bash
node ${CLAUDE_PLUGIN_ROOT}/src/tracker.js patterns
```

From the patterns data, present:

1. **ContextShield Status**: Active (it's always active as a PreToolUse hook)
2. **Protected Files**: List files with 3+ waste sessions — these trigger warnings before Read
3. **Tokens Saved**: Estimate based on waste history (files that would have been read without shield)
4. **Co-occurrence Groups**: Files that are usually edited together

Format as a clean status report. If no pattern data exists yet, tell the user:
"ContextShield is warming up! It learns from your usage patterns and will start giving you smart suggestions after a few sessions."

End the report with:
```
ContextShield runs automatically on every Read. No configuration needed.
```
