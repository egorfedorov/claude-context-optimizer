---
name: cco-doctor
description: Health check for the context-optimizer plugin install — verifies versions, hooks, data dir, model config, and reports any issues
license: MIT
allowed-tools: [Bash, Read]
---

# CCO Doctor

When the user runs `/cco-doctor` or reports the plugin "isn't working", run a quick health check.

## How to use

Standard run (fast — under 1s):
```bash
node ${CLAUDE_PLUGIN_ROOT}/src/doctor.js
```

With test suite (slower — runs all unit tests):
```bash
node ${CLAUDE_PLUGIN_ROOT}/src/doctor.js --tests
```

## What it checks

- Plugin manifest and `package.json` exist
- Versions are in sync (`plugin.json` and `package.json`)
- `hooks.json` is valid JSON with all expected event types
- All hook scripts present in `src/`
- Data directory `~/.claude-context-optimizer/` is writable
- `patterns.json` size is reasonable
- Global stats file is parseable
- User config has sane model + budget for the chosen model
- Node version meets the >=18 requirement

## Presentation

Translate the doctor output into plain language. If anything is `fail`, walk the user through the fix:
- versions out of sync → `npm run sync-version`
- patterns.json too big → `/cco-clean`
- budget > model window → `/cco-budget set <smaller>` or pick a 1M-context model
- node too old → upgrade Node

If everything is `pass`, confirm "плагин в порядке, текущая версия Х.Y.Z" and stop.
