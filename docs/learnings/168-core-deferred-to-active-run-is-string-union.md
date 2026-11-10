---
title: Core deferredToActiveRun uses a string union, not boolean
files: [src/inbound.ts]
apis: [deferredToActiveRun, inbound.run, isCliqSilentDispatchResult, isBenignlySkippedTurn]
issues: [#337]
---

OpenClaw Core's `DispatchFromConfigResult` types `deferredToActiveRun?: "steer" | "followup"`. The finalize stage sets this to `replyAdmission.mode` when follow-ups or steer messages are accepted into an active run. Checking for boolean `true` misses both strings, causing directed turns to fall through to `cleanupStrayPlaceholder` and post an erroneous failure notice.
