---
name: doc-digest
description: Turn a long document, PDF, transcript, spreadsheet or log into a compact working digest the conversation can continue from. Use when the user shares or pastes something long (several pages or more) and wants to discuss, analyze, compare or use it over more than one message, or asks to summarize a document so they can keep working with it.
license: MIT
---

# Document digest

A long attachment is re-sent with every later message of the conversation. A
digest that keeps what the work needs lets the rest of the work run on a
fraction of it, most of all in a fresh conversation that starts from the
digest instead of the file.

## Write the digest

In the user's language, inside one code block so it copies cleanly, at most
about a tenth of the source and never more than 800 words:

1. **What it is**: title, author or source, date, length, purpose, in one or
   two lines.
2. **Map**: the sections or parts in order, one line each, with page, slide,
   sheet or timestamp references, so a later question can go straight to the
   right place.
3. **Key content**: the claims, decisions, requirements, figures and
   definitions the user is likely to need, each with its reference. Quote
   exact wording only where it matters: legal terms, numbers, names, error
   messages.
4. **Gaps and doubts**: what the document leaves open, contradicts or gets
   wrong, in a line each.

Fit the digest to what the user said they want to do with the document: a
contract review keeps obligations, dates and penalties; a dataset keeps the
columns, units and odd values; a log keeps the first error and what led to
it. Never pad it with general background.

## Then

Give the size in one line, as an estimate: "The document is about 40K tokens;
the digest is about 1.5K." Then offer one of these, whichever fits:

- **Keep going here** and answer from the digest, opening the original only
  for a detail the digest lacks.
- **Continue in a new conversation**: open it, paste the digest and the
  question. Every later message then costs a few percent of what it does
  here. Offer the `fresh-start` handoff if there is more than the document to
  carry over.
- **In a Project** (claude.ai): add the original to the Project's knowledge
  and the digest to its instructions, so new chats in it start with both.

Don't claim the digest replaces the document for anything legal, financial or
safety-critical; point to the original sections for those.
