---
title: Live-edit preview edits are throttled, coalesced, and monotonic
category: Zoho Cliq specifics
files: [src/live-edit.ts, src/inbound.ts, src/client.ts]
apis: [/api/v2/chats/{chatId}/messages/{messageId}, ZohoCliq.Messages.UPDATE]
issues: [#175, #185, #195, #205]
---

Plugin-channel live-edit is not per-token by itself: the SDK's buffered `deliver()` only flushes coalesced blocks, so a long generation can sit on the thinking placeholder until one final edit. Intermediate growth comes from `replyOptions.onPartialReply` snapshots (`info.snapshot: true`) written onto the same draft, plus later block/final `deliver()` calls; snapshot text is the latest cumulative model output and must replace the draft rather than be `\n\n`-appended as a block delta. Some OpenClaw `2026.8.1-beta.3` openai-completions thinking streams (`sprintcx/tier-1` + `thinking=medium`) set `openclawDelivery.textPhaseRequiresTerminal: true` and return before `emitAssistantStreamData` (openclaw/openclaw#132615); others (`sprintcx/tier-2` + `thinking=medium`) emit monotonic snapshots. Plugin tests that call the callback themselves stay green regardless. Preview edits remain throttled (`streaming.minEditIntervalMs`, default 1000 ms), coalesced, unchanged rendered text is not re-sent, older text cannot replace newer text, and a Cliq 429 backs off before retrying the latest preview. The thinking placeholder is that same draft, and message edit stays on v2 (`PUT /api/v2/chats/{chatId}/messages/{messageId}`) because v3 has no single-message edit endpoint.
