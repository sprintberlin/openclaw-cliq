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

- **AGENTS.md** (this file) — the constitution: goal, conventions, SDK reference, and a pointer to the Learnings (durable, hard-won knowledge — SDK quirks and gotchas — now stored as one file per fact under `docs/learnings/`, catalogued in `docs/learnings/INDEX.md`). Stable; grows slowly. Learnings are timeless facts about the world, NOT a record of what was done.
- **ROADMAP.md** — the single living worklist and north star: the feature-parity target vs the bundled Telegram/Discord channels, organized into priority phases. It holds **only open work**.

**No file records the past.** The repo's tracked files describe only the future (ROADMAP) and the timeless (AGENTS.md). History — what was done, when, why — lives entirely in git: `git log`, closed issues, and the verify-bot's issue comments. Never write a changelog, "State", "Done", or per-run log into any tracked file.

**The ROADMAP's one hard rule: every line describes only FUTURE work.** Finishing an item means removing the finished work: delete the line if you finished it entirely; if you finished only part, either delete it and add a fresh item for the remainder, or rewrite the line down to just the remaining work. Editing a line to narrow its scope is fine — but never leave a "X now works"/"implemented"/"done" status clause, never `[x]`, never strike through, never a "Done"/"History"/"State" section. git remembers what was removed (`git log -p ROADMAP.md`).

### How to work an issue

1. Read `ROADMAP.md` (what's left), skim the existing code (what exists), and check recent `git log` (what just changed).
2. Decide the scope **from the issue**:
   - If it names a concrete task or bug → do exactly that.
   - If it is empty or just says "iterate" / "next step" → take the **top open item of the highest open phase** in ROADMAP.md.
3. Implement one coherent increment, with tests where applicable. **For any user-facing change** (a new config field, a new behavior, a new required OAuth scope, a new command, a new capability), also update `README.md` (setup / config / feature docs — e.g. add a new scope to BOTH the §3b scope table and the §3c scope string) AND add a `CHANGELOG.md` `[Unreleased]` entry. The ClawHub publish workflow turns that CHANGELOG section into the release notes, so an undocumented user-facing change ships invisibly — and a new scope silently fails for users who never consented to it.
4. **Update ROADMAP.md, keeping every line future-tense:** delete the line(s) you finished; for a partially-finished item, either delete it and add a fresh item for what remains, or rewrite it down to just the remaining work (no "X now works" status clause). Add newly discovered work to the right phase. Do NOT record what you did anywhere in the file.
5. If you learned a lasting *technical* insight (SDK quirk, gotcha), record it as **at most one** new file under `docs/learnings/<slug>.md` (frontmatter with `title` + `files:` / `apis:` grep anchors, then a 2–4 sentence fact) and add one line to `docs/learnings/INDEX.md`. Check the INDEX first — do not duplicate an existing entry. Facts about the world, not "what I did". See the "Learnings (durable)" section below.
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

Durable, hard-won knowledge (SDK quirks, non-obvious API shapes, pitfalls) lives in
**`docs/learnings/`** — one short file per fact, catalogued in
[`docs/learnings/INDEX.md`](docs/learnings/INDEX.md). Only the index is loaded into a
run's context; you pull the full entries you need on demand. This keeps every run small.

**Before implementing:** skim `docs/learnings/INDEX.md`, then `rg` (ripgrep) inside
`docs/learnings/` for the modules and APIs you are about to touch (the `src/*.ts` file
names, `ZohoCliq.*` scopes, `/api/...` paths) and read the matching entries.

**When you learn something durable:** add **at most one** new file per run —
`docs/learnings/<slug>.md` with frontmatter (`title`, and `files:` / `apis:` grep
anchors) and a 2–4 sentence fact — plus one line in `docs/learnings/INDEX.md`. Check the
INDEX first and do NOT duplicate an existing entry. It must be a timeless fact about the
world, never a record of "what I did".
