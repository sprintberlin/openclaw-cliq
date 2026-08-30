---
title: OpenClaw Core keeps processedOutcome off the plugin-visible inbound.run result
files: [src/inbound.ts, src/sdk-compat.ts]
apis: [readInboundProcessedOutcome, inbound.run, processedOutcome, skipped:duplicate]
issues: [#204]
---

On OpenClaw `2026.8.1-beta.3`, a Core `skipped:duplicate` is recorded on an AsyncLocalStorage sink used only for the zero-count warning log. `runPreparedChannelTurn` returns `{ admission, dispatched, ctxPayload, routeSessionKey, dispatchResult }` and does not attach `processedOutcome`. A plugin that looks only for that field therefore treats a content-derived duplicate as a failed no-reply turn. Detect the Core-shaped silence (`dispatched: true`, `queuedFinal: false`, zero counts) for `syn:` identities and delete any thinking placeholder instead of rewriting it to the failure notice.
