# PROGRESS.md

## Project: openclaw-cliq

**Status:** Inbound webhook path implemented (iteration 2 complete)

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
- `src/inbound.ts` — inbound webhook pipeline:
  - `CliqWebhookPayload` type (Deluge payload shape; tolerates string|object `message`, wrapped `params`, inconsistent channel/chat keys)
  - `parseCliqWebhookPayload(raw)` → `ParsedCliqInbound | null` (normalizes text, sender, chat, channel, group/DM, mention ids, handler)
  - `verifyWebhookSecret(req, expected)` — checks `x-cliq-webhook-secret` (also `x-webhook-secret` / `authorization: Bearer`); allow-through when no secret configured
  - `resolveCliqMentionFacts` + `resolveCliqMentionDecision` — mention gating via `resolveInboundMentionDecision` from `openclaw/plugin-sdk/channel-mention-gating`
  - `readJsonBody(req)` — size-limited JSON body reader
  - `dispatchCliqInbound({ runtime, cfg, account, parsed })` — dispatches into OpenClaw via `runtime.channel.inbound.run` with a minimal adapter that builds the turn context via `runtime.channel.routing.resolveAgentRoute` + `runtime.channel.reply.{resolveEnvelopeFormatOptions,formatAgentEnvelope,finalizeInboundContext,dispatchReplyWithBufferedBlockDispatcher}` + `runtime.channel.session.{resolveStorePath,readSessionUpdatedAt,recordInboundSession}` and delivers replies back through `CliqClient.sendMessage`
- `src/inbound.test.ts` — 19 vitest tests covering secret verification (5), payload parsing (8), mention facts (2), and mention decision/skip logic (4). All passing.
- `.github/` — coding agent infrastructure (pre-existing)

### What is done in this run (iteration 1)
- Set up project foundation per issue #1
- Installed `openclaw@2026.6.11` as a peer dependency for type-checking
- Verified typecheck (`tsc --noEmit`) passes clean
- Verified `vitest run` — 11/11 tests pass
- Studied the actual installed SDK types (they differ from the docs example): `resolveAccount`/`inspectAccount` live on `config: ChannelConfigAdapter`, NOT on `setup: ChannelSetupAdapter` (which holds `applyAccountConfig`). The docs example is outdated relative to the installed SDK version.

### What is done in this run (iteration 2)
- Implemented the inbound webhook path per issue #2:
  - Replaced the stub `/cliq/webhook` handler with a full POST handler: method guard → config resolution → secret verification → body parsing → payload parsing → self-message skip → mention-gate skip → async dispatch → 200 `{status:"received"}`.
  - Mention gating uses `resolveInboundMentionDecision` from `openclaw/plugin-sdk/channel-mention-gating` exactly as the docs prescribe (`{ facts, policy }` nested call shape).
  - Dispatch routes through `runtime.channel.inbound.run` (the documented inbound pipeline), with a minimal `ChannelTurnAdapter` whose `resolveTurn` assembles an `AssembledChannelTurn` using the legacy `runtime.channel.reply.*` + `runtime.channel.routing.*` + `runtime.channel.session.*` helpers and hands delivery back to `CliqClient`.
  - Studied the IBIZDigital/openclaw-cliq-channel reference repo for the real Deluge payload shape (string|object `message`, inconsistent `chat`/`channel` keys, wrapped `params`, `chat.type==="channel"` for groups, `-B` suffix convention for DM chat ids).
  - Added `src/inbound.test.ts` with 19 tests; total suite is 30/30 passing. Typecheck clean.

### What is still missing / incomplete
- **Dispatch adapter wiring is UNVERIFIED against a live gateway.** `dispatchCliqInbound` constructs an `AssembledChannelTurn` and calls `runtime.channel.inbound.run` using best-effort shapes inferred from the installed `.d.ts` + the IBIZDigital reference repo (which used the older `core.channel.*` surface). The exact argument shapes for `resolveAgentRoute`, `finalizeInboundContext`, `formatAgentEnvelope`, `dispatchReplyWithBufferedBlockDispatcher`, and `recordInboundSession` need runtime integration testing against a real OpenClaw gateway. The pure functions (parse, verify, mention-gate) are fully unit-tested; the dispatch glue is not.
- **No pairing flow** — `pairing` adapter not implemented (DM approval flow for new contacts). DM allowlist deny currently just drops the message silently.
- **No media/file sending** — `sendMedia` not implemented; capabilities.media is false.
- **No `mentions` adapter** on the plugin object (stripRegexes/stripMentions for stripping the bot @handle from the agent-visible text). Mention detection is currently inbound-only via `resolveCliqMentionDecision`.
- **No Markdown→Cliq formatting** — outbound sends raw text.
- **No typing/heartbeat indicators.**
- **No real Zoho Cliq API integration tests** (would need credentials / mocked fetch).
- **No `runtime-api.ts` / runtime store** for token caching across requests (currently each send mints a client; token cache is per-client-instance). The webhook handler creates a fresh `CliqClient` per inbound dispatch.
- **setup wizard not implemented** — only `applyAccountConfig`; no interactive `setupWizard`.
- **CLI subcommands not implemented** — only a stub `cliq` command descriptor.
- **No `src/channel.test.ts` coverage for outbound sendText** (requires mocking global fetch).
- **Self-message detection is naive** — matches `senderId === account.botId` or `senderName === account.botName`. Zoho bot self-events may need a more robust check.

### Next logical step
Verify the inbound dispatch wiring against a live gateway (or build a runtime mock test for `dispatchCliqInbound`), then implement the **`mentions` adapter** (stripRegexes/stripMentions) so the bot @handle is removed from the text the agent sees, and implement **DM allowlist enforcement / pairing** in the webhook handler so unauthorized DMs are rejected or routed through the pairing flow instead of silently dropped.

### Insights / blockers
- The installed `openclaw@2026.6.11` `runtime.channel` surface (in `types-CR1WAXpo.d.ts` around line 7204) exposes `text`, `reply` (incl. `dispatchReplyWithBufferedBlockDispatcher`, `finalizeInboundContext`, `formatAgentEnvelope`, `resolveEnvelopeFormatOptions`), `routing.resolveAgentRoute`, `session.*` (resolveStorePath, readSessionUpdatedAt, recordSessionMetaFromInbound, recordInboundSession, updateLastRoute), `mentions.*`, and `inbound.{run,buildContext,dispatchReply,runPreparedReply}`. The IBIZDigital repo used the same surface under the older `core.channel.*` alias and the legacy dispatch path (`dispatchReplyWithBufferedBlockDispatcher` + `finalizeInboundContext`), which is still present and is what `inbound.run` orchestrates under the hood.
- `resolveInboundMentionDecision` accepts either a flat params object or a nested `{ facts, policy }` object; the nested form is preferred per the docs. For DMs we force `wasMentioned: true` (a DM is always directed at the bot); for groups we require an explicit mention unless `requireMention` is relaxed.
- The Deluge payload is inconsistent: `message` can be a plain string or `{ text, id, time }`; channel info can live under `payload.channel`, `payload.chat.channel_unique_name`, or be inferable from `chat.type === "channel"` / `chat.title`. `parseCliqWebhookPayload` tolerates all of these and unwraps a wrapped `params` object some Deluge configs send.
- DM vs group detection: a chat id with a `-B` suffix indicates a bot DM (per IBIZDigital API notes), but we currently rely on `chat.type === "channel"` / presence of channel fields for group detection rather than the suffix, which is more robust to Cliq's inconsistent payloads.
- `ChannelOutboundContext` has `cfg`, `to`, `text`, `accountId` — no `account` or `chatType`. Outbound sendText must resolve the account from `cfg` + `accountId`.
- Reference repos (IBIZDigital, bernesto) were not fetched this run; consult them next iteration for the Zoho Cliq webhook payload shape and Deluge script conventions.

### History
- 2026-07-04 (iteration 1): Set up project foundation — package.json, manifest, tsconfig, entry points, minimal channel plugin scaffold with config/setup/security/threading/outbound adapters, CliqClient with OAuth token refresh, 11 passing tests. Typecheck clean.
- 2026-07-04 (iteration 2): Implemented inbound webhook path — payload parsing, secret verification, mention gating via `resolveInboundMentionDecision`, dispatch via `runtime.channel.inbound.run`. Replaced stub `/cliq/webhook` handler. Added `src/inbound.ts` + `src/inbound.test.ts` (19 tests). Total 30/30 tests passing, typecheck clean. Dispatch adapter wiring still needs live-gateway verification.
