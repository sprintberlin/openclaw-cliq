---
title: Native slash-command routing requires CommandSource + CommandAuthorized on the inbound context
category: OpenClaw Plugin SDK
files: [src/inbound.ts, src/commands.ts]
apis: [dispatchReplyWithBufferedBlockDispatcher, CommandSource, CommandAuthorized, CommandTurn, resolveCommandTurnContext]
issues: [#91]
---

The SDK's `resolveCommandTurnContext(ctx)` determines how an inbound message
is routed: native command handler vs normal agent dispatch. It reads
`ctx.CommandTurn` (explicit), then falls back to `ctx.CommandSource` +
`ctx.CommandAuthorized`. When neither is set (the default for a plugin channel
that only sets `CommandBody`), the turn resolves to `{ kind: "normal",
authorized: false }` — the message is treated as plain text, the native command
handler never fires, and `build*ChannelData` is never called.

A plugin channel that registers a `commands` adapter with
`nativeCommandsAutoEnabled: true` MUST also set `CommandSource: "native"` and
`CommandAuthorized: true` on the `ctxPayload` for `/`-prefixed messages (except
abort intents, which use `CommandSource: "text"`). Without these fields the
SDK's `shouldBypassPluginOwnedBindingForCommand` returns false, the message
goes through normal agent dispatch, and slash commands produce no interactive
output (no `channelData`, no `deliver` call). The `CommandAuthorized` field is
especially critical: `createCommandTurnContext` forces `authorized: false` for
`kind: "normal"` regardless of the input, so the only way to get
`authorized: true` is to set `CommandSource` to `"native"` or `"text"` AND set
`CommandAuthorized: true`.
