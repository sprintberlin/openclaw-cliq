# PROGRESS.md

## Project: openclaw-cliq

**Status:** Foundation in place (iteration 1 complete)

### What exists in this repo
- `AGENTS.md` — project context and conventions
- `package.json` — `@sprintcx/openclaw-cliq`, channel id `cliq`, openclaw channel metadata, compat `>=2026.6.6`
- `openclaw.plugin.json` — manifest with config schema for `clientId`, `clientSecret`, `botId`, `botName`, `webhookSecret`, `allowFrom` (required: clientId, clientSecret, botId)
- `tsconfig.json` — TypeScript ESM, strict, noEmit, allowImportingTsExtensions
- `index.ts` — `defineChannelPluginEntry` with `registerCliMetadata` (cliq command) and `registerFull` (stub `/cliq/webhook` HTTP route)
- `setup-entry.ts` — `defineSetupPluginEntry(cliqPlugin)`
- `src/channel.ts` — `cliqPlugin` built via `createChatChannelPlugin`:
  - `base`: id, meta, capabilities (direct+group, reply), config adapter (listAccountIds, resolveAccount, inspectAccount, isConfigured), setup adapter (applyAccountConfig)
  - `security.dm`: allowlist policy resolved from account.dmPolicy / account.allowFrom
  - `threading`: topLevelReplyToMode "reply"
  - `outbound`: direct deliveryMode, 5000 char chunk limit, `sendText` via CliqClient
- `src/client.ts` — `CliqClient` (EU OAuth client_credentials, token cache + auto-refresh), `resolveCliqConfig`, `chunkMessage` (newline-aware 5000 char chunking), `ResolvedCliqAccount` type
- `src/channel.test.ts` — 11 vitest tests (all passing) covering account resolution, inspection, account config application, capability advertisement, and message chunking
- `.github/` — coding agent infrastructure (pre-existing)

### What is done in this run (iteration 1)
- Set up project foundation per issue #1
- Installed `openclaw@2026.6.11` as a peer dependency for type-checking
- Verified typecheck (`tsc --noEmit`) passes clean
- Verified `vitest run` — 11/11 tests pass
- Studied the actual installed SDK types (they differ from the docs example): `resolveAccount`/`inspectAccount` live on `config: ChannelConfigAdapter`, NOT on `setup: ChannelSetupAdapter` (which holds `applyAccountConfig`). The docs example is outdated relative to the installed SDK version.

### What is still missing / incomplete
- **Inbound webhook handler is a stub** — `registerFull` registers `/cliq/webhook` but only returns 200 "ok". No payload parsing, no `x-cliq-webhook-secret` verification, no dispatch to OpenClaw inbound pipeline.
- **No pairing flow** — `pairing` adapter not implemented (DM approval flow for new contacts).
- **No media/file sending** — `sendMedia` not implemented; capabilities.media is false.
- **No mention gating** — no `mentions` adapter / mention regexes for the bot name.
- **No Markdown→Cliq formatting** — outbound sends raw text.
- **No multi-message chunking at the outbound adapter level** — `chunker` is wired but the channel does not yet split + send multiple messages itself (core handles chunking via the shared chunker; verify this is sufficient).
- **No typing/heartbeat indicators.**
- **No real Zoho Cliq API integration tests** (would need credentials / mocked fetch).
- **No `runtime-api.ts` / runtime store** for token caching across requests (currently each send mints a client; token cache is per-client-instance).
- **setup wizard not implemented** — only `applyAccountConfig`; no interactive `setupWizard`.
- **CLI subcommands not implemented** — only a stub `cliq` command descriptor.
- **No `src/channel.test.ts` coverage for outbound sendText** (requires mocking global fetch).

### Next logical step
Implement the inbound webhook path:
1. Parse the Zoho Cliq webhook payload (mention vs DM, sender, channel/chat id, text).
2. Verify the `x-cliq-webhook-secret` header against `account.webhookSecret`.
3. Dispatch the inbound message into OpenClaw via the channel inbound pipeline (`openclaw/plugin-sdk/channel-inbound` / `channel-ingress-runtime`).
4. Add mention gating using `resolveInboundMentionDecision` from `openclaw/plugin-sdk/channel-mention-gating`.

This is the highest-value next increment because without inbound the plugin cannot receive messages.

### Insights / blockers
- The installed `openclaw@2026.6.11` SDK surface is significantly larger and more layered than the docs walkthrough implies. The docs example (`setup: { resolveAccount, inspectAccount }`) does not match the installed types — those methods are on `config: ChannelConfigAdapter`. Future iterations must verify against the installed `.d.ts` files in `node_modules/openclaw/dist/`, not just the docs.
- `createChatChannelPlugin`'s `base` requires `capabilities` (non-optional) and `config` (the ChannelConfigAdapter, non-optional) in addition to `setup`. The docs omit these.
- `getChatChannelMeta(id)` only accepts built-in `ChatChannelId` values, so a custom channel like `cliq` must build `ChannelMeta` manually (done).
- `ChannelOutboundContext` has `cfg`, `to`, `text`, `accountId` — no `account` or `chatType`. Outbound sendText must resolve the account from `cfg` + `accountId`.
- Reference repos (IBIZDigital, bernesto) were not fetched this run; consult them next iteration for the Zoho Cliq webhook payload shape and Deluge script conventions.

### History
- 2026-07-04 (iteration 1): Set up project foundation — package.json, manifest, tsconfig, entry points, minimal channel plugin scaffold with config/setup/security/threading/outbound adapters, CliqClient with OAuth token refresh, 11 passing tests. Typecheck clean.
