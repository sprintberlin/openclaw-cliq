---
title: Cliq progress drafts convert once and retire by edit
files: [src/progress-render.ts, src/live-edit.ts, src/inbound.ts]
apis: [markdownToCliq, /api/v2/chats/{chatId}/messages/{messageId}, ZohoCliq.Messages.UPDATE]
issues: [#209]
---

OpenClaw's progress compositor already owns sanitized headline, checklist, rolling-line ordering, and truncation; the Cliq adapter should convert the composed Markdown exactly once because `markdownToCliq` is not idempotent. A Cliq bot progress message is safest to retire by editing it into the final, failure text, card placeholder, or minimal marker, with delete only as a best-effort fallback because Zoho may reject bot-message deletion.
