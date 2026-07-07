---
title: Cliq message edit API
category: Zoho Cliq specifics
apis: [/api/v2/chats/{chatId}/messages, /api/v2/chats/{chat_id}/messages/{message_id}, ZohoCliq.Messages.UPDATE, ZohoCliq.Webhooks.CREATE]
source: migrated from AGENTS.md
---
- **Cliq message edit API:** `PUT /api/v2/chats/{chat_id}/messages/{message_id}` with body `{ text }` (text already `markdownToCliq`-converted by the caller). This is the **chat-messages** API, NOT the bot-message API — it requires the `ZohoCliq.Messages.UPDATE` scope (separate from `ZohoCliq.Webhooks.CREATE`), so `CliqClient.editMessage` mints + caches a per-scope token via `getAccessToken("ZohoCliq.Messages.UPDATE")`. The bot-message *send* response is inconsistent: channel posts return a top-level `{ id }`, bot DMs return `{ message_details: { "<userId>": { chat_id, message_id } } }`. `parseCliqMessageRef` extracts `messageId`/`chatId` from both shapes (plus top-level `message_id`/`chat_id` for the edit response). The chat id needed for an edit is NOT always in the send response for channel posts — the bernesto reference repo fetches recent messages (`GET /api/v2/chats/{chatId}/messages`) to resolve it.
