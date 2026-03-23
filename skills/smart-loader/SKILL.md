---
name: smart-loader
description: Automatically suggests optimal files to preload based on the user's task description and historical context patterns. Activates when the user starts a new task, mentions reading files, or when session context is being set up.
license: MIT
disable-model-invocation: false
---

# Smart Context Loader

When a user starts a new task or asks to work on something, check if there are historical patterns that suggest which files they'll need.

## When to Activate

- User describes a new task (bug fix, feature, refactor, review)
- User says "let's work on..." or "I need to fix..."
- Session just started and user is describing what they want to do
- User asks "what files do I need for this?"

## How to Use

1. Check for existing templates matching the task type:
```bash
ls ~/.claude-context-optimizer/templates/ 2>/dev/null
```

2. Check historical patterns for the current directory:
```bash
node ${CLAUDE_PLUGIN_ROOT}/src/tracker.js suggest "$(pwd)"
```

3. Based on the task description and historical data:
   - If a matching template exists, mention it: "I see you have a '{name}' template. Want me to load that context?"
   - If historical patterns suggest files, mention: "Based on previous sessions, you usually need these files for this type of task: ..."
   - If patterns show files to avoid, mention: "Tip: [file] has been consistently unused in past sessions — I'll skip it."
   - If nothing matches, proceed normally

## Auto-Optimization Tips

When you detect patterns that waste tokens, proactively suggest improvements:

- If a large file (300+ lines) is being read fully: "I'll use offset/limit to read only the relevant section"
- If a file was wasted in 2+ past sessions: skip it silently or mention why
- If the user's task matches a known template: offer to apply it

## Important

- Do NOT automatically read files without user confirmation
- Only SUGGEST, don't force context loading
- Keep suggestions brief (top 3-5 files max)
- If no tracking data exists yet, skip silently — don't mention the optimizer
- Be helpful, not annoying — max 1 suggestion per task start
