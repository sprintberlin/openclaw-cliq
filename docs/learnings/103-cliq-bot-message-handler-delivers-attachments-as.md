---
title: Cliq Message Handler FILE objects lose bytes when JSON-serialized
category: Zoho Cliq specifics
apis: [/api/v2/chats/{chatId}/messages, /api/v2/files/{FILE_ID}, ZohoCliq.Messages.READ, ZohoCliq.Attachments.READ]
source: issue #84
---
- **Cliq bot Message handler exposes `attachments` as Deluge FILE objects, while JSON serialization can reduce them to names.** The handler's `message` is a plain string, not the rich message object, and `payload.toString()` does not preserve attachment bytes; the live voice-note failure therefore reached the webhook as `voice-message-….wav` with no id. Forward each original FILE via multipart `invokeUrl files:` plus a JSON `stringPart`, and include `attachment.getFileName()` metadata so the webhook can correlate parts. Keep the history fallback: `GET /api/v2/chats/{chatId}/messages` may recover `content.file.{id,name,type}` for ordinary files, followed by `GET /api/v2/files/{FILE_ID}`; a failed lookup still degrades to a name-only turn. Mention Handlers do not expose `attachments` and must not reference this branch. The message-object docs at <https://www.zoho.com/cliq/help/platform/cliq-objects/message-object.html> describe the history/API shape, not the bot-handler FILE argument.
