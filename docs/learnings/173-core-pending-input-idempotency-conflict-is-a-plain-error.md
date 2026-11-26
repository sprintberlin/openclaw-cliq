---
title: Core's pending-input idempotency conflict is a plain `Error` with no code, so a channel can only classify it by message text
files: [src/ingress-runtime.ts, src/inbound-media.ts]
apis: [stageSessionPendingInput, resolveNonRetryableFailure, saveMediaBuffer, idempotencyKey]
issues: [#350]
---

`stageSessionPendingInput` (Core, `session-accessor-*.js`) throws a bare `new Error("Pending input idempotency key conflicts with the accepted input")` when a `session_pending_inputs` row with the same `idempotencyKey` (= the channel's source turn id, stable across replays) has a different `request_hash` or `run_id`. There is no class, `code`, or exported symbol for it — the typed `SessionPendingInputCustodyError` on newer Core covers only the transient siblings (`Pending input ownership ended…`, `Pending input is already admitted…`), which must keep retrying. For channel turns the hash is `sha256(stableStringify(message minus timestamp))`, and every ingress re-dispatch calls `saveMediaBuffer` again, which mints a random media id/path (`store-*.js`) that lands in the turn's media facts — so a replayed attachment can never match the accepted input and a retry loop can only fail again.
