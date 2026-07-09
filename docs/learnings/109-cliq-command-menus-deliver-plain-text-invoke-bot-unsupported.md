---
title: Cliq command menus deliver as plain text — the live Cliq API rejects the `invoke.bot` button action
category: Zoho Cliq REST API
files: [src/commands.ts]
apis: [invoke.bot, sendCard, /api/v3/bots/{BOT}/messages, /api/v3/chats/{CHAT_ID}/messages]
issues: [#91]
---

The Cliq `commands` adapter's model-menu builders (`buildModelsMenuChannelData`,
`buildModelsListChannelData`, `buildModelBrowseChannelData`, …) produce
quick-reply cards whose buttons carry `action: "invoke"` / `data: "/model …"` —
rendered by `cliqButtonToV3CardButton` into `{ action: { type: "invoke.bot",
data: { bot_name, message } } }`. `invoke.bot` is the ONLY button action that
re-posts a slash command back to the bot's message handler (the other actions —
`invoke.function` / `open.url` / `system.api` / `preview.url` / `copy` — cannot
post free text back).

**The live Cliq REST API rejects `invoke.bot`.** Verified directly against the
API (2026-07-09, SprintCX org, both `client_credentials` bot token and
`refresh_token` user token):

- a button with `action.type: "invoke.bot"` → HTTP 400
  `input_pattern_mismatch: "Unidentified value passed for the 'type' key"` on
  BOTH the bot-message endpoint (`POST /api/v3/bots/{BOT}/messages`) and the
  chat endpoint (`POST /api/v3/chats/{CHAT_ID}/messages`);
- buttons nested inside a `card` object (`card.buttons`) → HTTP 400
  `extra_key_found: "'buttons' is an extra key in the JSON Object"` (buttons
  must be a **top-level** array, not inside `card`);
- top-level buttons with `action.type: "invoke.function"` DO send: bot endpoint
  → HTTP 200 (as the bot), chat endpoint → HTTP 204;
- a buttonless `card` (`{ card: { theme: "modern-inline", title } }`) sends fine
  on the bot endpoint → HTTP 200.

So an interactive command menu that posts a slash command back to the bot is not
deliverable on this org's Cliq API. Every card send failed (400 `format_rejected`)
→ the thinking placeholder was cleaned up to "⚠️ Couldn't process that message."
even though the native command routing (#91) and the reply text were correct.
The `docs/messagecards` docs list `invoke.bot`, but the live API does not accept
it here (likely an API-version / org-config gap — worth raising with Zoho).

**Fix:** the `cliqCommandsAdapter` wires every model-menu builder to `() => null`,
so the runtime delivers the command's own reply **text** instead — the same
degraded-but-usable path `buildCommandsListChannelData` already used. The reply
text already lists the `/model <provider>/<model>` refs the user types to switch,
so model switching works without the interactive menu. The fully implemented
`buildCliq*ChannelData` builders (and their unit tests) are retained so the menus
can be restored the instant Cliq accepts `invoke.bot` — just point the adapter
fields back at the builders.

Unrelated but observed in the same session: typing `/models` (plural) never
reaches the gateway (zero inbound logs) — intercepted Cliq-/Deluge-side before
OpenClaw, independent of this plugin; and heavy command testing intermittently
stalls the bot's inbound webhook until a gateway restart. Both are outside the
plugin code.
