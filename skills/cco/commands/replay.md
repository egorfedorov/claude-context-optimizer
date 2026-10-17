# Session Replay

Show the user summaries of their recent sessions so they can quickly recover context.

Parse <args> for the number of sessions to show (default: 5).

Run:
```bash
node ${CLAUDE_PLUGIN_ROOT}/src/replay.js <args>
```

Present the output to the user. It shows recent session summaries including:
1. When the session happened and how long it lasted
2. Which files were edited
3. Token usage and waste percentage

If no summaries exist yet, tell the user:
"No session summaries yet. They're generated automatically at the end of each session — just keep working!"
