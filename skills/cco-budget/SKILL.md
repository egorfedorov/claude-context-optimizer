---
name: cco-budget
description: Configure token budget limits, auto-compact settings, and view current budget status
license: MIT
argument-hint: "[status | set <tokens> | model <haiku|sonnet|opus> | auto <on|off>]"
allowed-tools: [Bash, Read, Write]
---

# Context Budget Manager

Manage the token budget for Claude Code sessions.

Parse $ARGUMENTS:

## `status` (or no arguments)
Show current budget configuration, usage, and auto-compact settings:
```bash
cat ~/.claude-context-optimizer/config.json 2>/dev/null
echo "---"
cat ~/.claude-context-optimizer/budget-config.json 2>/dev/null
```
If no config exists, show defaults (100K tokens, warn at 50/70/85/95%).
Show auto-compact status: enabled/disabled, thresholds (default: auto-compact at 80%, critical at 90%).

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

## `auto <on|off>`
Toggle auto-compact behavior. When enabled, the budget monitor will output strong
directive messages at configurable thresholds to prompt Claude to run /compact.

Update `~/.claude-context-optimizer/budget-config.json`:
- `auto on` — set `autoCompactEnabled` to `true`
- `auto off` — set `autoCompactEnabled` to `false`

Read the existing budget-config.json first, then update only the `autoCompactEnabled` field.
If the file doesn't exist, create it with defaults:
```json
{
  "autoCompactEnabled": true,
  "autoCompactThreshold": 80,
  "criticalThreshold": 90
}
```

After toggling, confirm the new setting to the user. Explain:
- **When enabled (default):** At 80% budget usage, a strong recommendation to run /compact is emitted.
  At 90%, a critical warning is emitted. These repeat every 10K/5K tokens respectively.
- **When disabled:** Only the standard threshold warnings (50/70/85/95%) are shown,
  with legacy compact suggestions at 90%+.

Explain that budget warnings will appear automatically during the session as hook feedback when thresholds are crossed.
