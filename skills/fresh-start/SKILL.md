---
name: fresh-start
description: Continue in a new chat without losing anything — writes a compact handoff to paste into a fresh conversation. Use whenever the user wants to move to a new chat or conversation, hits usage limits, says replies got slow or Claude forgets earlier details, or the conversation has grown long.
license: MIT
---

# Fresh start

Every message re-sends the whole conversation, so a long one uses up limits
fast and recalls its early details worse. A new conversation that starts from
a short handoff costs a fraction and stays sharp.

## When to offer it

- The user asks to start over, hits a limit, or says replies got slow or
  forgetful.
- The conversation is clearly long: many long turns, large pasted files or
  documents. Offer it once, in one sentence, at a natural break. Don't
  interrupt a short conversation or a task that is nearly done.

## The handoff

Write it in the user's language, under 300 words, inside one code block so it
copies cleanly:

1. **Goal** — one line.
2. **Decisions so far** — bullets, each with its reason in a few words.
3. **Current state** — what exists now: files, drafts, versions, results.
   Quote only short snippets that the next step needs; name everything else.
4. **Next step** — the very next thing to do, then any open questions.
5. **Must not be lost** — names, numbers, constraints, preferences, things
   that were tried and failed.

Then give the saving in one line, as an estimate: "This conversation is about
60K tokens; the handoff is about 500, so each message in the new chat re-sends
under 1% of what it does here." Then tell the user: open a new conversation,
paste the block, and continue.

## On each surface

- **claude.ai chat:** a new chat with the pasted handoff. In a Project, the
  project's files stay available, so the handoff can just name them.
- **Cowork:** start a new task with the handoff as its first message.
- **Claude Code:** `/compact` keeps working in place and is usually enough.
  For a clean break, `/clear` and paste the handoff. `/cco task patch` keeps
  structured task state across `/compact` automatically.

Never paste whole files, logs or the transcript into the handoff.
