---
title: Core resolveChannelPreviewStreamMode only reads streaming.mode
files: [src/client.ts, src/legacy-state-migrations.ts, src/doctor.ts]
apis: [resolveChannelPreviewStreamMode, resolveChannelProgressDraftConfig, streaming.mode, streaming.preview]
issues: [#207]
---

OpenClaw's `resolveChannelPreviewStreamMode(entry, defaultMode)` inspects only `entry.streaming.mode`. A Cliq-only `streaming.preview: "on" | "off"` is invisible to that helper, so the plugin must supply a defaultMode of `"off"` when preview is `"off"` and `"partial"` otherwise. Do not put a schema `"default"` on `streaming.mode`: the gateway would inject `"partial"` before plugin code runs and make a legacy `preview: "off"` unreachable. Explicit `mode` always wins; `openclaw doctor --fix` rewrites leftover `preview` keys at the root and under `accounts.<id>`.
