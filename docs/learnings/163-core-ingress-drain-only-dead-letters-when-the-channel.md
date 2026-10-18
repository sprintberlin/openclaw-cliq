# Learning 163: Core's ingress drain only dead-letters when the channel classifies the error itself

- Date: 2026-10-18
- Issue: #262
- Files: src/ingress-runtime.ts
- APIs: createChannelIngressMonitor, drain.resolveNonRetryableFailure, createChannelIngressError

## Insight

`resolveIngressFailureDisposition` (node_modules/openclaw/dist/ingress-drain-*.js, re-exported via `openclaw/plugin-sdk/channel-outbound`) dead-letters ONLY when `drain.resolveNonRetryableFailure(err)` returns a `{reason, message}`; everything else is released for retry, regardless of the error class.

## Details

- `createChannelIngressError(name, { withReason: true })` from `openclaw/plugin-sdk/channel-outbound` produces a class with a `reason` field, but the drain never inspects it by itself — a channel that throws the codec claim error without passing `drain.resolveNonRetryableFailure` will retry its corrupt row forever (poll-interval loop, never dead-lettered).
- Passing a classifier that walks the error `cause` chain for the channel's own claim-error class (see `resolveCliqIngressNonRetryableFailure` in src/ingress-runtime.ts) makes `invalid-version` / `identity-mismatch` rows reach `queue.fail()` — matching the Synology/LINE/Twitch precedent inside Core.
- The drain's dead-letter logs (`dead-lettered`, `retry-limit-exceeded`) name the row `spooled update <id>`; a failing row keeps its lane blocked until dead-lettered or released, so an unclassified poison row also stalls its conversation lane.
