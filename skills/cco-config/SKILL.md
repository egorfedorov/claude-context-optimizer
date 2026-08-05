---
name: cco-config
description: View and tune CCO's behavior thresholds — re-read warnings, cache staleness, prompt-coach length bands, and the /cco-pack budget cap
license: MIT
argument-hint: "[show | get <key> | set <key> <value> | reset [key]]"
allowed-tools: [Bash]
---

# CCO Config — tune how aggressive the optimizer is

CCO's behavior knobs used to be magic numbers spread across four modules.
This surfaces them, range-validated, in `~/.claude-context-optimizer/config.json`
under `thresholds`.

The plugin root is the directory containing `src/config.js`. Run everything
from there.

Parse $ARGUMENTS:

## `show` (or no arguments)

```bash
node src/config.js
```

Print the table as-is. `*` marks values the user set; `!` marks a stored value
that failed validation and is being ignored in favour of the default. If any
`!` rows appear, point them out — a typo there means a knob silently isn't
doing what the user thinks.

## `get <key>`

```bash
node src/config.js get <key>
```

## `set <key> <value>`

```bash
node src/config.js set <key> <value>
```

Exits non-zero with the valid range on a bad value or unknown key — relay that
message rather than guessing a correction. After a successful set, say which
behavior it changes (see the table below), because the effect is not obvious
from the key name alone.

## `reset [key]`

```bash
node src/config.js reset <key>    # one key
node src/config.js reset          # everything back to defaults
```

Resetting everything discards all the user's tuning — confirm first unless they
were explicit ("reset all", "вернуть всё по умолчанию").

## The keys

| Key | Default | What it changes |
|---|---|---|
| `rereadWarnAt` | 3 | reads of an unedited file before the first re-read warning |
| `rereadEscalateAt` | 5 | reads before the "put it in CLAUDE.md" escalation |
| `bigFileLines` | 500 | full-read line count that triggers the offset/limit warning |
| `mediumFileLines` | 200 | full-read line count that triggers the soft hint |
| `staleTokenRatio` | 0.10 | share of budget loaded after a file before Read Cache re-allows it |
| `staleFiles` | 8 | other files loaded after a file before it counts as evicted (at 200K) |
| `staleTimeMs` | 600000 | ms since last read before a cached file counts as stale |
| `promptMinWords` | 8 | word count below which the coach calls a prompt too vague |
| `promptIdealMaxWords` | 200 | upper bound of the coach's "ideal length" band |
| `promptTooLongWords` | 500 | word count above which the ask is considered buried |
| `packBudgetPercent` | 25 | max share of the budget `/cco-pack` may consume |

## Tuning guidance

- **Too many re-read warnings?** Raise `rereadWarnAt` to 4–5.
- **Read Cache blocking files you still need?** Lower `staleTimeMs` (e.g.
  `300000` = 5 min) or `staleTokenRatio` so cached entries go stale sooner.
- **Read Cache not saving much?** Raise them — entries stay fresh longer and
  more repeat reads get blocked.
- **Working on a 1M-context model with long prompts?** Raise
  `promptTooLongWords`; the default band is tuned for shorter asks.
- `CCO_STALE_TIME_MS` in the environment still overrides `staleTimeMs`, for a
  one-off experiment without changing config.
