# ROADMAP — feature parity with the Telegram & Discord channels

> **North star:** make `openclaw-cliq` behave like a first-class OpenClaw channel —
> as reliable and as full-featured as the bundled Telegram and Discord channels.
>
> **Scope note.** Literal parity is not the goal: the Telegram channel is ~205 source
> files, Discord ~344; this plugin is ~8. We are after *functional* parity for a solid,
> publishable channel — correctness, reliability, and the features users actually notice —
> not a file-for-file reimplementation.
>
> **How this relates to PROGRESS.md.** This file is the stable **north star** (updated when
> priorities change, derived from the reference plugins). `PROGRESS.md` holds the near-term,
> self-evolving Plan — it pulls its next items from the top open phase here. When you finish
> an item, check it off here *and* reflect it in PROGRESS.md's State.
>
> **Reference implementations** (in the cloned monorepo, study before building):
> - `github_repos/openclaw/extensions/telegram/` — closest analog; `src/channel.ts` is the
>   adapter wiring, `AGENTS.md` documents the reliability invariants.
> - `github_repos/openclaw/extensions/discord/` — advanced (threads, reactions, actions).
> - `github_repos/openclaw/docs/channels/` — cross-cutting feature docs (`telegram.md`
>   "Feature reference", `bot-loop-protection.md`, `group-messages.md`, `pairing.md`, …).

---

## Already done (baseline)

- [x] Channel plugin scaffold via `createChatChannelPlugin` (base/config/setup/capabilities).
- [x] Inbound webhook: payload parse, secret verify, mention gating, DM admission.
- [x] DM security policy (`open|allowlist|pairing|disabled`) + pairing flow.
- [x] Outbound `sendText` + `sendMedia`, 5000-char chunking, Markdown→Cliq.
- [x] `mentions` adapter (strip bot @handle), cross-request OAuth token cache.
- [x] Real `npm run build` → `dist/`; **Stage-3 gateway smoke** (real loader, `plugins
      inspect --runtime` = loaded + channel capability).

---

## Phase 1 — Correctness & reliability foundations (highest priority)

The difference between a demo and a real channel. Without these, messages get lost,
duplicated, or the bot talks to itself.

- [x] **Fix outbound DM vs channel routing.** ~~`ChannelOutboundContext` has no `chatType`, so
      plugin-path `sendText`/`sendMedia` always default to `chatid` and DMs mis-route.~~ Fixed
      in #11: chat-type-aware `responseTarget` (`user:`/`chat:`/`channel:`) +
      `normalizeCliqRouteTarget()`. Still needs the real Zoho round-trip confirmation.
- [ ] **Durable-before-ack ingest.** Only ack the webhook (200) after the inbound is durably
      spooled, so a crash mid-dispatch triggers Cliq redelivery instead of a lost message.
      Study Telegram's spool + `after_agent_dispatch` ack policy (`AGENTS.md` "Reliability
      Invariants", `receive.defaultAckPolicy` in `src/channel.ts`).
- [ ] **Idempotency / de-dup.** Cliq can redeliver; drop already-processed message ids
      (tombstone, don't just delete) so callbacks/side effects don't rerun.
- [ ] **Bot-loop / self-message protection.** Current self-detection is naive
      (`senderId===botId`). Harden it so the bot never answers its own or another bot's
      messages. See `docs/channels/bot-loop-protection.md`.
- [ ] **Outbound error classification + retry.** Wrap Cliq API sends with retry on 429/5xx
      honoring any `retry-after`, treat 401/404 as fatal, and fall back rich→plain on a
      formatting-rejected 400. See Telegram `send-error-predicates.ts` / flood-wait handling.
- [ ] **Webhook security hardening.** Constant-time secret compare, single-header
      enforcement, connection close + 401 on failure, and rate-limit only failed-auth attempts
      (never throttle Cliq's real delivery). See Telegram "Webhook security ordering".

## Phase 2 — Core UX parity (what users immediately notice)

- [ ] **Typing indicator** (`heartbeat.sendTyping`). Show the bot "typing…" while the agent
      works. Cliq API supports a typing/processing signal. See `heartbeat` in `src/channel.ts`.
- [ ] **Account status + probe** (`status` adapter). Make `openclaw status` / `openclaw
      channels` report the Cliq account health (bot reachable, OAuth valid). See
      `createComputedAccountStatusAdapter` usage in Telegram.
- [ ] **Directory lookup** (`directory` adapter). `openclaw directory` to list Cliq
      users/channels (peers/groups) so routing + allowlists can use real ids. See
      `createChannelDirectoryAdapter` (`directory-runtime`).
- [ ] **Plugin doctor** (`doctor-contract-api.ts`). Contribute cliq-specific diagnostics to
      `openclaw plugins doctor` / `openclaw doctor` (missing creds, bad EU endpoint, webhook
      not reachable).
- [ ] **Setup wizard** (`setup-plugin-api.ts`). Interactive `openclaw configure` flow for
      Cliq (clientId/secret/botId/webhookSecret) instead of hand-editing `openclaw.json`.
- [ ] **Rich account inspect** (`account-inspect-api.ts`). Fuller `inspectAccount` output
      (bot identity, scopes, configured surfaces).

## Phase 3 — Rich messaging & agent-facing features

- [ ] **Streaming previews** (`live.capabilities` + finalizer). Stream partial replies by
      editing a message in place (Cliq message edit API), with debounce + final materialize.
      This is the single biggest UX gap vs Telegram. See `docs/channels/telegram.md` "Live
      stream preview" and `capabilities.live` in `src/channel.ts`.
- [ ] **Message actions for agents** (`actions` / `ChannelMessageActionAdapter`). Let the
      agent edit/delete its messages and react. See `channel-actions.ts` + "Telegram message
      actions for agents".
- [ ] **Reactions** (inbound reaction notifications + outbound ack reactions). See "Reaction
      notifications" / "Ack reactions".
- [ ] **Interactive elements** (Cliq buttons/cards). Analog to Telegram inline buttons /
      Discord components; expose via `agentPrompt.messageToolCapabilities`.
- [ ] **Group tool policy** (`groups` adapter: `resolveRequireMention`, `resolveToolPolicy`).
      Per-group mention requirement and tool-permission scoping. See `docs/channels/group-messages.md`.
- [ ] **Native/custom commands** (`commands`). Slash-style Cliq commands mapped to agent
      actions.
- [ ] **Threading fidelity.** Map Cliq threads/replies properly (`threading` beyond the
      current top-level `reply` mode); Discord's `thread-binding-api.ts` is the model.

## Phase 4 — Operational / multi-account / enterprise

- [ ] **SecretRef-backed credentials** (`secret-contract-api.ts`). Support `openclaw secrets`
      (audit/apply/reload) so clientSecret/webhookSecret aren't plaintext in config.
- [ ] **Security audit** (`security-audit-contract-api.ts`). Contribute to `openclaw security`
      audits (open DM policy, missing webhook secret, wildcard allowlist).
- [ ] **Session binding** (`session-binding-contract-api.ts`, `session-key-api.ts`). Correct
      session keying per chat/thread/account.
- [ ] **Legacy state migrations** (`legacy-state-migrations-api.ts`). Safe config/state
      upgrades across versions.
- [ ] **Multi-account** hardening. Verify multiple Cliq bots/accounts coexist (per-account
      token cache already keyed; confirm routing + status + directory are per-account).
- [ ] **`lifecycle` hooks.** Startup/shutdown wiring (register webhook on start, clean up on
      stop) instead of relying on manual Deluge setup.

## Phase 5 — Verification ladder (prove it, don't guess)

- [ ] **Stage-4 smoke: real inbound dispatch.** Start the gateway, POST a canonical Deluge
      payload to `/cliq/webhook`, assert the pipeline dispatches to an agent (stub agent /
      local fake model; mock the outbound Cliq API). Extends `scripts/smoke-gateway.sh`.
- [ ] **Stage-5: real Zoho Cliq round-trip.** A staging Cliq bot answering for real. Not
      headless-CI-able (needs credentials); run via a self-hosted runner or manually.
- [ ] **Contract/test API** (`test-api.ts`). Adopt the SDK's channel test contract so the
      plugin is exercised the same way the bundled channels are.

---

## Explicitly out of scope (for now)

Telegram/Discord features with no Cliq analog or no near-term demand: long-polling transport
(Cliq is webhook-only), forum topics, voice channels, broadcast groups, exec-approval
rendering. Revisit only if a concrete use case appears.
