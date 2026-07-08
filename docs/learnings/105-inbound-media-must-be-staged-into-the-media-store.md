---
title: Inbound media must be staged into the media-store `inbound` bucket
category: OpenClaw SDK specifics
apis: [saveMediaBuffer, openclaw/plugin-sdk/media-store]
source: issue #87
files: src/inbound-media.ts
---
- **Inbound media must be staged into the media-store `inbound` bucket to be readable by agent tools.** Writing downloaded bytes to a plugin-chosen temp dir (e.g. `os.tmpdir()/openclaw-cliq-media/<uuid>/`) and passing that path as `MediaPath` causes the agent's image/media tool to reject it with *"Local media file not found: path not under an allowed directory"*. The runtime only reads media that is (a) under an allowed local root, or (b) a managed inbound-media reference — a first-level file under `getMediaDir()/inbound/…`, resolvable as `media://inbound/<id>`. The canonical pattern is `saveMediaBuffer(buffer, contentType, "inbound", undefined, originalFilename)` from `openclaw/plugin-sdk/media-store`; the returned `path` lives under the media-store `inbound` bucket and is automatically trusted. This is the same pattern first-party channels (Telegram, Discord) use.
