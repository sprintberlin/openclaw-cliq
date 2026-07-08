---
title: Plugin-channel images go through `media-understanding` describe (not inline LLM), requiring a vision-capable model
category: OpenClaw Plugin SDK
files: [src/inbound.ts, src/inbound-media.ts]
apis: [finalizeInboundContext, MediaPath, MediaPaths]
source: issue #88
---

- **Plugin-channel images go through `media-understanding` describe, not inline LLM.** A plugin channel attaches inbound media by downloading the file itself, staging it via `saveMediaBuffer`, and passing flat `MediaPath`/`MediaPaths` fields into `finalizeInboundContext`. The runtime's dispatch path detects these fields via `hasInboundMediaForUnderstanding(ctx)` and runs `applyMediaUnderstanding` — a separate describe-images pipeline that calls a vision-capable model to produce a text description of the image. If no vision-capable model is resolved (no `tools.media.image` provider configured, primary model is text-only, and no vision-capable fallback found), the pipeline fails with `"Model does not support images"` and the image is NOT analyzed. Bundled channels (Telegram/Discord) use `buildChannelInboundEventContext` (the richer path) which can pass images as **inline base64 attachments** via an `images[]` parameter — those reach the LLM directly as multimodal content, so the primary model's native vision (or its fallback chain) handles them without the `media-understanding` describe pipeline. This is a runtime-side limitation: the plugin SDK's `finalizeInboundContext` does NOT expose an `images[]` param. To get image analysis on a plugin channel, either (a) configure a vision-capable primary model, (b) configure an explicit `tools.media.image` provider, or (c) ensure a vision-capable model exists in the fallback chain that `resolveAutoImageModelId` can discover.
