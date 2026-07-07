---
title: Pairing runtime
category: OpenClaw Plugin SDK
source: migrated from AGENTS.md
---
- **Pairing runtime** lives on `runtime.channel.pairing` (`types-D7eu8baG.d.ts:7070`): `upsertPairingRequest({channel,id,accountId,meta?,…})` → `{ code, created }` (`created=false` = a pending request already existed → idempotent, do not re-reply); `buildPairingReply({channel,idLine,code})` → the standard access-not-configured reply text.
