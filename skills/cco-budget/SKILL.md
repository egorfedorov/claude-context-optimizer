---
name: cco-budget
description: Configure token budget limits, auto-compact settings, and view current budget status (model-aware — Claude 5 lineup, Opus 5 default fallback, full 1M context at standard price)
license: MIT
argument-hint: "[status | set <tokens> | model <haiku-4.5|sonnet-4.6|sonnet-5|opus-4.7|opus-4.8|opus-5|fable-5|fable-5.1> | auto <on|off>]"
allowed-tools: [Bash, Read, Write]
---

# Context Budget Manager

Manage the token budget for Claude Code sessions. Model-aware — picks the right
effective context window and prices per model. The session's REAL model is read
from the transcript by the budget hook; `config.model` is only the fallback.
Everything from Sonnet 4.6 up is 1M; Haiku 4.5 is 200K.

Parse $ARGUMENTS:

## `status` (or no arguments)
Show current budget config + auto-compact settings:
```bash
cat ~/.claude-context-optimizer/config.json 2>/dev/null
echo "---"
cat ~/.claude-context-optimizer/budget-config.json 2>/dev/null
```
If no config exists, show defaults (200K working budget on a 1M window, `opus-5` fallback model, warn at 50/70/85/95%).

## `set <tokens>`
Update the budget limit. Parse the token count (`200K`, `1M`, `500000` all OK).
Update `~/.claude-context-optimizer/config.json`:
```json
{
  "budgetTokens": <parsed_number>,
  "warnAt": [50, 70, 85, 95],
  "autoCompactAt": 90,
  "model": "opus-5"
}
```
If `budgetTokens` exceeds the chosen model's context window, warn the user.

## `model <name>`
Set the FALLBACK model for cost estimation (used only when a session's transcript
has no model id yet). Supported keys:
- `haiku-4.5` (alias `haiku`) — $1/$5 per M, 200K
- `sonnet-4.6` (alias `sonnet`) — $3/$15 per M, **1M**
- `sonnet-5` — $2/$10 per M, **1M**
- `opus-4.7` / `opus-4.8` — $5/$25 per M, **1M**
- `opus-5` (alias `opus`, **default**) — $5/$25 per M, **1M**
- `fable-5` — $10/$50 per M, **1M**
- `fable-5.1` (alias `fable`) — $10/$50 per M, **1M**, cache reads at 0.025× (vs 0.1× elsewhere)

`opus-4.8-1m` / `opus-4.7-1m` / `opus-extended` are back-compat aliases only — there is
no 1M surcharge; the 1M window is standard at $5/$25.

Update the `model` field in config.json. When switching to a 1M-context model and the
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
