---
name: project-context
description: Turn background the user keeps re-explaining or re-pasting into reusable instructions, so new chats start with it for free. Use when the user repeats the same context, rules, style guide, persona or reference text across messages or chats, says they are tired of explaining the same thing, or asks how to set up a Claude Project, custom instructions or a CLAUDE.md.
license: MIT
---

# Project context

Context pasted into every new chat is paid for again in every chat, and
drifts each time it is retyped. Written once as instructions, it costs
nothing to bring along and stays the same.

## Collect

From this conversation, gather what the user keeps supplying: who they are
and what they work on, the audience, rules and constraints, tone and format
preferences, terms and names, recurring reference material. Ask one question
at most, and only for something essential that isn't in the conversation.

## Write two things, in the user's language

**1. Instructions**, in one code block, under 250 words: short imperative
lines grouped as *Context*, *Always*, *Never* and *Output*. Keep only what
changes the answers. No pleasantries, no restating what Claude does anyway.

**2. Reference material**: the long texts (a style guide, a spec, a
glossary, a price list) listed by name, to upload as files rather than paste
into the instructions.

## Where it goes

- **claude.ai or the desktop app**: create a Project, paste the instructions
  into its custom instructions, and add the reference files to its knowledge.
  Every chat started in that Project begins with both. For preferences that
  apply everywhere, use Settings → Profile instead.
- **Cowork**: start each task with the instructions, and keep the reference
  files in the folder you give it.
- **Claude Code**: a `CLAUDE.md` loads into every session, so keep there only
  the lines that matter on most tasks (build and test commands, conventions,
  hard rules). Long references belong in files that `CLAUDE.md` points to,
  read when needed.

End with one line on what this saves: for example, "This replaces the
~1,200-token briefing you've been pasting into each new chat."
