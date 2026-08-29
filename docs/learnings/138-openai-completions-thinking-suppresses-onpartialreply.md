---
title: OpenAI-completions thinking turns never invoke plugin onPartialReply
category: OpenClaw SDK
files: [src/inbound.ts, src/live-edit.ts, src/openclaw-partial-reply-contract.test.ts]
apis: [onPartialReply, emitAssistantStreamData, textPhaseRequiresTerminal]
issues: [#195]
---

On OpenClaw `2026.8.1-beta.3`, openai-completions streams with `thinking` stamp `openclawDelivery.textPhaseRequiresTerminal: true`. The assistant-stream handler then `return`s before `emitAssistantStreamData`, and `onPartialReply` is only called from that emit path. A plugin channel can wire the callback correctly and still receive zero snapshots; live Cliq DMs stay on the thinking placeholder until one final `deliver()` edit. Tracked upstream as openclaw/openclaw#132615. Do not invent Cliq streaming from content the runtime never emitted.
