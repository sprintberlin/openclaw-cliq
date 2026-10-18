---
title: saveMediaBuffer's fourth argument is the per-call maxBytes cap (5 MiB when omitted)
category: OpenClaw SDK specifics
apis: [saveMediaBuffer, openclaw/plugin-sdk/media-store, maxBytes]
source: issue #318
files: src/inbound-media.ts,src/media-limits.ts
---
`saveMediaBuffer(buffer, contentType, subdir, maxBytes, originalFilename)` defaults its fourth `maxBytes` argument to the media store's global 5 MiB cap and throws `Media exceeds <N>MB limit` before writing when the buffer is larger — the call site must pass its own cap to accept bigger files. The cap is per call, so a channel can enforce its own configured limit (and produce its own clearer error) instead of the opaque store default. A plugin's inbound-media limit is only reachable end-to-end when every earlier byte ceiling allows it: the webhook body reader's multipart aggregate (Cliq's own default was 25 MiB) must also be raised alongside the per-attachment cap.
