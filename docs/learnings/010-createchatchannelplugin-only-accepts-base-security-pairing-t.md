---
title: `createChatChannelPlugin` only accepts `{ base, security, pairing, threading, outbound }`
category: OpenClaw Plugin SDK
source: migrated from AGENTS.md
---
- **`createChatChannelPlugin` only accepts `{ base, security, pairing, threading, outbound }`** (`node_modules/openclaw/dist/core-CBhRRoge.d.ts:225`). Any other `ChannelPlugin` field — `mentions`, `commands`, `lifecycle`, `groups`, `heartbeat`, etc. — must go on `base` (it is `Omit<ChannelPlugin, "security"|"pairing"|"threading"|"outbound"> & Partial<Pick<…>>`). Putting `mentions` at the top level is silently dropped.
