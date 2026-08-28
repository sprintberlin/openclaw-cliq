---
title: Live-edit preview edits are throttled, coalesced, and monotonic
category: Zoho Cliq specifics
files: [src/live-edit.ts, src/inbound.ts, src/client.ts]
apis: [/api/v2/chats/{chatId}/messages/{messageId}, ZohoCliq.Messages.UPDATE]
issues: [#175]
---

Plugin-channel live-edit is block-granularity, not token streaming: `createLiveEditDeliver` receives one coalesced block per `deliver` and edits a single draft in place. Intermediate preview edits of that draft are throttled (`streaming.minEditIntervalMs`, default 1000 ms) and coalesced so a chatty turn issues at most roughly one PUT per second; unchanged rendered text is never re-sent. A later, longer accumulated draft always wins over an in-flight older edit, and a Cliq 429 backs off (`Retry-After` when present) before retrying the latest preview rather than failing the turn. The thinking placeholder, when posted, is that same draft — the first block edits it instead of sending a second progress message. Message edit stays on v2 (`PUT /api/v2/chats/{chatId}/messages/{messageId}`); v3 has no single-message edit endpoint.
