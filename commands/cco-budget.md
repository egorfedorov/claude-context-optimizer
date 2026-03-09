---
description: Configure token budget limits and view current budget status
argument-hint: [status | set <tokens> | model <haiku|sonnet|opus>]
allowed-tools: [Bash, Read, Write]
---

# Context Budget Manager

Manage the token budget for Claude Code sessions.

Parse $ARGUMENTS:

## `status` (or no arguments)
Show current budget configuration and usage:
```bash
cat ~/.claude-context-optimizer/config.json 2>/dev/null
```
If no config exists, show defaults (100K tokens, warn at 50/70/85/95%).

## `set <tokens>`
Update the budget limit. Parse the token count from arguments.
Create or update `~/.claude-context-optimizer/config.json`:
```json
{
  "budgetTokens": <parsed_number>,
  "warnAt": [50, 70, 85, 95],
  "autoCompactAt": 90,
  "model": "opus"
}
```

## `model <name>`
Set the model for cost estimation (haiku, sonnet, opus).
Update the `model` field in config.json.

Explain that budget warnings will appear automatically during the session as hook feedback when thresholds are crossed.
