---
title: Transient webhook readiness failures are inconclusive, not configuration failures
files: src/webhook-preflight.ts,src/webhook-preflight-command.ts,src/inbound-readiness.ts,src/setup-wizard.ts
apis: /cliq/webhook,inboundVerifiedAt,inboundVerificationFailedAt
---
- **A reverse-proxy `502`/`503`/`504` or connection refused/reset/timeout while the gateway starts does not prove the webhook configuration is broken.** Retry that method/reachability boundary with a small bounded backoff, record the attempt count and delay in redacted stage evidence, and classify exhaustion as warn-only/inconclusive. Only a report with proven failing evidence may replace `inboundVerifiedAt` with `inboundVerificationFailedAt`; setup and standalone preflight must preserve both timestamps for inconclusive results.
