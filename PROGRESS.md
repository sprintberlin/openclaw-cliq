# PROGRESS.md

## Project: openclaw-cliq

**Status:** DM allowlist enforcement implemented (iteration 4 complete)

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
- `src/mentions.ts` — bot-mention stripping: `buildCliqMentionRegexes(account)` (case-insensitive `@botName`/`@botId` regexes with word-boundary, deduped) + `stripCliqMentions(text, account)` (pure strip + whitespace normalize). Used both by the plugin `mentions` adapter and the inbound dispatch path.
- `src/mentions.test.ts` — 16 vitest tests covering regex construction (4), pure strip behavior (7), and the plugin `mentions` adapter wiring (5). All passing.
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

### What is done in this run (iteration 3)
- Implemented the `mentions` adapter so the bot @handle is stripped from the text the agent sees.
  - Added `src/mentions.ts` with two pure, side-effect-free helpers: `buildCliqMentionRegexes({botId, botName})` (case-insensitive `@<name>\b` regexes, deduped by lowercase) and `stripCliqMentions(text, account)` (applies the regexes, collapses whitespace, trims; no-op when no bot identity configured).
  - Wired a `mentions` adapter onto `cliqPlugin.base` (`createChatChannelPlugin` only accepts `base/security/pairing/threading/outbound`, so `mentions` lives on `base`, not at the top level). Exposes `stripRegexes`, `stripPatterns`, and `stripMentions` — all resolve the account safely via a new `resolveAccountSafe(cfg, accountId)` helper that returns `null` instead of throwing when the channel is unconfigured (the adapter contract passes `cfg: OpenClawConfig | undefined`).
  - Updated `dispatchCliqInbound` to strip the bot @handle before building the agent envelope: `Body`/`RawBody`/`CommandBody` now use the cleaned text (so the agent doesn't echo the handle and command detection operates on the clean instruction). Delivery text to the channel is unaffected.
  - Added `src/mentions.test.ts` (16 tests). Total suite is 46/46 passing. Typecheck clean.
  - Fixup: removed an unused `import type { ResolvedCliqAccount }` from `mentions.ts` flagged by `noUnusedLocals`.

### What is done in this run (iteration 4)
- Implemented DM allowlist enforcement / admission at the webhook layer (previously unauthorized DMs were dispatched silently; the `security.dm` policy was defined on the plugin but never enforced at ingress).
  - Added `src/admission.ts` with `resolveCliqDmPolicy`, `isCliqSenderAllowed`, and `resolveCliqDmAdmission`. Reuses the SDK's shared `isNormalizedSenderAllowed` from `openclaw/plugin-sdk/allow-from` so wildcard (`*`), case-insensitive, and empty-list semantics match every other bundled channel.
  - Wired `resolveCliqDmAdmission` into the `/cliq/webhook` handler in `index.ts`, after the mention gate and before dispatch: `deny` → log warn + 200; `pairing` → log warn + 200 (pairing flow not yet implemented, placeholder); `allow` → proceed to dispatch.
  - Added `src/admission.test.ts` (22 tests). Total suite is 68/68 passing. Typecheck clean.
- `src/admission.ts` — DM admission decision:
  - `CliqDmPolicy` type (`open` | `allowlist` | `pairing` | `disabled`), aligned with the SDK's `DmPolicy`.
  - `resolveCliqDmPolicy(account)` — returns the effective policy, normalizing whitespace/case; unknown/unset values fall back to `allowlist` (the plugin's `security.dm.defaultPolicy`), i.e. deny-by-default.
  - `isCliqSenderAllowed(senderId, allowFrom)` — thin wrapper around the SDK's `isNormalizedSenderAllowed` (from `openclaw/plugin-sdk/allow-from`): empty allowlist → false, `*` → true, else case-insensitive match.
  - `resolveCliqDmAdmission(parsed, account)` → `{ decision: "allow" | "pairing" | "deny", policy, reason, senderAllowed }`. Groups always `allow` (mention gating handles them). DMs: `open`→allow, `disabled`→deny, `allowlist`→allow iff sender matches else deny, `pairing`→allow iff sender matches else `pairing` decision.
- `src/admission.test.ts` — 22 vitest tests covering policy resolution (4), sender-allowed matcher (7), and the full admission decision across all policies/branches (11). All passing.
- Webhook handler (`index.ts`) now calls `resolveCliqDmAdmission` after the mention gate: `deny` logs a `warn` and returns 200 (silent drop, no longer silent); `pairing` logs a `warn` and returns 200 (pairing flow not yet implemented — placeholder); `allow` proceeds to dispatch.

### What is still missing / incomplete
- **Dispatch adapter wiring is UNVERIFIED against a live gateway.** `dispatchCliqInbound` constructs an `AssembledChannelTurn` and calls `runtime.channel.inbound.run` using best-effort shapes inferred from the installed `.d.ts` + the IBIZDigital reference repo (which used the older `core.channel.*` surface). The exact argument shapes for `resolveAgentRoute`, `finalizeInboundContext`, `formatAgentEnvelope`, `dispatchReplyWithBufferedBlockDispatcher`, and `recordInboundSession` need runtime integration testing against a real OpenClaw gateway. The pure functions (parse, verify, mention-gate) are fully unit-tested; the dispatch glue is not.
- **No pairing flow** — `pairing` adapter not implemented (DM approval flow for new contacts). DM allowlist deny currently just drops the message silently. *(Partly resolved in iteration 4 — the webhook handler now evaluates the DM policy and emits an `allow`/`pairing`/`deny` decision via `resolveCliqDmAdmission`; `deny` logs a warning instead of being silent. The actual `pairing` adapter (approval flow + pairing store integration) is still not implemented — when policy is `pairing` and the sender is unknown, the handler logs + drops as a placeholder.)
- **No media/file sending** — `sendMedia` not implemented; capabilities.media is false.
- **No `mentions` adapter** on the plugin object (stripRegexes/stripMentions for stripping the bot @handle from the agent-visible text). Mention detection is currently inbound-only via `resolveCliqMentionDecision`. *(Resolved in iteration 3 — see above.)*
- **No Markdown→Cliq formatting** — outbound sends raw text.
- **No typing/heartbeat indicators.**
- **No real Zoho Cliq API integration tests** (would need credentials / mocked fetch).
- **No `runtime-api.ts` / runtime store** for token caching across requests (currently each send mints a client; token cache is per-client-instance). The webhook handler creates a fresh `CliqClient` per inbound dispatch.
- **setup wizard not implemented** — only `applyAccountConfig`; no interactive `setupWizard`.
- **CLI subcommands not implemented** — only a stub `cliq` command descriptor.
- **No `src/channel.test.ts` coverage for outbound sendText** (requires mocking global fetch).
- **Self-message detection is naive** — matches `senderId === account.botId` or `senderName === account.botName`. Zoho bot self-events may need a more robust check.

### Next logical step
Implement the **pairing flow** so that `pairing`-policy DMs from unknown senders kick off the documented pairing approval flow (invite/pair reply + pairing-store entry) instead of being logged + dropped as a placeholder. This requires wiring the `pairing` adapter on `cliqPlugin` (currently absent) and integrating the SDK's pairing-store helpers (`UpsertChannelPairingRequestForAccount`, `ReadChannelAllowFromStoreForAccount`) seen in `types-D7eu8baG.d.ts`. Alternatively, build a runtime-mock test for `dispatchCliqInbound` to verify the inbound dispatch wiring against the `runtime.channel.inbound.run` surface before the next feature work.

### Insights / blockers
- The installed `openclaw@2026.6.11` `runtime.channel` surface (in `types-D7eu8baG.d.ts` around line 7093) exposes `text`, `reply` (incl. `dispatchReplyWithBufferedBlockDispatcher`, `finalizeInboundContext`, `formatAgentEnvelope`, `resolveEnvelopeFormatOptions`), `routing.resolveAgentRoute`, `session.*` (resolveStorePath, readSessionUpdatedAt, recordSessionMetaFromInbound, recordInboundSession, updateLastRoute), `mentions.*`, and `inbound.{run,buildContext,dispatchReply,runPreparedReply}`. The IBIZDigital repo used the same surface under the older `core.channel.*` alias and the legacy dispatch path (`dispatchReplyWithBufferedBlockDispatcher` + `finalizeInboundContext`), which is still present and is what `inbound.run` orchestrates under the hood.
- `createChatChannelPlugin` (in `node_modules/openclaw/dist/core-CBhRRoge.d.ts:225`) only accepts `{ base, security, pairing, threading, outbound }`. Any other `ChannelPlugin` field — including `mentions`, `commands`, `lifecycle`, `groups`, `heartbeat`, etc. — must be placed on `base` (the `ChatChannelPluginBase` is `Omit<ChannelPlugin, "security" | "pairing" | "threading" | "outbound"> & Partial<Pick<...>>`). Putting `mentions` at the top level of the `createChatChannelPlugin` params is silently dropped (the resulting plugin object has `mentions: undefined`).
- The core `stripMentions(text, ctx, cfg, agentId)` helper (`node_modules/openclaw/dist/mentions-B1EJNjZS.js:166`) calls the provider plugin's `mentions.stripRegexes({ctx,cfg,agentId})` to obtain regexes, applies them, then also calls `mentions.stripMentions({text,ctx,cfg,agentId})` for custom stripping. So implementing `stripRegexes` is sufficient for the SDK's shared path; `stripMentions` is an optional override. We expose both for robustness and for direct unit testing.
- A `g`-flagged `RegExp` is **stateful** between `.test()` calls: `lastIndex` advances and the next call continues from there, yielding false negatives. `buildCliqMentionRegexes` returns fresh `g`-flagged regexes; `stripCliqMentions` resets `re.lastIndex = 0` before each `replace` (which is safe since `replace` does not advance `lastIndex` anyway, but defensive). Unit tests that call `.test()` repeatedly on the same regex must reset `lastIndex` between calls.
- `resolveInboundMentionDecision` accepts either a flat params object or a nested `{ facts, policy }` object; the nested form is preferred per the docs. For DMs we force `wasMentioned: true` (a DM is always directed at the bot); for groups we require an explicit mention unless `requireMention` is relaxed.
- The Deluge payload is inconsistent: `message` can be a plain string or `{ text, id, time }`; channel info can live under `payload.channel`, `payload.chat.channel_unique_name`, or be inferable from `chat.type === "channel"` / `chat.title`. `parseCliqWebhookPayload` tolerates all of these and unwraps a wrapped `params` object some Deluge configs send.
- DM vs group detection: a chat id with a `-B` suffix indicates a bot DM (per IBIZDigital API notes), but we currently rely on `chat.type === "channel"` / presence of channel fields for group detection rather than the suffix, which is more robust to Cliq's inconsistent payloads.
- `ChannelOutboundContext` has `cfg`, `to`, `text`, `accountId` — no `account` or `chatType`. Outbound sendText must resolve the account from `cfg` + `accountId`.
- Reference repos (IBIZDigital, bernesto) were not fetched this run; consult them next iteration for the Zoho Cliq webhook payload shape and Deluge script conventions.

### History
- 2026-07-04 (iteration 1): Set up project foundation — package.json, manifest, tsconfig, entry points, minimal channel plugin scaffold with config/setup/security/threading/outbound adapters, CliqClient with OAuth token refresh, 11 passing tests. Typecheck clean.
- 2026-07-04 (iteration 2): Implemented inbound webhook path — payload parsing, secret verification, mention gating via `resolveInboundMentionDecision`, dispatch via `runtime.channel.inbound.run`. Replaced stub `/cliq/webhook` handler. Added `src/inbound.ts` + `src/inbound.test.ts` (19 tests). Total 30/30 tests passing, typecheck clean. Dispatch adapter wiring still needs live-gateway verification.
- 2026-07-04 (iteration 3): Implemented the `mentions` adapter — added `src/mentions.ts` (`buildCliqMentionRegexes`, `stripCliqMentions`), wired `mentions` onto `cliqPlugin.base` (exposing `stripRegexes`/`stripPatterns`/`stripMentions` with safe account resolution), and stripped the bot @handle from the agent-visible envelope in `dispatchCliqInbound`. Added `src/mentions.test.ts` (16 tests). Total 46/46 tests passing, typecheck clean.
- 2026-07-04 (iteration 4): Implemented DM allowlist enforcement at the webhook layer — added `src/admission.ts` (`resolveCliqDmPolicy`, `isCliqSenderAllowed`, `resolveCliqDmAdmission`) reusing the SDK's `isNormalizedSenderAllowed` from `openclaw/plugin-sdk/allow-from`, wired the admission decision into the `/cliq/webhook` handler (deny/pairing log + 200; allow proceeds), added `src/admission.test.ts` (22 tests). Total 68/68 tests passing, typecheck clean. The pairing *flow* itself is still a placeholder.
