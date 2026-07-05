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
- **Scopes:** `ZohoCliq.Webhooks.CREATE`, `ZohoCliq.Channels.READ`, `ZohoCliq.Users.READ`
- **Webhook:** Deluge script in the Cliq Bot handler sends POST to our endpoint with `x-cliq-webhook-secret` header
- **Bot responses:** POST to `https://cliq.zoho.eu/api/v2/bots/{bot_unique_name}/message` with `userids` for DMs or `chatid` for channels
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

**The ROADMAP's one hard rule: finishing an item means DELETING its line.** Never mark `[x]`, never strike through, never add a "Done"/"History" section. git remembers what was removed (`git log -p ROADMAP.md`).

### How to work an issue

1. Read `ROADMAP.md` (what's left), skim the existing code (what exists), and check recent `git log` (what just changed).
2. Decide the scope **from the issue**:
   - If it names a concrete task or bug → do exactly that.
   - If it is empty or just says "iterate" / "next step" → take the **top open item of the highest open phase** in ROADMAP.md.
3. Implement one coherent increment, with tests where applicable.
4. **Update ROADMAP.md by editing open work only:** delete the line(s) you completed, add any newly discovered work to the right phase, reorder if priorities shifted. Do NOT record what you did anywhere in the file.
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

- **Inbound idempotency primitive:** `createClaimableDedupe` is exported from `openclaw/plugin-sdk/persistent-dedupe` (NOT from `channel-core`). It exposes `claim/commit/release/hasRecent/forget/clearMemory/memorySize` with claim/commit/release (in-flight ownership) semantics — the same primitive the bundled Zalo (`monitor.webhook`) and Nextcloud Talk channels use for webhook replay protection. Pass ONLY `{ ttlMs, memoryMaxSize }` (no `pluginId`/`stateMaxEntries`/`resolveFilePath`) for **memory-only** mode; passing any of those opts into the SQLite-backed plugin-state store, which needs `OPENCLAW_STATE_DIR`. `claim(key)` → `{kind:"claimed"|"duplicate"|"inflight", pending?}`: it records an in-flight entry on `"claimed"` that is only cleared by a matching `commit`/`release`. **`clearMemory()` does NOT clear the in-flight `Map`** — only `commit`/`release`/`forget` per-key do — so a test reset must recreate the guard (null the singleton), not just call `clearMemory()`. There is also a simpler `createDedupeCache`/`resolveGlobalDedupeCache` exported from `openclaw/plugin-sdk/core` for TTL/LRU `check(key)`-only dedupe (no in-flight ownership).
- **`createChatChannelPlugin` only accepts `{ base, security, pairing, threading, outbound }`** (`node_modules/openclaw/dist/core-CBhRRoge.d.ts:225`). Any other `ChannelPlugin` field — `mentions`, `commands`, `lifecycle`, `groups`, `heartbeat`, etc. — must go on `base` (it is `Omit<ChannelPlugin, "security"|"pairing"|"threading"|"outbound"> & Partial<Pick<…>>`). Putting `mentions` at the top level is silently dropped.
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

### Gateway smoke / real-loader verification

- **The plugin loads on a real gateway (verified against openclaw@2026.6.11).** `plugins inspect cliq --json --runtime` reports `status: "loaded"`, `shape: "plain-capability"`, and a `capabilities: [{ kind: "channel", channelIds: [...] }]` entry; `plugins doctor` reports "No plugin issues detected". The loader resolves the entry from `package.json` `main` → `dist/index.js` (NOT the manifest `openclaw.extensions` `./index.ts`), so **`dist/` must be built before install** — the smoke builds first.
- **CLI commands that matter** (all headless, no running daemon needed): `openclaw --profile <p> plugins install . --link` (links a local plugin dir; `--force` is rejected with `--link`), `plugins inspect <id> --json --runtime` (loads the runtime — the real registration test), `plugins list --json` (`--enabled`/`--verbose`), `plugins doctor`.
- **State isolation is mandatory when running against a box that has a real `~/.openclaw`.** On first run of a NEW profile, openclaw migrates legacy state (e.g. `exec-approvals.json`) out of the default profile into the new one, mutating `~/.openclaw`. The smoke sets a throwaway `HOME` + `OPENCLAW_STATE_DIR` + `OPENCLAW_CONFIG_PATH` so it can never touch a real profile. In ephemeral CI there is no `~/.openclaw`, so this is belt-and-suspenders there, but essential on a dev/prod host.
- **`openclaw` is BOTH a `peerDependency` (runtime: the gateway provides it) AND a `devDependency` (so `npm ci` installs the CLI + SDK types for typecheck/tests/smoke).** A root package's `peerDependencies` are NOT auto-installed by npm; relying on the lockfile alone is fragile. The devDependency guarantees `node_modules/.bin/openclaw` exists for the smoke.

### Build / TypeScript

- **TS2742 on declaration emit:** `defineChannelPluginEntry` returns `DefinedChannelPluginEntry<TPlugin>`, whose member types come from internal SDK modules that cannot be named portably; emitting a `.d.ts` for `index.ts`'s default export triggers `TS2742`. The type is not re-exported from any public SDK entry, so there is nothing portable to annotate with. Fix: `declaration:false` in `tsconfig.build.json`. Safe, because the gateway loads plugins via the `openclaw.extensions` manifest field (`./index.ts`, resolved with tsx) — never via `main`/`types`, so no `.d.ts` is consumed. Source maps are still emitted.
- **`.gitignore` ignores `*.js`** (TS-sources-only policy). A `scripts/*.js` build smoke would be gitignored — use `.mjs` (gitignore `*.js` matches only names ending exactly in `.js`).
- **The installed SDK differs from the docs:** `resolveAccount`/`inspectAccount` live on `config: ChannelConfigAdapter`, NOT on `setup` (which holds `applyAccountConfig`). The docs example is outdated relative to the installed version.

### Zoho Cliq specifics

- **Cliq does not expose a reliable `is_bot` flag on the webhook sender.** Unlike Telegram/Discord/Slack (`author.bot` / `bot_id` / `sender.type=BOT`), a Cliq Deluge webhook payload's `user` object has no bot discriminator. So bot-loop protection cannot rely on the SDK's `botLoopProtection` pair-loop guard (which needs *both* participant bot ids); the plugin-channel webhook handler must filter self/other-bot senders itself, by id, before dispatch. The configured `botId` (bot unique name used in the API URL) is always treated as self, `botName` too, and operators add the bot's *zuid* (Zoho user id, which is what `user.id` reports when the bot's own outgoing messages re-trigger the webhook) plus any other Cliq bots to ignore via the `selfSenderIds` config field. Matching is case-insensitive + trimmed across `senderId`/`senderName`/`senderEmail`.

- **Cliq Markdown delimiters** (confirmed via the bernesto reference repo's `format.ts`): `*bold*` (single asterisk = bold, NOT italic), `_italic_` (single underscore), `~strike~` (single tilde), `__underline__` (double underscore), `` `inline` `` (renders bold-red, not monospace), ` ```block``` `, `!blockquote` (line prefix), `#`/`###` headings, `[text](url)`, `---` rule.
- **Bold-before-italic pitfall:** converting `**bold**`→`*bold*` and then `*italic*`→`_italic_` makes the italic pass eat the just-emitted `*bold*`. Fix: emit bold through NUL-delimited placeholders restored to `*…*` only *after* the italic pass (same technique the bernesto converter uses). Protect fenced/inline code with placeholders too.
- **Deluge payload is inconsistent:** `message` can be a string or `{text,id,time}`; channel info lives under `payload.channel`, `payload.chat.channel_unique_name`, or is inferable from `chat.type==="channel"`/`chat.title`; some configs wrap everything in `params`. `parseCliqWebhookPayload` tolerates all of these. A `-B` suffix on a chat id indicates a bot DM, but group detection via `chat.type==="channel"` is more robust than the suffix.
- **Deluge webhook must POST raw JSON with `body: payload.toString()` + `Content-Type: application/json`.** Using `parameters: payload.toString()` sends form-urlencoded and returns HTTP 400 (`readJsonBody` has a form-urlencoded tolerance fallback, but `body:` is the canonical shape).
- **EU endpoints are hard-coded:** `accounts.zoho.eu` (OAuth), `cliq.zoho.eu` (API). `.com` would require a code change.

### General pitfalls

- **Node `Buffer` pool + `Blob`:** `Buffer.from("short")` is a *view* into Node's shared 8 KB pool. `new Blob([view])` is fine, but `new Uint8Array(buffer.buffer)` captures the whole 8192-byte pool (adjacent unrelated bytes) → spurious deep-equality failures in tests. Copy the view's bytes into a fresh `Uint8Array(byteLength)` before building a `Blob` or asserting on bytes.
- **`g`-flagged `RegExp` is stateful:** `lastIndex` advances between `.test()` calls, causing false negatives. Reset `re.lastIndex = 0` before reuse; `.replace` does not advance it, but be defensive.

## Target audience

This plugin will be used by:
1. **SprintCX internal agents** (Zora on Smart Bridges server, etc.)
2. **External OpenClaw users** who want Zoho Cliq as a channel
3. **ClawHub users** discovering the plugin via search

The plugin must be self-contained, well-documented, and easy to configure via `openclaw.json`.
