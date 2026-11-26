---
title: Core's pending-input idempotency conflict is a plain `Error` with no code, so a channel can only classify it by message text
files: [src/ingress-runtime.ts]
apis: [stageSessionPendingInput, resolveNonRetryableFailure, idempotencyKey]
issues: [#350]
---

`stageSessionPendingInput` (Core, `session-accessor-*.js`, confirmed on 2026.8.2 and 2026.10.9) throws a bare `new Error("Pending input idempotency key conflicts with the accepted input")` when a `session_pending_inputs` row with the same `idempotencyKey` (= the channel's source turn id, stable across replays) has a different `request_hash` or a different `run_id`. There is no class, `code`, or exported symbol for it — the only discriminator is the whole message text, so a match must be anchored to it rather than a substring. The two sibling messages (`Pending input ownership ended…`, `Pending input is already admitted…`) are thrown as plain errors too and are transient, so they must keep retrying. The request hash is `sha256(stableStringify(message minus timestamp))`, but whether a newly staged attachment path reaches the hashed message was not proven in #350, and a differing `run_id` alone raises the identical error. Dead-lettering the conflict is therefore a loop stop-gap, not proof that stable attachment staging alone will make a replay recoverable.
