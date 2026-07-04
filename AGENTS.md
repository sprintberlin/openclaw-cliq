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

This project is developed **iteratively** by an autonomous coding agent (OpenCode via GitHub Actions).

### PROGRESS.md

There is a `PROGRESS.md` file in the repo root. This is the agent's memory between runs.

**Before starting work on any issue:**
1. Read `PROGRESS.md` to understand the current state
2. Read the existing code in the repo to see what's already implemented
3. Decide what the next logical step is

**After completing work on an issue:**
1. Update `PROGRESS.md` with:
   - What was done in this run
   - What is still missing / incomplete
   - What the next logical step should be
   - Any insights, blockers, or things learned
2. Commit the `PROGRESS.md` update along with your code changes

### Issue workflow

When an issue is created or assigned, the coding agent:
1. Reads `AGENTS.md` (this file) for project context and conventions
2. Reads `PROGRESS.md` for current development state
3. Reads the issue for the specific task
4. Examines existing code in the repo
5. Decides on the next increment (may differ from what the issue literally says if a more logical prerequisite exists)
6. Implements the increment
7. Updates `PROGRESS.md`
8. Commits and pushes

### Important

- **Do not try to build everything in one run.** Pick one logical increment, implement it well, update PROGRESS.md, and stop.
- **Be honest in PROGRESS.md.** If something is half-done or broken, say so. The next run needs accurate information.
- **Read the OpenClaw Plugin SDK docs** at https://docs.openclaw.ai/plugins/sdk-channel-plugins and https://docs.openclaw.ai/plugins/building-plugins. Also study the Telegram channel docs at https://docs.openclaw.ai/channels/telegram — it is the closest reference implementation.
- **Check the reference repos** for patterns, but write original code.

## Target audience

This plugin will be used by:
1. **SprintCX internal agents** (Zora on Smart Bridges server, etc.)
2. **External OpenClaw users** who want Zoho Cliq as a channel
3. **ClawHub users** discovering the plugin via search

The plugin must be self-contained, well-documented, and easy to configure via `openclaw.json`.
