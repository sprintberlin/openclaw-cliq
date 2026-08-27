---
title: Two-layer inbound dedupe can disagree after a content-identity TTL expires
files: [src/inbound.ts, src/dedupe.ts, src/sdk-compat.ts]
apis: [claimCliqMessage, runtime.channel.inbound.run, readInboundProcessedOutcome]
issues: [#123]
---

Cliq's plugin guard retains content-derived identities (`syn:` / `cmp:`) only briefly so deliberate repeated commands remain usable, while OpenClaw's independent inbound dedupe can still recognize the same delivery later. A redelivery in that gap may pass plugin admission but be skipped by the runtime, so user-visible side effects created before `inbound.run` must either be suppressed while an equivalent content turn is in flight or removed silently when the runtime exposes a benign skip. The processed skip reason is not available on every supported SDK version; resolve any reader dynamically and preserve the previous cleanup behavior when unavailable.
