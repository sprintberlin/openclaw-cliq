---
title: Some openai-completions thinking streams hold text until terminal
category: OpenClaw SDK
files: [src/inbound.ts, src/live-edit.ts, src/openclaw-partial-reply-contract.test.ts]
apis: [onPartialReply, emitAssistantStreamData, textPhaseRequiresTerminal]
issues: [#195, #205]
---

On OpenClaw `2026.8.1-beta.3`, some openai-completions thinking streams stamp `openclawDelivery.textPhaseRequiresTerminal: true`. The assistant-stream handler then `return`s before `emitAssistantStreamData`, and `onPartialReply` is only called from that emit path. Live `sprintcx/tier-1` + `thinking=medium` stays on the thinking placeholder until one final `deliver()` edit (openclaw/openclaw#132615). The same runtime and plugin emit monotonic `onPartialReply` growth for `sprintcx/tier-2` + `thinking=medium`. Do not treat openai-completions + thinking as a universal snapshot block, and do not invent Cliq streaming from content the selected model never emitted.
