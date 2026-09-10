---
title: Thinking animation must be drained before the streaming draft takes ownership
files: [src/inbound.ts, src/thinking-animate.ts, src/live-edit.ts]
apis: [/api/v2/chats/{chatId}/messages/{messageId}, ZohoCliq.Messages.UPDATE]
issues: [#184, #211]
---

The thinking animator (`thinking.animate: "dots"|"spinner"|"custom"`) and live preview/progress both PUT `/api/v2/chats/{chatId}/messages/{messageId}`. Animation may own the shared placeholder while the turn emits no substantive draft text, but the first real partial, block, progress, or final update must stop the timer and await any frame PUT already in flight before editing that message. After that handoff, animation stays stopped for the turn; otherwise a late 4/5/6-character frame can overwrite generated text.
