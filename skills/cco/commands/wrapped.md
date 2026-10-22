# Wrapped

A short recap of the last week of Claude Code, read from the session
transcripts in `~/.claude/projects/`. Nothing leaves the machine.

Run (pass `<args>` through; `--days N` changes the window, default 7):

```bash
node ${CLAUDE_PLUGIN_ROOT}/src/wrapped.js <args>
```

Show the recap as printed, then add one sentence on the tip it ends with and
the command that acts on it (`/cco audit` for the full breakdown, `/cco task`
before a `/compact`). The day is each transcript's last-modified day, so a
session that spans midnight counts on its last day. Don't turn the figures
into savings claims; they are what was spent.
