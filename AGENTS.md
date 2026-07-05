# AGENTS.md — openclaw-cliq

## Vision

We are building a **native OpenClaw Channel Plugin for Zoho Cliq**. The goal is a plugin that behaves exactly like the built-in channels (`@openclaw/discord`, `@openclaw/telegram`, `@openclaw/slack`) — receiving messages via webhook, responding as a bot, supporting DMs and channel mentions, conversation tracking, and automatic OAuth token refresh.

This plugin will be published publicly on [ClawHub](https://clawhub.ai) and npm as the canonical Zoho Cliq channel for OpenClaw. We are the maintainers.

## What we are building

An OpenClaw channel plugin (TypeScript, ESM) that:

- Registers via `defineChannelPluginEntry` from `openclaw/plugin-sdk/channel-core`
- Receives incoming messages (mentions + DMs) through a webhook endpoint registered with `api.registerHttpRoute`
- Sends outbound messages as the bot via the Zoho Cliq REST API
- Handles OAuth 2.0 with automatic token refresh (client_credentials grant, EU endpoint)
- Verifies webhook requests with a shared secret
- Supports conversation tracking for follow-up messages
- Converts Markdown to Cliq's native formatting
- Follows the `ChannelPlugin` adapter surface from the OpenClaw Plugin SDK

## Reference Repos

These two existing community plugins are the primary reference material. Study their structure, borrow patterns, but write everything from scratch:

1. **IBIZDigital/openclaw-cliq-channel** — https://github.com/IBIZDigital/openclaw-cliq-channel
   - Simple, functional approach. Webhook receive, bot respond, token refresh.
   - Good for understanding the basic Zoho Cliq API interaction.

2. **bernesto/openclaw-cliq-plugin** — https://github.com/bernesto/openclaw-cliq-plugin
   - Advanced. Bot-per-agent mapping, Markdown→Cliq formatting, draft streaming, multi-message chunking, self-relay, rate limiting, group chat support, guardrails.
   - Good for understanding advanced channel plugin features.

## OpenClaw Plugin SDK

This plugin uses the official OpenClaw Plugin SDK. Key imports:

```typescript
import { defineChannelPluginEntry } from "openclaw/plugin-sdk/channel-core";
import { createChatChannelPlugin, createChannelPluginBase } from "openclaw/plugin-sdk/channel-core";
```

### Official documentation

- **Building plugins (Getting Started):** https://docs.openclaw.ai/plugins/building-plugins
- **Building channel plugins (main guide):** https://docs.openclaw.ai/plugins/sdk-channel-plugins
- **Channel outbound API (send path):** https://docs.openclaw.ai/plugins/sdk-channel-outbound
- **Channel inbound API (receive path):** https://docs.openclaw.ai/plugins/sdk-channel-inbound
- **Plugin manifest reference:** https://docs.openclaw.ai/plugins/manifest
- **Plugin SDK overview (import map):** https://docs.openclaw.ai/plugins/sdk-overview
- **Plugin testing:** https://docs.openclaw.ai/plugins/sdk-testing

### Bundled channel plugins to study

The best reference for how a real channel plugin works is the **Telegram channel** (bundled in OpenClaw core). It handles DMs, groups, mentions, pairing, webhook + long polling, markdown, and reply threading.

- **Telegram channel docs:** https://docs.openclaw.ai/channels/telegram
- **Discord channel docs:** https://docs.openclaw.ai/channels/discord
- **Slack channel docs:** https://docs.openclaw.ai/channels/slack

If you have access to the OpenClaw source (e.g. installed via npm), study the bundled channel implementations at:
`/usr/lib/node_modules/openclaw/dist/` — look for `channel-*.js` files and the `channel-catalog.json` for the full list of bundled channels.

The Telegram channel is the closest analog to what we are building: it uses a bot token, receives messages via webhook/polling, responds as a bot, supports DMs and groups, and has mention gating. Study it carefully.

### Required file structure

```
openclaw-cliq/
├── package.json              # npm + openclaw channel metadata
├── openclaw.plugin.json      # Plugin manifest with config schema
├── index.ts                  # Entry point (defineChannelPluginEntry)
├── setup-entry.ts            # Setup entry (defineSetupPluginEntry)
├── src/
│   ├── channel.ts            # ChannelPlugin via createChatChannelPlugin
│   ├── client.ts             # Zoho Cliq API client
│   └── channel.test.ts       # Tests
└── .github/                  # Coding agent infrastructure
```

### Key SDK surfaces to implement

- `defineChannelPluginEntry` — entry point with `id`, `plugin`, `registerCliMetadata`, `registerFull`
- `createChatChannelPlugin` — builds the channel plugin with:
  - `base` (via `createChannelPluginBase`) — `id`, `setup.resolveAccount`, `setup.inspectAccount`
  - `security.dm` — DM policy, allowlists
  - `pairing` — DM approval flow
  - `threading` — reply-to mode
  - `outbound` — `sendText`, `sendMedia`
- `api.registerHttpRoute` in `registerFull` — webhook endpoint with `path`, `auth`, `handler`

### package.json must include

```json
{
  "name": "@sprintcx/openclaw-cliq",
  "version": "0.1.0",
  "type": "module",
  "openclaw": {
    "extensions": ["./index.ts"],
    "setupEntry": "./setup-entry.ts",
    "channel": {
      "id": "cliq",
      "label": "Zoho Cliq",
      "blurb": "Connect OpenClaw to Zoho Cliq."
    },
    "compat": {
      "pluginApi": ">=2026.6.6",
      "minGatewayVersion": "2026.6.6"
    }
  }
}
```

### openclaw.plugin.json must include

```json
{
  "id": "cliq",
  "kind": "channel",
  "channels": ["cliq"],
  "name": "Zoho Cliq",
  "description": "Zoho Cliq channel plugin for OpenClaw",
  "configSchema": { "type": "object", "additionalProperties": false, "properties": {} },
  "channelConfigs": {
    "cliq": {
      "schema": {
        "type": "object",
        "additionalProperties": false,
        "properties": {
          "clientId": { "type": "string" },
          "clientSecret": { "type": "string" },
          "botId": { "type": "string" },
          "botName": { "type": "string" },
          "webhookSecret": { "type": "string" },
          "allowFrom": { "type": "array", "items": { "type": "string" } }
        }
      }
    }
  }
}
```

## Zoho Cliq API specifics

- **EU endpoint:** `accounts.zoho.eu` for OAuth, `cliq.zoho.eu` for API calls (NOT `.com`)
- **OAuth grant:** `client_credentials` (no refresh token needed, plugin fetches new access token on expiry)
- **Scopes:** `ZohoCliq.Webhooks.CREATE` (bot DMs), `ZohoCliq.Channels.UPDATE` (channel posts via channelsbyname), `ZohoCliq.Channels.READ`, `ZohoCliq.Users.READ`, `ZohoCliq.Messages.UPDATE` (edit in place)
- **Webhook:** Deluge script in the Cliq Bot handler sends POST to our endpoint with `x-cliq-webhook-secret` header
- **Bot responses:** DMs POST to `https://cliq.zoho.eu/api/v2/bots/{bot_unique_name}/message` with `userids`; channel posts POST to `https://cliq.zoho.eu/api/v2/channelsbyname/{channel_unique_name}/message?bot_unique_name={bot_unique_name}` (the bot-message endpoint rejects `chatid` — see issue #26)
- **Message limit:** Cliq has a 5000 character limit per message (need chunking)

## Coding conventions

- **TypeScript ESM modules** (`"type": "module"`)
- **No unused imports** — keep it clean
- **Error handling** — every API call wrapped in try/catch with meaningful error messages
- **Sensible defaults** — webhook secret is optional but recommended
- **Tests** — colocated `*.test.ts` files, use `vitest`
- **Commit style** — conventional commits (`feat:`, `fix:`, `refactor:`, `docs:`, `test:`, `chore:`)

## How this repo works (Iterative Development)

This project is developed **iteratively** by an autonomous coding agent (OpenCode via GitHub Actions). The human defines the **goal** (the Vision above); the agent evolves the **plan** and the code, one increment per run.

### The two working files

- **AGENTS.md** (this file) — the constitution: goal, conventions, SDK reference, and the **Learnings** section below (durable, hard-won knowledge — SDK quirks and gotchas). Stable; grows slowly. Learnings are timeless facts about the world, NOT a record of what was done.
- **ROADMAP.md** — the single living worklist and north star: the feature-parity target vs the bundled Telegram/Discord channels, organized into priority phases. It holds **only open work**.

**No file records the past.** The repo's tracked files describe only the future (ROADMAP) and the timeless (AGENTS.md). History — what was done, when, why — lives entirely in git: `git log`, closed issues, and the verify-bot's issue comments. Never write a changelog, "State", "Done", or per-run log into any tracked file.

**The ROADMAP's one hard rule: every line describes only FUTURE work.** Finishing an item means removing the finished work: delete the line if you finished it entirely; if you finished only part, either delete it and add a fresh item for the remainder, or rewrite the line down to just the remaining work. Editing a line to narrow its scope is fine — but never leave a "X now works"/"implemented"/"done" status clause, never `[x]`, never strike through, never a "Done"/"History"/"State" section. git remembers what was removed (`git log -p ROADMAP.md`).

### How to work an issue

1. Read `ROADMAP.md` (what's left), skim the existing code (what exists), and check recent `git log` (what just changed).
2. Decide the scope **from the issue**:
   - If it names a concrete task or bug → do exactly that.
   - If it is empty or just says "iterate" / "next step" → take the **top open item of the highest open phase** in ROADMAP.md.
3. Implement one coherent increment, with tests where applicable.
4. **Update ROADMAP.md, keeping every line future-tense:** delete the line(s) you finished; for a partially-finished item, either delete it and add a fresh item for what remains, or rewrite it down to just the remaining work (no "X now works" status clause). Add newly discovered work to the right phase. Do NOT record what you did anywhere in the file.
5. Record any lasting *technical* insight (SDK quirks, gotchas) in the **Learnings** section of this file (AGENTS.md) — again, facts about the world, not "what I did".
6. Run `npx tsc --noEmit`, `npm test`, and `npm run smoke:gateway` and make them all pass — a CI **hard gate** blocks the push if any fails.
7. Commit the code + the ROADMAP edit with a conventional-commit message ending in `Closes #N`. **Do NOT push** — the workflow pushes after the hard gate re-runs typecheck + tests + smoke, and the issue closes automatically via `Closes #N`. That commit, plus the verify-bot's comment, is the history record.

### Verifying your work

- **Unit tests** (`npm test`) cover pure logic. Run them.
- **`npm run smoke:gateway` is the source of truth for loading/registration.** It builds the plugin and loads it into a REAL OpenClaw gateway runtime (isolated throwaway profile, no daemon/Zoho/secrets), then asserts the plugin status is `loaded` and it registers a `channel` capability. Whenever you touch the entry, manifest, channel registration, or anything load-related, run this and make it pass. **Do not declare loading/registration "verified" by reading `.d.ts` files — run the smoke.** (The older mock-based `load.test.ts` proves the route handler; the smoke proves the real loader accepts our shapes.)
- The smoke covers **Stage 3** (load + capability registration). It does NOT yet cover **Stage 4** (a real inbound webhook POST dispatched through the agent pipeline) or **Stage 5** (a real Zoho Cliq round-trip — needs credentials, inherently a staging/manual step).

### Important

- **One coherent increment per run.** Do not try to build everything at once.
- **Be honest about unfinished work.** If something is half-done or broken, capture the remaining work as an open ROADMAP item (or an issue), not as a prose "status" note.
- **No history in tracked files.** ROADMAP holds only open work; done = delete the line. Everything about the past goes in git and issues.
- **Read the OpenClaw Plugin SDK docs** at https://docs.openclaw.ai/plugins/sdk-channel-plugins and https://docs.openclaw.ai/plugins/building-plugins. Also study the Telegram channel docs at https://docs.openclaw.ai/channels/telegram — it is the closest reference implementation.
- **Check the reference repos** for patterns, but write original code.

## Learnings (durable)

Hard-won knowledge from previous iterations. Add to this section (deduped) whenever you learn something with lasting value — SDK quirks, non-obvious API shapes, pitfalls. This is the memory that keeps the agent from re-deriving the same things.

### OpenClaw Plugin SDK

- **Setup wizard (`setupWizard` adapter).** Lives on `ChannelPlugin` and is forwarded by `createChatChannelPlugin` (it picks up `setupWizard` from `base` via `CreatedChannelPluginBase`'s `Partial<Pick<…,"setupWizard"…>>`). The field accepts either a declarative `ChannelSetupWizard` or an imperative `ChannelSetupWizardAdapter`; the declarative form is consumed by the generic setup adapter and is far less code. Import surface is `openclaw/plugin-sdk/setup`, which re-exports everything needed: `createStandardChannelSetupStatus`, `createTopLevelChannelDmPolicy`/`createNestedChannelDmPolicy`, `createAccountScopedAllowFromSection`, `createAccountScopedGroupAccessSection`, `setSetupChannelEnabled`, `patchChannelConfigForAccount`, `parseMentionOrPrefixedId`, `mergeAllowFromEntries`, `splitSetupEntries`, `resolveEntriesWithOptionalToken`, `DEFAULT_ACCOUNT_ID`, plus the `ChannelSetupWizard`/`ChannelSetupDmPolicy`/`WizardPrompter`/`OpenClawConfig` types. `ChannelSetupWizardFinalize` is NOT exported — type the finalize hook as `NonNullable<ChannelSetupWizard["finalize"]>`.
- **`ChannelSetupInput` has a FIXED key set** (`token`, `secret`, `botToken`, `appToken`, `userId`, `url`, `webhookPath`, `cliPath`, … — see `types.core-DF7IXShG.d.ts:134`); there is no index signature, so a credential's `inputKey: keyof ChannelSetupInput` cannot be a channel-specific name like `clientId`. Channels with custom/extra credentials sidestep this by setting `credentials: []` and doing all prompting in `finalize` (the MS Teams pattern in `setup-surface-DP-Q3K7p.js`): `finalize({ cfg, prompter, ... })` shows an intro `note`, calls `prompter.text`/`confirm` for each field (with keep-existing + env-var-shortcut logic), patches `channels.<id>` directly, and returns `{ cfg, accountId }`. This keeps the declarative `status`/`dmPolicy`/`disable` sections while owning credential collection imperatively. `prompter.text({ message, placeholder, initialValue?, validate?, sensitive? })` returns `Promise<string>`; `prompter.confirm({ message, initialValue? })` returns `Promise<boolean>`; `prompter.note(message, title?)` returns `Promise<void>`.
- **`createTopLevelChannelDmPolicy`** builds a `ChannelSetupDmPolicy` from `{ label, channel, policyKey, allowFromKey, getCurrent, promptAllowFrom?, getAllowFrom? }` — it constructs `setPolicy` internally from `policyKey`/`allowFromKey`, so you do NOT pass `setPolicy`. `getCurrent` must return one of `"pairing" | "allowlist" | "open" | "disabled"`. For single-account channels with config at the top level (`channels.<id>.dmPolicy`/`.allowFrom`), this is the right helper; `createNestedChannelDmPolicy` is for per-account sections under `channels.<id>.accounts.<acct>`.

- **`directory` adapter** is forwarded by `createChatChannelPlugin` (it does `{ ...params.base, ... }`), so place `directory` on `base` — NOT on the top-level params (which only accept `base/security/pairing/threading/outbound`). `createChannelDirectoryAdapter` is exported from `openclaw/plugin-sdk/directory-runtime` (NOT `channel-core`); it takes `{ self?, listPeers?, listGroups?, listPeersLive?, listGroupsLive?, listGroupMembers? }` and returns a `ChannelDirectoryAdapter`. The list callbacks receive `{ cfg, accountId?, query?, limit?, runtime }` where `runtime` is the SDK's `RuntimeEnv` (we don't need it — cast to `never` in tests). `ChannelDirectoryEntry`/`ChannelDirectoryEntryKind` (`"user" | "group" | "channel"`) are also re-exported from `directory-runtime`. The adapter is a read-only convenience surface: it must NEVER throw — degrade API failures to an empty list so `openclaw directory` doesn't crash.

- **Channel status adapter** (`status` field on `ChannelPlugin`): use `createComputedAccountStatusAdapter` from `openclaw/plugin-sdk/status-helpers`. It takes `Omit<ChannelStatusAdapter,…,"buildAccountSnapshot"> & { resolveAccountSnapshot }` and returns a full `ChannelStatusAdapter` whose public surface is `buildAccountSnapshot` (NOT `resolveAccountSnapshot` — that's consumed internally and not exposed on the result). `resolveAccountSnapshot` returns `{ accountId, name, enabled, configured, extra }`; the `extra` object is *spread* onto the snapshot (so `extra.botId` becomes `snapshot.botId`), and `probe` is merged from the `probe` param by `buildComputedAccountStatusSnapshot`. So tests must read `botId`/`probe` at the top level of the returned snapshot, not under `extra`. The `ChannelAccountSnapshot`/`ChannelStatusAdapter`/`ChannelStatusIssue` types are exported from `openclaw/plugin-sdk/channel-contract` (NOT `channel-core`); `OpenClawConfig` comes from `channel-core`. The adapter's `Probe` generic flows only when the plugin is declared with that generic — `cliqPlugin` must be `createChatChannelPlugin<ResolvedCliqAccount, CliqStatusProbe>({...})` (and the explicit `ChannelPlugin<ResolvedCliqAccount>` annotation must be dropped), otherwise `status` widens `Probe=unknown` and `probeAccount`'s typed return is rejected as contravariant.
- **Account inspect adapter** (`config.inspectAccount`, paired with the bundled `account-inspect-api.ts` surface). The bundled Telegram/Discord `inspectAccount` returns `{ accountId, enabled, name?, token, tokenSource, tokenStatus, configured, config }`. Cliq has no single bot token (it uses `client_credentials` OAuth with `clientId`+`clientSecret`), so the inspect output reports `tokenStatus` for the **`clientSecret`** (the grant secret) and adds the OAuth `scopes`, the hard-coded EU `apiBase`/`oauthBase`, and bot identity (`botId`/`name`). **Never expose secret values** in `inspectAccount` output — `clientSecret`/`webhookSecret` must be presence-only booleans (or omitted); the inspect output is consumed by `openclaw channels inspect` / `openclaw configure` which render it to operators, so a leaked secret in the snapshot is a real exposure. `accountId` should be normalized to `"default"` (not `null`) to match the status adapter's `DEFAULT_ACCOUNT_ID` convention. `inspectAccount` must never throw — a partially-configured account reports `configured: false` with per-field presence flags, not an error (the bundled `inspectTelegramAccount` resolves defensively and returns `{ configured: false }` for missing token files). The inspect module lives at `src/account-inspect.ts` (mirroring the SDK's `account-inspect-api.ts` bundle name).

- **Inbound idempotency primitive:** `createClaimableDedupe` is exported from `openclaw/plugin-sdk/persistent-dedupe` (NOT from `channel-core`). It exposes `claim/commit/release/hasRecent/forget/clearMemory/memorySize` with claim/commit/release (in-flight ownership) semantics — the same primitive the bundled Zalo (`monitor.webhook`) and Nextcloud Talk channels use for webhook replay protection. Pass ONLY `{ ttlMs, memoryMaxSize }` (no `pluginId`/`stateMaxEntries`/`resolveFilePath`) for **memory-only** mode; passing any of those opts into the SQLite-backed plugin-state store, which needs `OPENCLAW_STATE_DIR`. `claim(key)` → `{kind:"claimed"|"duplicate"|"inflight", pending?}`: it records an in-flight entry on `"claimed"` that is only cleared by a matching `commit`/`release`. **`clearMemory()` does NOT clear the in-flight `Map`** — only `commit`/`release`/`forget` per-key do — so a test reset must recreate the guard (null the singleton), not just call `clearMemory()`. There is also a simpler `createDedupeCache`/`resolveGlobalDedupeCache` exported from `openclaw/plugin-sdk/core` for TTL/LRU `check(key)`-only dedupe (no in-flight ownership).
- **Message-action adapter** (`actions` on `ChannelPlugin`): the `ChannelMessageActionAdapter` type + its `ChannelMessageActionContext`/`ChannelMessageActionDiscoveryContext`/`ChannelMessageActionName`/`ChannelMessageToolDiscovery` are exported from `openclaw/plugin-sdk/channel-contract` (NOT `channel-core`); `AgentToolResult` comes from `openclaw/plugin-sdk/agent-core`. The adapter lives on `base` (forwarded by `createChatChannelPlugin`'s `{ ...params.base, ... }`) — NOT on the top-level params (which only accept `base/security/pairing/threading/outbound`). `describeMessageTool({ cfg, accountId })` returns `null` to HIDE the shared `message` tool entirely for an unconfigured channel (the Discord pattern); a non-null discovery with `actions: []` keeps it visible but actionless. The canonical action names live in `CHANNEL_MESSAGE_ACTION_NAMES` (`types.core-DF7IXShG.d.ts:18`) — `send`, `edit`, `delete`, `unsend`, `read`, `react`, `pin`, …; `supportsAction`/`resolveExecutionMode` are optional but useful for the discovery surface. `handleAction(ctx)` returns `Promise<AgentToolResult<unknown>>` whose shape is `{ content: [{ type: "text", text }], details }` — it must NEVER throw; convert every failure into a `details: { status: "failed", error: <msg> }` result so the model can recover (retry / give up) rather than crashing the tool call. The shared `message` tool params convention (cross-channel, from the Discord runtime): `to`/`channelId`/`target` for the destination, `message` for text content, `messageId` for edit/delete, `limit`/`before`/`after` for `read`. The Cliq chat-message edit/delete/read APIs key off a `chat_id` (`CT_xxx`), NOT off a channel unique name or user id — channel chat ids are resolvable once via `CliqClient.resolveChannelChatId` (cached), but DM chat ids are per-user-pair and CANNOT be resolved from a bare user id without a prior send, so the adapter must require an explicit `chatId` param for DM edits/deletes/reads and surface a helpful error when it's missing.
- **`createChatChannelPlugin` only accepts `{ base, security, pairing, threading, outbound }`** (`node_modules/openclaw/dist/core-CBhRRoge.d.ts:225`). Any other `ChannelPlugin` field — `mentions`, `commands`, `lifecycle`, `groups`, `heartbeat`, etc. — must go on `base` (it is `Omit<ChannelPlugin, "security"|"pairing"|"threading"|"outbound"> & Partial<Pick<…>>`). Putting `mentions` at the top level is silently dropped.
- **`agentPrompt` adapter** (`ChannelAgentPromptAdapter`, type exported from `openclaw/plugin-sdk/channel-runtime` — NOT `channel-core`/`channel-contract`). It lives on `base` (forwarded by `createChatChannelPlugin`'s `{ ...params.base, ... }`). Four surfaces: `messageToolHints({cfg,accountId})=>string[]` (appended as bullet lines under the shared `message` tool section of the system prompt — start each line with `"- "`), `messageToolCapabilities({cfg,accountId})=>string[]|undefined` (capability strings gating prompt blocks; only `inlineButtons` and `richText` are consumed — `richText` is a Telegram-specific Bot-API 10.1 rich-text term, NOT a generic "markdown supported" flag, so non-Telegram channels should NOT advertise it; return `[]` truthfully when neither applies), `inboundFormattingHints({accountId})=>{text_markup, rules}|undefined` (emitted as the trusted `response_format` object in the inbound-metadata block via `get-reply`'s `resolveInboundFormattingHints` — no bundled channel currently populates it, but the resolver is wired), and `reactionGuidance({cfg,accountId})=>{level:"minimal"|"extensive", channelLabel?}|undefined` (emits a `## Reactions` system-prompt section; return `undefined` to suppress). The runtime consumes these via `getLoadedChannelPluginById(id)?.agentPrompt?.<surface>` so the adapter must be on the loaded plugin (i.e. on `base`).
- **Durable-before-ack for webhook channels is NOT exposed via `createChatChannelPlugin`.** The `ChannelMessageReceiveAdapterShape` (`receive.defaultAckPolicy` / `supportedAckPolicies`, values `"after_receive_record" | "after_agent_dispatch" | "after_durable_send" | "manual"`) lives on a separate `ChannelMessageAdapterShape.receive` facet that `createChannelPluginBase` does NOT forward (it has a fixed field list: `id, meta, setupWizard, capabilities, commands, doctor, agentPrompt, streaming, reload, gatewayMethods, gatewayMethodDescriptors, configSchema, config, security, groups, setup`). That `receive` adapter is only wired by the bundled channels (Telegram/LINE/…) via their own `createChannelMessageAdapterFromOutbound` path. So a plugin-channel webhook handler must implement ack timing itself: `await runtime.channel.inbound.run(...)` before writing the HTTP 200, and return 5xx on dispatch failure so the platform redelivers. Telegram's own `defaultAckPolicy: "after_agent_dispatch"` confirms awaiting full dispatch is the intended durable semantics.
- **`createChatChannelPlugin` converts inline option forms into adapters.** `outbound: { base, attachedResults: { sendText } }` → a `ChannelOutboundAdapter` whose `sendText(ctx)` calls your `attachedResults.sendText` and spreads `{ channel, ...result }` (`core-D-xoNfL6.js:188`). So the test/call surface is `plugin.outbound.sendText(ctx)`, not the nested `attachedResults` shape. Same pattern for `security`, `threading`, and `pairing`.
- **`pairing` option** accepts a raw `ChannelPairingAdapter` or `{ text: { idLabel, message, normalizeAllowEntry?, notify } }`; the latter is converted via `createInlineTextPairingAdapter` (`core-D-xoNfL6.js:227`), so the resolved `plugin.pairing` exposes `idLabel`/`message`/`notify` directly (NOT under `text`).
- **`ChannelOutboundContext` has only `cfg`, `to`, `text`, `accountId`** — no `account`, no `chatType`. Outbound must resolve the account from `cfg` + `accountId`, and cannot tell DM from channel (defaults to `chatid`). The inbound dispatch path DOES know chat type and passes `isDm` correctly.
- **Outbound DM-vs-channel routing (issue #11):** because `ChannelOutboundContext` has no `chatType`, the ONLY way for the outbound `sendText`/`sendMedia` to know DM vs group is to encode it in the `ctx.to` prefix. The inbound path builds `To: cliq:<responseTarget>`; make `responseTarget` chat-type-aware: `user:<senderId>` for DMs, `chat:<chatId>`/`channel:<channelUniqueName>` for groups. The outbound path then runs `normalizeCliqRouteTarget(ctx.to)` to strip the `cliq:<kind>:` prefix and set `isDm` (`user`/`dm` → DM via `userids`; anything else → group via `chatid`). A bare id with no `cliq:` prefix defaults to group (backward compat with raw ids). Without this, `CliqClient.sendMessage` defaults to `chatid` and the agent reply silently never lands in the Cliq DM even though OAuth + bot credentials are valid.
- **`runtime.channel` surface** (`types-D7eu8baG.d.ts:~7093`): `text`, `reply` (incl. `dispatchReplyWithBufferedBlockDispatcher`, `finalizeInboundContext`, `formatAgentEnvelope`, `resolveEnvelopeFormatOptions`), `routing.resolveAgentRoute`, `session.*`, `mentions.*`, `inbound.{run,buildContext,dispatchReply,runPreparedReply}`. `inbound.run` orchestrates the legacy dispatch path under the hood.
- **Pairing runtime** lives on `runtime.channel.pairing` (`types-D7eu8baG.d.ts:7070`): `upsertPairingRequest({channel,id,accountId,meta?,…})` → `{ code, created }` (`created=false` = a pending request already existed → idempotent, do not re-reply); `buildPairingReply({channel,idLine,code})` → the standard access-not-configured reply text.
- **Mention stripping:** the core `stripMentions` helper (`mentions-B1EJNjZS.js:166`) calls the plugin's `mentions.stripRegexes(...)` then `mentions.stripMentions(...)`. Implementing `stripRegexes` is sufficient for the shared path; `stripMentions` is an optional override.
- **`resolveInboundMentionDecision`** accepts a flat params object or a nested `{ facts, policy }`; the nested form is preferred. For DMs force `wasMentioned: true`; for groups require an explicit mention.
- **DM admission:** reuse the SDK's `isNormalizedSenderAllowed` from `openclaw/plugin-sdk/allow-from` so wildcard (`*`), case-insensitive and empty-list semantics match every other channel.

### Webhook security

- **Channel doctor adapter** (`doctor` on `ChannelPlugin`): the type is `ChannelDoctorAdapter` exported from `openclaw/plugin-sdk/channel-contract` (NOT `channel-core`). The adapter is spread onto the plugin by `createChatChannelPlugin` (it does `{ ...params.base, ... }`), so put `doctor` on `base`. The doctor framework (`channel-doctor-CMYyQK45.js`) only forwards keys it recognizes: function keys (`normalizeCompatibilityConfig`, `collectPreviewWarnings`, `collectMutableAllowlistWarnings`, `repairConfig`, `runConfigSequence`, `cleanStaleConfig`, `collectEmptyAllowlistExtraWarnings`, `shouldSkipDefaultEmptyGroupAllowlistWarning`), boolean keys (`groupAllowFromFallbackToAllowFrom`, `warnOnEmptyGroupSenderAllowlist`), enum keys (`dmAllowFromMode ∈ {topOnly,topOrNested,nestedOnly}`, `groupModel ∈ {sender,route,hybrid}`), and `legacyConfigRules` (array). Any other key is silently dropped. `collectPreviewWarnings` / `collectMutableAllowlistWarnings` are async-capable (doctor awaits them); they receive `{ cfg, doctorFixCommand, env? }` and must return `string[]` (each line typically prefixed `- channels.<id>:`). doctor only calls them for channels present in `cfg.channels` (so no section = no call); a plugin whose section is absent should also return `[]` defensively. `dmAllowFromMode: "topOnly"` tells doctor the DM allowlist lives only at the top-level `channels.cliq.allowFrom` (no per-account nesting). Cliq has no separate group-sender allowlist (group admission is gated by the mention requirement), so `shouldSkipDefaultEmptyGroupAllowlistWarning: () => true` suppresses the misleading default warning. The doctor adapters are merged across read-only / loaded / bundled plugins, first-defined wins per key.

- **Webhook secret verification must be constant-time + single-header.** `crypto.timingSafeEqual` requires equal-length buffers; on a length mismatch run a dummy `timingSafeEqual(b, b)` so the wall-clock cost stays roughly constant (avoids an early-return timing signal). Accept ONLY `x-cliq-webhook-secret` — honoring `Authorization`/`x-webhook-secret` as fallbacks widens the attack surface (a misconfigured proxy forwarding one of them bypasses the check). The Deluge handler is documented to send exactly `x-cliq-webhook-secret`.
- **Failed-auth rate limiting must be scoped to the 401 path only.** A per-IP fixed window that is consulted (and `hit()`) only when verification fails can never throttle legitimate Cliq delivery, even under a flood of valid webhooks. Process-local is fine for single-gateway deployments; multi-replica would need a shared store (Redis), out of scope.
- **Every denied request carries `Connection: close`.** This tears down the keep-alive socket after the response so a denied attacker cannot reuse the connection for rapid retries. Set the header on both 401 and 429 paths.

### Gateway smoke / real-loader verification

- **The plugin loads on a real gateway (verified against openclaw@2026.6.11).** `plugins inspect cliq --json --runtime` reports `status: "loaded"`, `shape: "plain-capability"`, and a `capabilities: [{ kind: "channel", channelIds: [...] }]` entry; `plugins doctor` reports "No plugin issues detected". The loader resolves the entry from `package.json` `main` → `dist/index.js` (NOT the manifest `openclaw.extensions` `./index.ts`), so **`dist/` must be built before install** — the smoke builds first.
- **Outbound send logging has no direct runtime access from `CliqClient`.** The gateway exposes `api.logger` (`PluginLogger`: `debug?`, `info`, `warn`, `error` — all `(message: string) => void`) only to `registerFull`/`registerCliMetadata`. The outbound `sendText` adapter and the inbound `deliver`/live-edit paths resolve their `CliqClient` through `CliqClientRegistry` (`resolveCliqClient`), so the bridge is: `registerFull` calls `getCliqClientRegistry().setLogger(api.logger)` once at startup; the registry threads that logger into every lazily-created `CliqClient`. `CliqClient` itself takes an optional `logger` constructor arg (last, after `retryOptions`) and falls back to a console-backed default (`setCliqDefaultLogger`/`getCliqDefaultLogger`) so a directly-constructed client (tests, CLI tooling) is never invisible. Never log the OAuth access token, `clientSecret`, or webhook secret — only target kind (`dm`/`channel`) + resolved id + text *length* (never the text), HTTP status, message id, and on error the response body truncated via `truncateForLog`.
- **CLI commands that matter** (all headless, no running daemon needed): `openclaw --profile <p> plugins install . --link` (links a local plugin dir; `--force` is rejected with `--link`), `plugins inspect <id> --json --runtime` (loads the runtime — the real registration test), `plugins list --json` (`--enabled`/`--verbose`), `plugins doctor`.
- **State isolation is mandatory when running against a box that has a real `~/.openclaw`.** On first run of a NEW profile, openclaw migrates legacy state (e.g. `exec-approvals.json`) out of the default profile into the new one, mutating `~/.openclaw`. The smoke sets a throwaway `HOME` + `OPENCLAW_STATE_DIR` + `OPENCLAW_CONFIG_PATH` so it can never touch a real profile. In ephemeral CI there is no `~/.openclaw`, so this is belt-and-suspenders there, but essential on a dev/prod host.
- **`openclaw` is BOTH a `peerDependency` (runtime: the gateway provides it) AND a `devDependency` (so `npm ci` installs the CLI + SDK types for typecheck/tests/smoke).** A root package's `peerDependencies` are NOT auto-installed by npm; relying on the lockfile alone is fragile. The devDependency guarantees `node_modules/.bin/openclaw` exists for the smoke.

- **`openclaw/plugin-sdk/compat` is DEPRECATED** (`OPENCLAW_PLUGIN_SDK_COMPAT_DEPRECATED` warning emitted on import unless `VITEST=true` or `OPENCLAW_SUPPRESS_PLUGIN_SDK_COMPAT_WARNING=1`). The message says "External plugins may keep compat temporarily while migrating" — it's a warning, not a load failure (smoke still passes), but it pollutes the gateway log. Prefer the focused subpaths. For group-policy helpers, `openclaw/plugin-sdk/channel-policy` exports `resolveChannelGroupRequireMention`, `resolveChannelGroupToolsPolicy`, `resolveChannelGroupPolicy`, `resolveToolsBySender`, and the `GroupToolPolicyConfig`/`GroupToolPolicyBySenderConfig`/`ChannelGroupPolicy` types — note `openclaw/plugin-sdk/config-runtime` exports `resolveChannelGroupRequireMention` + `resolveChannelGroupPolicy` but NOT `resolveChannelGroupToolsPolicy`, so `channel-policy` is the right focused subpath when you need the tool-policy resolver.

- **`groups` adapter (`ChannelGroupAdapter`) wiring.** The type is `ChannelGroupAdapter` (exported from `openclaw/plugin-sdk/channel-runtime`, NOT `channel-core`/`channel-contract`); `ChannelGroupContext` is exported from both `channel-runtime` and `channel-contract`. The adapter lives on `base` (forwarded by `createChatChannelPlugin`'s `{ ...params.base, ... }`) — NOT on the top-level params. `resolveRequireMention(params)` → `boolean | undefined` (return `undefined` to let the runtime default apply); `resolveToolPolicy(params)` → `GroupToolPolicyConfig | undefined`. The runtime calls `plugin.groups?.resolveRequireMention?.({ cfg, groupId, groupChannel, groupSpace, accountId })` from `get-reply`'s `resolveGroupRequireMention`, where `groupId` is derived from `ctx.From` via `extractExplicitGroupId` (with `groupChannel`/`groupSpace` from `ctx.GroupChannel`/`ctx.GroupSubject` as fallbacks).

- **Inbound `From` convention: it is the originating CONVERSATION id, not the sender.** For group messages the bundled channels (Zalo `zalouser:group:<chatId>`, Telegram, etc.) set `From: <channel>:group:<groupId>`; for DMs `From: <channel>:<senderId>`. The sender goes in `SenderId`/`SenderName`. `extractExplicitGroupId("cliq:group:dev-team")` returns `"dev-team"` (the `channel:group:<id>` / `group:<id>` / `channel:<id>` shapes are recognized by `extractSimpleExplicitGroupId`). `shouldUseFromAsSenderFallback` returns `false` for any non-`direct` `ChatType`, so using a group id in `From` for group messages is safe — the DM-allowlist sender fallback only applies when `ChatType === "direct"` (or unset), so group allowlist matching keeps using `SenderId`. A plugin channel that leaves `From: <channel>:<senderId>` for group messages will have its `groups` adapter called with the *sender* id as `groupId`, breaking per-group config lookup — always set `From` to the group id for group turns and also fill `GroupChannel`/`GroupSubject` for Deluge payloads that omit a stable id.

### Build / TypeScript

- **TS2742 on declaration emit:** `defineChannelPluginEntry` returns `DefinedChannelPluginEntry<TPlugin>`, whose member types come from internal SDK modules that cannot be named portably; emitting a `.d.ts` for `index.ts`'s default export triggers `TS2742`. The type is not re-exported from any public SDK entry, so there is nothing portable to annotate with. Fix: `declaration:false` in `tsconfig.build.json`. Safe, because the gateway loads plugins via the `openclaw.extensions` manifest field (`./index.ts`, resolved with tsx) — never via `main`/`types`, so no `.d.ts` is consumed. Source maps are still emitted.
- **`.gitignore` ignores `*.js`** (TS-sources-only policy). A `scripts/*.js` build smoke would be gitignored — use `.mjs` (gitignore `*.js` matches only names ending exactly in `.js`).
- **The installed SDK differs from the docs:** `resolveAccount`/`inspectAccount` live on `config: ChannelConfigAdapter`, NOT on `setup` (which holds `applyAccountConfig`). The docs example is outdated relative to the installed version.

### Zoho Cliq specifics

- **`CliqClient.getAccessToken` caches per-scope.** The original implementation cached a single `accessToken`/`tokenExpiresAt` pair and ignored the `scope` argument on cache hits — so the first call (`ZohoCliq.Webhooks.CREATE`) would be returned verbatim for a later `ZohoCliq.Users.READ` directory call, silently using the wrong-scope token. The cache is now a `Map<scope, {token,expiresAt}>`. When adding any new Cliq REST surface that needs a different scope (directory reads, future reactions/actions), pass the scope explicitly to `getAccessToken` — it will mint + cache a separate token per scope.
- **Cliq directory endpoints:** `GET /api/v2/users` (scope `ZohoCliq.Users.READ`) returns `{ users: [...] }`; `GET /api/v2/channels` (scope `ZohoCliq.Channels.READ`) returns `{ channels: [...] }`. Pagination via `from` (offset) + `limit` query params, max page size 200. Field names are inconsistent across API versions: user id is `id` OR `user_id`; user name needs `first_name`+`last_name` joined (fall back to `display_name`/`name`/`email`); channel id is `id` OR `channel_id`; channel name is `display_name`/`name`/`unique_name` (the `unique_name` is the handle bots target as `cliq:channel:<unique_name>`). Parse defensively and skip records with no resolvable id.

- **Cliq message edit API:** `PUT /api/v2/chats/{chat_id}/messages/{message_id}` with body `{ text }` (text already `markdownToCliq`-converted by the caller). This is the **chat-messages** API, NOT the bot-message API — it requires the `ZohoCliq.Messages.UPDATE` scope (separate from `ZohoCliq.Webhooks.CREATE`), so `CliqClient.editMessage` mints + caches a per-scope token via `getAccessToken("ZohoCliq.Messages.UPDATE")`. The bot-message *send* response is inconsistent: channel posts return a top-level `{ id }`, bot DMs return `{ message_details: { "<userId>": { chat_id, message_id } } }`. `parseCliqMessageRef` extracts `messageId`/`chatId` from both shapes (plus top-level `message_id`/`chat_id` for the edit response). The chat id needed for an edit is NOT always in the send response for channel posts — the bernesto reference repo fetches recent messages (`GET /api/v2/chats/{chatId}/messages`) to resolve it.
- **Cliq bot→channel send uses the channelsbyname endpoint, NOT the bot-message endpoint (issue #26).** `POST /api/v2/bots/{botId}/message` accepts `userids` (DMs) but REJECTS `chatid` with `{"code":"extra_key_found","message":"'chatid' is an extra key in the JSON Object."}`. Channel posts must go to `POST /api/v2/channelsbyname/{channel_unique_name}/message?bot_unique_name={botId}` with body `{ text }` (no `chatid`/`userids` key) and the `ZohoCliq.Channels.UPDATE` scope (separate from `ZohoCliq.Webhooks.CREATE`). The bot identity is supplied as a `bot_unique_name` QUERY PARAM, not a body field. The `to` for a non-DM send MUST be the channel unique name (it's in the URL path) — the inbound `responseTarget` therefore prefers `channel:<channelUniqueName>` over `chat:<chatId>`. Media uploads to a channel use the same URL with a `multipart/form-data` body (`text` + `attachments`, no `chatid`/`userids`). The bot must be a participant of the target channel or Cliq rejects the post. Pattern confirmed in the bernesto reference repo (`src/api.ts:sendCliqChannelMessage`).
- **`client_credentials` CANNOT obtain a usable token for `ZohoCliq.Channels.UPDATE` or `ZohoCliq.Messages.UPDATE`** (issue #27, confirmed empirically on a live org). Zoho *issues* a token whose response reports the scope, but `POST /api/v2/channelsbyname/{name}/message` and `PUT /api/v2/chats/{chatId}/messages/{messageId}` reject it with `{"code":"oauthtoken_scope_invalid","message":"The OAuth token passed does not have the required scope."}`. Only bot DMs (`ZohoCliq.Webhooks.CREATE`) work via `client_credentials`. Channel posts + message edits require a **user-context refresh token** obtained once via the self-client `authorization_code` flow (scopes `ZohoCliq.Webhooks.CREATE ZohoCliq.Channels.UPDATE ZohoCliq.Messages.UPDATE` consented together); the plugin mints short-lived access tokens from it via `grant_type=refresh_token` and caches them as a single shared entry (NOT per-scope — a refresh-token access token carries all consented scopes, so the cache key is a fixed marker like `__refresh_token__`, and the request MUST NOT include a `scope` param). `CliqClient` routes the channel-send and edit paths through `getRefreshedAccessToken()` when `refreshToken` is configured, and falls back to `client_credentials` when it is not (DM-only setups keep working; channel posts/edits will fail at the API with `oauthtoken_scope_invalid`). The refresh token does not expire (unless revoked) — it is a one-time exchange stored in config as `refreshToken`.
- **Plugin-channel streaming previews are block-streaming, not live-edit-in-place.** The SDK's `ChannelStreamingAdapter` only carries `blockStreamingCoalesceDefaults: { minChars, idleMs }` (consumed by `resolveBlockStreamingCoalescing` → `getChannelPlugin(id)?.streaming?.blockStreamingCoalesceDefaults`); `ChannelCapabilities.blockStreaming: true` advertises it. The runtime then coalesces agent output into progressive **separate** messages via the outbound `sendText` (the `onBlockReply` path in `dispatch`/`get-reply`). The live-edit-in-place streaming (editing a single message as the draft grows) is a bundled-channel feature — Telegram/Discord own their `editMessage*` runtime functions and call them directly from their bot/message-handler loops; that edit hook is NOT exposed to plugin channels through `createChatChannelPlugin` (which only accepts `base/security/pairing/threading/outbound`). So a plugin channel's achievable streaming preview is block streaming; live-edit would require intercepting partial replies in our own dispatch loop (bernesto's `draft-stream.ts` does this outside the SDK dispatcher). The plugin-channel `deliver` callback passed to `dispatchReplyWithBufferedBlockDispatcher` IS that interception point: it receives one delta block per coalesced flush, so a stateful deliver (tracking `{messageId, chatId, accumulated}` across calls within one turn) implements block-granularity edit-in-place (send on first block, edit on subsequent, overflow to a new draft at the char cap). Per-token live-edit remains unexposed. Block streaming is enabled per-agent via `agents.defaults.blockStreamingDefault: "on"` OR via `replyOptions.disableBlockStreaming: false` (the bundled Nextcloud Talk plugin channel reads `account.config.blockStreaming` and passes it through `dispatchReplyFromConfig`'s `replyOptions`).

- **Inbound `deliver` must chunk against the 5000-char cap.** The buffered block dispatcher calls `deliver` once per coalesced block; when block streaming is OFF (default) it delivers the ENTIRE final agent reply as a single `deliver` call. A `deliver` that sends `payload.text` verbatim (one `sendMessage`) will be rejected by the Cliq API for any reply over 5000 chars. The deliver callback (live-edit or legacy) must `chunkMessage` the rich text before sending.
- **Cliq has NO bot "typing" REST API.** Bots can only post messages; unlike Telegram (`sendChatAction`) there is no `typing` chat-action endpoint. So a channel plugin's `heartbeat.sendTyping` cannot produce a real "typing…" cue. Two consequences: (1) with the default `ackPolicy: "after_dispatch"`, Cliq's OWN native "bot is processing" indicator already covers the UX while the agent works, because the Deluge handler is still awaiting our HTTP response — so the visible typing cue comes for free from the un-acked request, not from `sendTyping`; (2) `heartbeat.sendTyping` is best implemented as a token pre-warm (call `CliqClient.getAccessToken`, which is cached) so the first real reply after an idle gap doesn't pay the OAuth round-trip, with failures swallowed (typing must never break an agent turn). The `heartbeat` adapter (`checkReady` + `sendTyping` + `clearTyping`) lives on `base` and is spread onto the plugin by `createChatChannelPlugin` (it does `{ ...params.base, ... }`, so *every* base field — `heartbeat`, `mentions`, etc. — is forwarded, not just the fixed list `createChannelPluginBase` picks). The heartbeat runner reads `plugin.heartbeat?.sendTyping` / `?.checkReady` directly (`heartbeat-runner-*.js`).
- **Cliq does not expose a reliable `is_bot` flag on the webhook sender.** Unlike Telegram/Discord/Slack (`author.bot` / `bot_id` / `sender.type=BOT`), a Cliq Deluge webhook payload's `user` object has no bot discriminator. So bot-loop protection cannot rely on the SDK's `botLoopProtection` pair-loop guard (which needs *both* participant bot ids); the plugin-channel webhook handler must filter self/other-bot senders itself, by id, before dispatch. The configured `botId` (bot unique name used in the API URL) is always treated as self, `botName` too, and operators add the bot's *zuid* (Zoho user id, which is what `user.id` reports when the bot's own outgoing messages re-trigger the webhook) plus any other Cliq bots to ignore via the `selfSenderIds` config field. Matching is case-insensitive + trimmed across `senderId`/`senderName`/`senderEmail`.

- **Cliq Markdown delimiters** (confirmed via the bernesto reference repo's `format.ts`): `*bold*` (single asterisk = bold, NOT italic), `_italic_` (single underscore), `~strike~` (single tilde), `__underline__` (double underscore), `` `inline` `` (renders bold-red, not monospace), ` ```block``` `, `!blockquote` (line prefix), `#`/`###` headings, `[text](url)`, `---` rule.
- **Bold-before-italic pitfall:** converting `**bold**`→`*bold*` and then `*italic*`→`_italic_` makes the italic pass eat the just-emitted `*bold*`. Fix: emit bold through NUL-delimited placeholders restored to `*…*` only *after* the italic pass (same technique the bernesto converter uses). Protect fenced/inline code with placeholders too.
- **Cliq reactions API** (`/api/v2/chats/{chatId}/messages/{messageId}/reactions`): POST body `{ emoji_code }` adds, DELETE body `{ emoji_code }` removes, GET lists. The scope prefix is **lowercase `messageactions`** — `ZohoCliq.messageactions.CREATE` (add + delete share the CREATE scope) and `ZohoCliq.messageactions.READ` (list). This lowercase prefix is unusual vs the other Cliq scopes (`Webhooks`/`Channels`/`Messages`) but is what the REST docs publish and what the API expects verbatim. Like `Channels.UPDATE`/`Messages.UPDATE`, `messageactions.CREATE` is a user-context scope the `client_credentials` grant cannot obtain a usable token for, so the reaction path routes through the refresh-token grant (same as channel posts + edits). The `emoji_code` accepts both Zomoji shortcodes (`:smile:`) and unicode chars (`😄`) verbatim — no normalization needed. Plugin-channel reaction *notifications* (inbound) require the SDK's `ChannelMessagingAdapter`/`InboundEventKind` surface, which `createChatChannelPlugin` does NOT forward (only `base/security/pairing/threading/outbound`), so inbound reaction events are not achievable from a plugin channel today; only outbound agent-driven reactions (the `react` message-action) are.
- **Group/channel chat-id resolution for live-edit (issue #28):** a channel bot post (`POST /api/v2/channelsbyname/{name}/message`) returns only a top-level `{ id }` (the message id) — the chat id (`CT_xxx`) the chat-message edit API (`PUT /api/v2/chats/{chatId}/messages/{messageId}`) needs is NOT in the response. Using the channel unique name as the chat id for edits fails (`PUT /api/v2/chats/dev-team/messages/...` is rejected). Resolve the chat id once via `GET /api/v2/channelsbyname/{name}` (scope `ZohoCliq.Channels.READ`, `client_credentials` is fine — reading channel metadata is permitted) and cache it per `CliqClient` (a channel's chat id is stable for its lifetime; cache positives only — negatives may be transient as a channel can be created later). The response is a top-level channel record OR wrapped under `{ channel: {...} }` (varies by API version), and the chat id field is `chat_id` / `id` / `channel_id`. When an edit with the resolved chat id STILL fails, recover the canonical editable ref via `GET /api/v2/chats/{chatId}/messages?from=0&limit=50` (the bernesto reference pattern) — the bot-message send `id` is not always the same as the chat-message `message_id` the edit API expects; matching `messageId` in the recent-messages list yields the canonical `chat_id` to retry the edit with. Reading chat messages needs a user-context token (the refresh-token grant), same constraint as channel posts + edits — `listChatMessages` throws when no `refreshToken` is configured; the live-edit caller wraps it in try/catch and degrades to a new message so a missing/failed recovery never breaks an agent turn.
- **Deluge payload is inconsistent:** `message` can be a string or `{text,id,time}`; channel info lives under `payload.channel`, `payload.chat.channel_unique_name`, or is inferable from `chat.type==="channel"`/`chat.title`; some configs wrap everything in `params`. `parseCliqWebhookPayload` tolerates all of these. A `-B` suffix on a chat id indicates a bot DM, but group detection via `chat.type==="channel"` is more robust than the suffix.
- **Deluge webhook must POST raw JSON with `body: payload.toString()` + `Content-Type: application/json`.** Using `parameters: payload.toString()` sends form-urlencoded and returns HTTP 400 (`readJsonBody` has a form-urlencoded tolerance fallback, but `body:` is the canonical shape).
- **EU endpoints are hard-coded:** `accounts.zoho.eu` (OAuth), `cliq.zoho.eu` (API). `.com` would require a code change.
- **Cliq bot-message API error envelope is not formally documented**, so classifying a 400 as *format-rejected* (retry plain text) vs *structural* (fatal) is heuristic. Treat 401/403/404 as fatal (auth/bot-not-found), 429/5xx as transient (retry with backoff), and 400 by body pattern: structural markers (`chatid not found`, `invalid userids`, `missing required field`) → fatal; format markers (`invalid markdown`, `unsupported format`, `character not allowed`) → fall back rich→plain once; an unmatched 400 defaults to format_rejected (conservative — try plain before giving up). See `src/send-retry.ts`.
- **`Retry-After` must be honored verbatim** even when it exceeds the jitter `maxDelayMs`. The server's directive is authoritative for rate-limit backoff; `maxDelayMs` only caps the exponential-with-jitter path (used when there is no `Retry-After`). `parseRetryAfterMs` already caps the header at 60s, so `computeBackoffMs` returns it unmodified.

### General pitfalls

- **Node `Buffer` pool + `Blob`:** `Buffer.from("short")` is a *view* into Node's shared 8 KB pool. `new Blob([view])` is fine, but `new Uint8Array(buffer.buffer)` captures the whole 8192-byte pool (adjacent unrelated bytes) → spurious deep-equality failures in tests. Copy the view's bytes into a fresh `Uint8Array(byteLength)` before building a `Blob` or asserting on bytes.
- **`g`-flagged `RegExp` is stateful:** `lastIndex` advances between `.test()` calls, causing false negatives. Reset `re.lastIndex = 0` before reuse; `.replace` does not advance it, but be defensive.

## Target audience

This plugin will be used by:
1. **SprintCX internal agents** (Zora on Smart Bridges server, etc.)
2. **External OpenClaw users** who want Zoho Cliq as a channel
3. **ClawHub users** discovering the plugin via search

The plugin must be self-contained, well-documented, and easy to configure via `openclaw.json`.
