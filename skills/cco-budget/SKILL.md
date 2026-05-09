---
name: cco-budget
description: Configure token budget limits, auto-compact settings, and view current budget status (model-aware — supports Opus 4.7 1M context tier)
license: MIT
argument-hint: "[status | set <tokens> | model <haiku|haiku-4.5|sonnet|sonnet-4.6|opus|opus-4.7|opus-4.7-1m> | auto <on|off>]"
allowed-tools: [Bash, Read, Write]
---

# Context Budget Manager

Manage the token budget for Claude Code sessions. Now model-aware — picks the
right effective context window for Opus 4.7 (200K) vs Opus 4.7 1M (1M).

Parse $ARGUMENTS:

## `status` (or no arguments)
Show current budget config + auto-compact settings:
```bash
cat ~/.claude-context-optimizer/config.json 2>/dev/null
echo "---"
cat ~/.claude-context-optimizer/budget-config.json 2>/dev/null
```
If no config exists, show defaults (200K tokens for Opus 4.7, warn at 50/70/85/95%).

## `set <tokens>`
Update the budget limit. Parse the token count (`200K`, `1M`, `500000` all OK).
Update `~/.claude-context-optimizer/config.json`:
```json
{
  "budgetTokens": <parsed_number>,
  "warnAt": [50, 70, 85, 95],
  "autoCompactAt": 90,
  "model": "opus-4.7"
}
```
If `budgetTokens` exceeds the chosen model's context window, warn the user.

## `model <name>`
Set the model for cost estimation. Supported keys:
- `haiku-4.5` (alias `haiku`) — $1/$5 per M, 200K
- `sonnet-4.6` (alias `sonnet`) — $3/$15 per M, 200K
- `opus-4.7` (alias `opus`) — $15/$75 per M, 200K
- `opus-4.7-1m` — $22.50/$112.50 per M, **1M** context window

Update the `model` field in config.json. If switching to `opus-4.7-1m` and the
current `budgetTokens` is below 500K, ask if the user wants to bump it to 1M.

## `auto <on|off>`
Toggle auto-compact at thresholds (80% / 90%). Update
`~/.claude-context-optimizer/budget-config.json`:
- `auto on` → `autoCompactEnabled: true`
- `auto off` → `autoCompactEnabled: false`

Defaults if file missing:
```json
{
  "autoCompactEnabled": true,
  "autoCompactThreshold": 80,
  "criticalThreshold": 90
}
```

## Cost calculation

The budget monitor now estimates **input + output** tokens separately and uses
the model's real input/output prices. Example: `Edit` with a 200-char `new_string`
counts as ~54 output tokens, charged at the model's output rate.

## Effective Budget Multiplier

At 50%+ budget usage, the monitor shows how much CCO multiplies your effective
budget — e.g. "1.6x more effective" if Read Cache + file digests saved enough
redundant reads to make your 200K context behave like ~320K.
