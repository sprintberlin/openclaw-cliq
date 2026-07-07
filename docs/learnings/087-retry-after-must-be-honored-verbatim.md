---
title: `Retry-After` must be honored verbatim
category: Zoho Cliq specifics
source: migrated from AGENTS.md
---
- **`Retry-After` must be honored verbatim** even when it exceeds the jitter `maxDelayMs`. The server's directive is authoritative for rate-limit backoff; `maxDelayMs` only caps the exponential-with-jitter path (used when there is no `Retry-After`). `parseRetryAfterMs` already caps the header at 60s, so `computeBackoffMs` returns it unmodified.
