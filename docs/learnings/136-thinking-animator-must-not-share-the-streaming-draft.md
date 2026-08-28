---
title: Thinking animator must not share the streaming draft
files: [src/inbound.ts, src/thinking-animate.ts, src/live-edit.ts]
apis: [/api/v2/chats/{chatId}/messages/{messageId}, ZohoCliq.Messages.UPDATE]
issues: [#184]
---

The thinking animator (`thinking.animate: "dots"|"spinner"|"custom"`) and block-streaming live-edit both PUT `/api/v2/chats/{chatId}/messages/{messageId}`. When streaming preview is on, the thinking placeholder is the same draft `createLiveEditDeliver` grows (`initialDraft`). Frame edits on that id overwrite progressive preview text with 4/5/6-character `"💭 ."` / `"💭 .."` / `"💭 ..."` frames until the final answer. The inbound path therefore starts the animator only when `blockStreaming` is false; the static placeholder still posts, and live-edit still edits it into the growing reply.
