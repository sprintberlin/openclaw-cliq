---
title: Always-on channel silence is a placeholder lifecycle, not a Deluge keyword
files: [src/inbound.ts, src/self-message.ts]
apis: [participation_handler, GroupSystemPrompt, NO_REPLY, inbound.run, selfSenderIds]
issues: [#283]
---

OpenClaw Core suppresses an exact token-only `NO_REPLY` before a channel plugin's `deliver` callback runs, while the plugin-visible `inbound.run` result exposes only a dispatched zero-count shape rather than the internal processed outcome. For an unmentioned `participation_handler` turn, the Cliq plugin must therefore avoid creating a thinking/progress draft, inject the Core `NO_REPLY` contract through `GroupSystemPrompt`, and treat a resolved zero-count dispatch as benign only in that undirected context; directed DMs/mentions keep the failure notice. Cliq exposes no reliable bot flag, so known bot identities remain a separate pre-dispatch `selfSenderIds` gate rather than a prompt-only loop defense.
