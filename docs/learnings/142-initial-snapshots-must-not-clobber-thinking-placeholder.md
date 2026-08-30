---
title: Initial onPartialReply snapshots must not clobber an active thinking placeholder
files: [src/live-edit.ts, src/inbound.ts]
apis: [/api/v2/chats/{chatId}/messages/{messageId}, ZohoCliq.Messages.UPDATE, onPartialReply]
issues: [#203]
---

When OpenClaw emits `onPartialReply` snapshots during a streaming turn, the first snapshot can be a single character (`textLen=1`) or whitespace prefix before meaningful text is formed. When an initial thinking placeholder is active (`initialDraft`), writing that tiny snapshot overwrites the placeholder bubble (e.g. `⏳ …` or `💭 …`) with an unreadable 1-character fragment. `createLiveEditDeliver` preserves the placeholder until a snapshot provides substantive reply content (strictly longer than the trimmed placeholder text), keeping the instant-acknowledgement cue visible until real output arrives.
