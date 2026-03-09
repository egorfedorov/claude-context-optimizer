---
description: Clean up old tracking data and reset statistics
argument-hint: [--sessions-older-than <days>] [--reset-all]
allowed-tools: [Bash]
---

# Clean Context Optimizer Data

The user wants to clean up tracking data. Parse $ARGUMENTS:

- If `--reset-all`: Delete all data in `~/.claude-context-optimizer/` and confirm
- If `--sessions-older-than N`: Delete session files older than N days
- If no arguments: Show current data size and ask what to clean

Run to check data size:
```bash
du -sh ~/.claude-context-optimizer/ 2>/dev/null && find ~/.claude-context-optimizer/sessions/ -name "*.json" 2>/dev/null | wc -l
```

For cleanup, delete the appropriate files and confirm what was removed.
