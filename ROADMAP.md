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
> **Phase dependencies.** The v3 foundation is in place, so Phase 3 (rich messaging) and Phase 4
> (programmatic v3 CRUD) can proceed directly; Phase 5 is independent and can be pulled forward on
> demand.
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

## Phase 3 — Rich messaging

- **Interactive status card + confirmation for sensitive actions.** Show a live status card
  transitioning through phases (generating → done) during a turn (the "failed" tail is already
  handled — the thinking placeholder is cleaned up / edited to `thinking.failureText` when the
  turn produces no reply), and gate sensitive/tool actions behind an explicit confirm button
  before executing. Ref: Message Cards v3 + Cliq Bot Handlers (Context Handler)
  <https://www.zoho.com/cliq/help/platform/bothandlers.html>.
- **Cliq Forms for structured input.** Use Cliq Forms for approval / collection flows (pairing
  approval, parameter capture) instead of free-text parsing. Ref: Cliq platform (Form handler)
  <https://www.zoho.com/cliq/help/platform/>.

## Phase 4 — Programmatic Cliq via v3 CRUD

v3 adds CRUD endpoints v2 never had (bots, slash commands, message actions, widgets, schedulers).

- **Adopt v3 `PATCH` partial-update semantics for the CRUD update calls** (bots, slash commands,
  message actions, schedulers — v3 update endpoints use `PATCH`, not `PUT`); build it with the
  first v3 CRUD update below. Message-edit-in-place is NOT part of this — v3 has no single-message
  edit endpoint, so the v2 `PUT /api/v2/chats/{chatId}/messages/{messageId}` path stays. Ref: v3
  HTTP Methods <https://www.zoho.com/cliq/help/restapi/v3/httpmethods/>.
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
