---
name: cco-clean
description: Clean up old tracking data and reset statistics
license: MIT
argument-hint: "[--prune] [--sessions-older-than <days>] [--reset-all]"
allowed-tools: [Bash]
---

# Clean Context Optimizer Data

The user wants to clean up tracking data. Parse $ARGUMENTS:

- If `--reset-all`: Delete all data in `~/.claude-context-optimizer/` and confirm
- If `--sessions-older-than N`: Delete session files older than N days
- If `--prune` (or the user just wants the safe cleanup): apply the retention policy now — per-session files older than 90 days (sessions, summaries, prompts) and live-session state older than 14 days (budget, read-cache, notices). Aggregated stats and learned patterns are kept. This also runs automatically once a day at session start.
  ```bash
  node --input-type=module -e "const m = await import('${CLAUDE_PLUGIN_ROOT}/src/utils.js'); console.log('removed', m.pruneOldData({ force: true }), 'files')"
  ```
- If no arguments: Show current data size and ask what to clean (suggest `--prune` first — it is non-destructive to stats)

Run to check data size:
```bash
du -sh ~/.claude-context-optimizer/ 2>/dev/null && find ~/.claude-context-optimizer/sessions/ -name "*.json" 2>/dev/null | wc -l
```

For cleanup, delete the appropriate files and confirm what was removed.
