---
name: cco-coach
description: Analyze the user's last prompt for clarity, scope and specificity — give a quality score and concrete suggestions to make the next prompt produce better results
license: MIT
allowed-tools: [Bash, Read]
---

# Prompt Coach

When the user runs `/cco-coach` or asks for "prompt feedback" / "оцени мой промпт", run the analyzer on the user's last natural-language ask (or on text they provide).

## How to use

If the user passes text after the command (e.g. `/cco-coach add login screen`):
```bash
node ${CLAUDE_PLUGIN_ROOT}/src/prompt-coach.js analyze "the prompt text here"
```

If no text given, show recent prompt history and average score:
```bash
node ${CLAUDE_PLUGIN_ROOT}/src/prompt-coach.js history 10
```

## What the score means

The coach grades on four dimensions (S/A/B/C/D/F):
- **Specificity** — does the prompt name files, line numbers, identifiers?
- **Scope** — is the change bounded? "fix bug in src/auth.js:42" beats "fix all bugs"
- **Success criteria** — how do we know it's done? (tests pass, error gone, etc.)
- **Length** — too short usually means under-specified; too long buries the ask

## Presentation

After running the script, summarise the top 1–3 suggestions in plain language and offer to **rewrite the prompt** for the user. If they say yes:

```bash
node ${CLAUDE_PLUGIN_ROOT}/src/prompt-coach.js improve "the original prompt"
```

Then show the improved version with a brief diff explaining what changed.

## When to suggest this proactively

If you notice the user's prompt scored ≤60 in the last UserPromptSubmit hook and a task is going off the rails (lots of reads with no edits), gently suggest `/cco-coach` to refine.
