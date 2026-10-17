# Learning 162: Durable-before-ack ingress is a Core monitor, not a Cliq queue

- Date: 2026-10-17
- Issue: #261
- Files: src/ingress-runtime.ts, index.ts, src/gateway.ts, src/inbound.ts

## Insight

OpenClaw Core already ships the durable ingress pipeline
(`runtime.state.openChannelIngressQueue`, `createChannelIngressMonitor`,
`bindIngressLifecycleToReplyOptions`) to every loaded plugin, including
`plugins.load.paths` installs. Since PR #165063 the queue/drain are no longer
gated on `trustedOfficialInstall` (confirmed by the clawSweeper review on
openclaw/openclaw#175516). A channel therefore adopts the Core monitor instead
of growing its own queue, retry counters, or retention loops.

## Details

- The monitor's `admit` is the only surface the HTTP route calls; the account
  lifecycle (`startAccount`/`stopAccount`) owns create/start/stop. A request
  that arrives before readiness must fail closed (503), never fall back to an
  ack-first dispatch.
- The payload codec uses `storage: "raw-event"` and versioned JSON; corrupt or
  identity-mismatched rows are rejected through `createChannelIngressError`
  with `withReason: true`, which the Core drain dead-letters as non-retryable.
- `turnAdoptionLifecycle` (derived via `bindIngressLifecycleToReplyOptions`)
  completes the claim on durable turn adoption, not when dispatch returns.
- The public subpath that exports all three symbols on every supported version
  (2026.8.2 through 2026.10.2) is `openclaw/plugin-sdk/channel-outbound`; the
  `channel-message` alias named in older issue text was dropped in 2026.10.2.
- Installs whose runtime exposes no `openChannelIngressQueue` keep the
  pre-queue behaviour with one diagnostic; the absence must not crash or
  restart-loop the account.
