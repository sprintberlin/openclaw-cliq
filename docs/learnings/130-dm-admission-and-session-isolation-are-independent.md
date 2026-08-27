---
title: Channel DM admission and DM session isolation are independent, and the isolation default is unsafe
category: Sessions and routing
files: src/dm-scope.ts,src/security-audit.ts,src/doctor-runner.ts,src/setup-wizard.ts
apis: session.dmScope,per-channel-peer,per-account-channel-peer,resolveAgentRoute
---
- **A channel's `dmPolicy` / `allowFrom` control admission only; conversation isolation comes from the global `session.dmScope`.** A plugin can pass a correct per-sender peer (`dm:<senderId>`) into `resolveAgentRoute()` and still have every DM collapse into `agent:<agentId>:main`, because core intentionally merges peers when the scope is `main` — leaking context between users and letting the shared session's most recent delivery route send a reply to a different channel (`visible channel turn dispatched with no queued reply payloads`). **`main` is the runtime default whenever the `session` block is absent**, so fresh installs are affected, not just legacy ones; `per-channel-peer` isolates per channel and sender, and `per-account-channel-peer` additionally isolates the same sender across accounts. The value is global to every channel, so a plugin must warn and ask rather than overwrite it.
