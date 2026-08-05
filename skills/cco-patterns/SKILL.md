---
name: cco-patterns
description: Share learned file patterns across a team — export an anonymized digest of what's usually waste/useful/co-edited, and import a teammate's so a fresh clone benefits day one
license: MIT
argument-hint: "[export [--out <file>] | import <file> | show]"
allowed-tools: [Bash, Read]
---

# CCO Patterns — share what the project has learned

Patterns are learned per-machine, per-project: which files are usually waste,
which are usually useful, which get edited together. A teammate's fresh clone
starts blind and re-learns the same lessons by wasting the same tokens.

This makes them portable. Run from the plugin root (the directory containing
`src/patterns-share.js`).

Parse $ARGUMENTS:

## `export`

```bash
node src/patterns-share.js export
```

Writes `.cco/patterns.digest.json` in the project (override with `--out`).

The digest contains **relative paths and counts only** — no file contents, no
absolute paths, no home directory. Entries that can't be expressed relative to
the project root are dropped, and the command reports how many. The file is
audited before writing; if anything identifying slipped in, it refuses to write
rather than produce a file someone might commit.

Tell the user the digest is safe to commit, and that committing it is the
point: teammates get it on clone.

## `import <file>`

```bash
node src/patterns-share.js import .cco/patterns.digest.json
```

Merges into the current project's patterns. **Imported data is stored as a
separate prior — it never touches the user's own counts.**

This matters and is worth saying out loud: `confidence` is computed from how
many sessions *this machine* observed a file in. Folding someone else's
sessions into that number would make the user's own confidence a lie. So the
import fills in only where the user has no observations of their own — the
fresh-clone case — and local evidence always wins.

The digest is audited on the way in too, since it came from elsewhere. A file
with absolute paths or traversal segments is rejected, not sanitized.

## `show`

```bash
node src/patterns-share.js show
```

Lists what was imported for this project and how each file is labelled.

## Suggesting this

Worth offering when:
- The user is setting up a repo for a team and asks about onboarding cost.
- A project has meaningful waste history (`/cco-shield` shows repeat offenders)
  that every teammate will otherwise rediscover.
- Someone just cloned a repo that already has `.cco/patterns.digest.json` —
  offer to import it.
