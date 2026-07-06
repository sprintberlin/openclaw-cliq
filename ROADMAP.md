# ROADMAP — the single living worklist

> **North star:** make `openclaw-cliq` behave like a first-class OpenClaw channel — as
> reliable and full-featured as the bundled Telegram and Discord channels.
>
> ## The one hard rule
>
> **This file contains ONLY open work, described in the future tense.** Finishing an item means
> removing the finished work from the file: if you finished it entirely, **delete the line**; if
> you finished only part of it, either delete the line and add a fresh item for what remains, or
> **rewrite the line to describe only the remaining work**. Either way is fine — the test is that
> every line still describes *future* work. Never leave a "X now works" / "done" / "implemented"
> status clause, never mark `[x]`, never strike through, never add a "Done" / "Changelog" /
> "History" / "State" section. The past lives in git (`git log`, closed issues, the verify-bot's
> comments), never here. So this file only ever shrinks toward done and grows with new
> discoveries — it always describes the future, never the past.
>
> **Scope note.** Literal parity is not the goal (Telegram is ~205 source files, Discord ~344;
> this plugin is a handful). We are after *functional* parity — correctness, reliability, and the
> features users actually notice.
>
> **How a run picks its next step.** The top open item of the highest open phase is "what's next".
> A run reads this file (what's left) + the code (what exists) + `git log` (what just changed) +
> the triggering issue (what to do now). No separate progress file — that context is reassembled
> fresh each run.
>
> **Phase dependencies.** Phase 1 is v3-independent and ships on the current base. **Phase 2 is the
> v3 foundation**; Phases 3 and 4 build on it (each of their items is tagged *(needs Phase 2)*).
> Phase 5 is mostly v3-independent and can be pulled forward on demand.
>
> **Reference implementations.** The coding-agent runner only checks out **this** repo — it cannot
> read sibling clones on a maintainer's disk. Every reference here is therefore a **fetchable URL**
> (the runner has `bash`/`curl` + web fetch). Study the behavior spec, not someone else's code.
> - **Zoho Cliq platform + REST API** — the authoritative behavior/format spec. Platform hub:
>   <https://www.zoho.com/cliq/help/platform/>. REST API v3: <https://www.zoho.com/cliq/help/restapi/v3/>.
>   Per-item doc links are attached to the items that need them.
> - **OpenClaw first-party channels** — same SDK + conventions, and the actual parity target.
>   Browse `extensions/telegram/` (closest analog; `src/channel.ts` is the adapter wiring),
>   `extensions/discord/` (threads, reactions, actions), and `docs/channels/` in
>   <https://github.com/openclaw/openclaw>.
> - **Prior art** — other Cliq-like channel plugins. **Different projects, their own licenses:
>   study the *approach* only, do NOT copy code — our implementation stays original and MIT.**
>   wecom <https://github.com/sunnoy/openclaw-plugin-wecom>,
>   octo <https://github.com/Mininglamp-OSS/openclaw-channel-octo>,
>   dingtalk <https://github.com/soimy/openclaw-channel-dingtalk>.

---

## Phase 1 — v3-independent UX wins

Small, safe, high-visibility. None of these need the v3 migration, so they ship on the current
base. (The instant-ack placeholder is already in flight — see the open issue.)

## Phase 2 — REST API v3 foundation

The base everything rich builds on. Do this **incrementally**, not as a big-bang rewrite of the
verified-live core.

- **Migrate outbound calls to v3.** Move the send / edit / react / metadata calls off the
  hard-coded `/api/v2/` paths in `src/client.ts` to v3 **one endpoint family per change, keeping
  v2 as a fallback** so the core never regresses in a single large refactor. Channel **text**
  posts, bot **DM** posts, and message **delete** route through their v3 endpoints when
  `apiVersion: "v3"` (v2 default); the remaining endpoint families to migrate:
  - **Channel card / button posts** (`sendCard` non-DM) — v3 has no `buttons` field (moved to
    Message Cards); requires the Phase 3 Message-Card renderer, not a direct swap.
  - **Channel media posts** (`sendMediaMessage` non-DM) — v3 channel post body has no media
    field; needs the v3 attachment / Message-Card image flow.
  - **Message edit / list-by-chat** (`/api/v2/chats/{chatId}/messages…`) — confirmed against the
    v3 OpenAPI / REST docs: v3 Messages has **no** single-message edit or get/list-by-chat
    endpoint (only delete-multiple, post, forward, search), and v3 Chats has no message
    operations at all. The v2 edit + list-chat-messages paths therefore stay v2 indefinitely
    (a v3 dead end — no swap available). The message-delete family was migrated in its own
    increment (v3 bulk-delete with a 1-element `message_ids` list, scope `Messages.DELETE`).
  - **Reactions** (`/api/v2/chats/{chatId}/messages/{messageId}/reactions`) — check the v3
    spec for a reactions equivalent (not visible in the v3 sidebar; may be v2-only).
  - **Directory** (`/api/v2/users`, `/api/v2/channels`) — v3 has no org-user / channel
    directory; `GET /api/v3/chats?type=dm|channel` returns chats (a semantic change: only
    users / channels the bot already has a conversation with), so this is a behavior decision,
    not a clean swap.
  - **File download** (`/api/v2/files/{fileId}`) — check the v3 spec for a files equivalent.
  - **Channel-chat-id resolution** (`GET /api/v2/channelsbyname/{name}`) — v3 has
    `GET /api/v3/chats/{chatId}` (by chat id, not by unique name); the channelsbyname lookup
    may be v2-only.
  Ref: v3 Introduction <https://www.zoho.com/cliq/help/restapi/v3/introduction/>,
  v3 Messages <https://www.zoho.com/cliq/help/restapi/v3/messages/>,
  v3 Chats <https://www.zoho.com/cliq/help/restapi/v3/chats/>.
- **Adopt the v3 conventions the rest of the roadmap depends on:** `PATCH` partial updates (cleaner
  message edits for `src/live-edit.ts`), pagination (`page` / `per_page`) on list calls, and the
  consistent v3 error shape (feeds better error classification, incl. the existing data-center
  hint). Ref: v3 Introduction (same URL).

## Phase 3 — Rich messaging *(needs Phase 2)*

- **Adopt v3 Message Cards.** Render agent output as v3 cards where it improves UX — `modern-inline`
  (header, field sections, action buttons) and `poll` — rather than the current button/card shape
  in `src/presentation.ts`. Ref: Message Cards v3
  <https://www.zoho.com/cliq/help/restapi/v3/messagecards/>.
- **Interactive status card + confirmation for sensitive actions.** Show a live status card
  (thinking → generating → done / failed) during a turn, and gate sensitive/tool actions behind an
  explicit confirm button before executing. Ref: Message Cards v3 + Cliq Bot Handlers (Context
  Handler) <https://www.zoho.com/cliq/help/platform/bothandlers.html>.
- **Cliq Forms for structured input.** Use Cliq Forms for approval / collection flows (pairing
  approval, parameter capture) instead of free-text parsing. Ref: Cliq platform (Form handler)
  <https://www.zoho.com/cliq/help/platform/>.

## Phase 4 — Programmatic Cliq via v3 CRUD *(needs Phase 2)*

v3 adds CRUD endpoints v2 never had (bots, slash commands, message actions, widgets, schedulers).

- **`cliq_management` agent tool.** Expose Cliq operations to the agent as one profile-gated tool:
  post to a channel, list channels / members (paginated GET), resolve users, etc. Ref: REST API v3
  <https://www.zoho.com/cliq/help/restapi/v3/>. (Prior art: octo's single management tool.)
- **Schedulers / proactive messages.** Use the v3 scheduler CRUD to let the agent schedule or
  cancel proactive messages. Ref: REST API v3 (schedulers).
- **Setup-wizard auto-provisioning.** Register the bot, slash-commands, and message-actions via v3
  CRUD from `openclaw setup` instead of the manual Deluge / console steps in today's guide.
  Ref: REST API v3.

## Phase 5 — Scaling & operations

Mostly v3-independent; **dynamic agents** in particular is high-value and can be pulled forward.

- **Dynamic agents + workspace templates.** Route each DM sender and each channel to its own
  isolated agent session and workspace, seeded on first contact from a configurable template
  (`AGENTS.md` and friends). Today all senders share one agent context; per-channel *tool policy*
  exists (`src/group-policy.ts`) but not per-identity *session/workspace* isolation. Use
  deterministic routing keys (e.g. `cliq-dm-<senderId>`, `cliq-group-<channelUniqueName>`) and let
  an explicit OpenClaw `bindings` entry win over dynamic routing. Ref: OpenClaw agent-routing /
  bindings + Telegram/Discord in the monorepo. (Prior art: wecom.)
- **Command allowlist + admin bypass.** Restrict which slash commands non-admin users may run
  (e.g. allow `/help`, `/status`; deny `/model` switching), with an admin list that bypasses the
  gate. cliq enables native commands (`src/commands.ts`) but has no per-user command gate.
  (Prior art: wecom.)
- **Runtime quota / rate-limit awareness.** Track Zoho Cliq API usage locally and warn (logs /
  `openclaw status`) before hitting Zoho's rate limits; pairs naturally with the v3 consistent
  errors from Phase 2. Ref: v3 rate limits
  <https://www.zoho.com/cliq/help/restapi/v3/introduction/>. (Prior art: wecom.)
- **Egress proxy support.** Route outbound API / OAuth requests through a configured proxy for
  locked-down enterprise networks. `apiBase` / `oauthBase` are already configurable, but there is
  no proxy hop. (Prior art: wecom `network.egressProxyUrl`.)
- **`/btw` bypass Q&A.** A side-answer path that bypasses the main session lock so a quick question
  gets an isolated fast reply without disturbing the running conversation. (Prior art: dingtalk.)
- **`write-secret` pattern.** Let a user store a secret (e.g. an API key) into a file by alias
  without ever exposing the plaintext to the model. Build on the existing SecretRef plumbing
  (`src/secret-*.ts`). (Prior art: octo.)
- **`<think>` / reasoning normalization + throttle.** Normalize reasoning-tag variants
  (`<thinking>` / `<thought>` → `<think>`) and throttle streaming-preview edits so live-edit does
  not hammer the Cliq edit API. Builds on `src/live-edit.ts`. (Prior art: wecom.)

---

## Blocked on upstream (not actionable until resolved)

Open work we *want*, gated on an external dependency. Do not pick these in an iterate run —
they cannot be built with the current public SDK. Move an item back into a phase once its
blocker is resolved.

- **Inbound reaction notifications** (+ outbound ack reactions). Surface Cliq message-reaction
  events to the agent, and set ack reactions. Blocked: the public plugin SDK exposes no
  inbound non-message event hook for plugin channels — `createChatChannelPlugin` only wires
  message-turn ingress, and there is no `heartbeat.setReaction` / ack-reaction runtime hook.
  Only bundled channels (Telegram/Discord) can do this. Tracked upstream:
  **openclaw/openclaw#100447**. Revisit when that lands. (Outbound *agent-invoked* reactions
  via the `react` message-action already work — this item is only the inbound/ack side.)

---

## Explicitly out of scope (for now)

Telegram/Discord features with no Cliq analog or no near-term demand: long-polling transport
(Cliq is webhook-only), forum topics, voice channels, broadcast groups, exec-approval rendering,
and Device-Flow QR auth (Zoho uses the self-client OAuth flow this plugin already implements).
Revisit only if a concrete use case appears.
