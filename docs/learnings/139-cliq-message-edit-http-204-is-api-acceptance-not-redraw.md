---
title: Cliq message-edit HTTP 204 is API acceptance, not a client redraw
category: Zoho Cliq specifics
files: [src/live-edit.ts, src/client.ts, README.md]
apis: [/api/v2/chats/{chatId}/messages/{messageId}, ZohoCliq.Messages.UPDATE]
issues: [#194, #195]
---

A successful `PUT /api/v2/chats/{chatId}/messages/{messageId}` returns HTTP 204 when Zoho accepted the edit. That is not proof the Cliq desktop/app redrew the bubble. A 2026-08-29 production DM sat on `⏳ …` until the chat was reopened even after the final 204. Document live-edit the same way native v3 typing already does: HTTP 204 is API acceptance only.
