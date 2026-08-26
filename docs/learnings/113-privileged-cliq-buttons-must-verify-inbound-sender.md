---
title: Cliq privileged button actions must verify the inbound sender
files: src/pairing.ts,index.ts
apis: invoke.bot,pairing.notifyOwnerTarget
---

Cliq `invoke.bot` button clicks arrive as ordinary inbound messages and carry no cryptographic proof of who clicked, so a privileged sentinel is forgeable by any sender. A pairing Approve/Deny action must compare the inbound sender id against the configured DM owner using normalized allowlist semantics before inspecting or consuming the code; a channel target identifies a room rather than a person and cannot authorize the clicker.
