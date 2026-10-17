---
name: token-check
description: Estimate how many tokens a pasted text, an attached file or the conversation so far takes, what it means for the context window and usage limits, and how to cut it. Use when the user asks how big something is in tokens, why they keep hitting limits, or whether a file is too large to send.
license: MIT
---

# Token check

Give a quick, honest estimate and the cheapest way to get the same result.
These are estimates; say so. Exact counts come from the API's token counter.

## Estimate

- English prose: about 4 characters per token, roughly 750 words per 1,000
  tokens. A full page of text is 500–700 tokens.
- Code, JSON, logs: about 3 characters per token.
- Cyrillic, CJK and other non-Latin scripts: about 1.5–3 characters per
  token, so the same text costs noticeably more than in English.
- Images: on the order of 1,500 tokens each at typical sizes. PDFs: the text,
  plus an image's worth for pages read as images.

Give a range (for example "about 18–24K tokens"), and compare it with the
context window: 1M tokens on current Opus, Sonnet and Haiku 5.5 models,
200K on older Haiku.

## Explain the real cost

In a conversation, everything already in it is re-sent with every new
message. A 20K-token document pasted early is paid for again on each of the
next 30 messages, about 600K tokens in total. That, not the first send, is
what uses up limits.

## Ways to cut it, cheapest first

1. Send only the part that matters: the section, the function, the failing
   lines of a log.
2. Strip what carries no meaning: minified code, base64, repeated log lines,
   boilerplate.
3. Summarize a long document once, then continue from the summary.
4. When a conversation is long, start fresh from a handoff (the `fresh-start`
   skill).
5. In Claude Code: read files with offset/limit, let the `context-optimizer`
   scout subagent do wide exploration on Haiku, and run `/cco audit` to see
   where a session's tokens actually went.
