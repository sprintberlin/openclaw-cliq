---
title: `createChatChannelPlugin` converts inline option forms into adapters
category: OpenClaw Plugin SDK
source: migrated from AGENTS.md
---
- **`createChatChannelPlugin` converts inline option forms into adapters.** `outbound: { base, attachedResults: { sendText } }` → a `ChannelOutboundAdapter` whose `sendText(ctx)` calls your `attachedResults.sendText` and spreads `{ channel, ...result }` (`core-D-xoNfL6.js:188`). So the test/call surface is `plugin.outbound.sendText(ctx)`, not the nested `attachedResults` shape. Same pattern for `security`, `threading`, and `pairing`.
