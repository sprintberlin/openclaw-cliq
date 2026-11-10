---
title: Core inbound text resolution defaults agent text to CommandBody, dropping envelope context
category: OpenClaw Plugin SDK
apis: [finalizeInboundContext, BodyForAgent, CommandBody]
files: [src/inbound.ts]
---
OpenClaw's `finalizeInboundContext` resolves agent text from `agentText`, `BodyForAgent`, `CommandBody`, then raw text, not from the formatted `Body` when `CommandBody` exists. Set `BodyForAgent` to the enriched message text containing quote, forward, and clarification blocks, and keep `CommandBody` as the cleaned user input. A formatted `Body` alone does not prove that the model receives those blocks.
