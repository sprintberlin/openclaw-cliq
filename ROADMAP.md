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
> **Reference implementations** (in the cloned monorepo, study before building):
> - `github_repos/openclaw/extensions/telegram/` — closest analog; `src/channel.ts` is the
>   adapter wiring, `AGENTS.md` documents the reliability invariants.
> - `github_repos/openclaw/extensions/discord/` — advanced (threads, reactions, actions).
> - `github_repos/openclaw/docs/channels/` — cross-cutting feature docs (`telegram.md`
>   "Feature reference", `bot-loop-protection.md`, `group-messages.md`, `pairing.md`, …).

---

## Phase 3 — Rich messaging & agent-facing features

- **Live-edit streaming for group/channel posts.** Resolve the real `chatId` for a
  group/channel bot post (its send response returns only a top-level `{ id }`, no chatId),
  so the edit API `PUT /api/v2/chats/{chatId}/messages/{messageId}` targets a valid chat
  instead of a channel unique name — via `GET /api/v2/chats/{chatId}/messages` (the bernesto
  reference pattern). Until then group posts fall back to a new message per chunk rather than
  the growing-draft UX.
- **Message actions for agents** (`actions` / `ChannelMessageActionAdapter`). Let the agent
  edit/delete its messages and react. See `channel-actions.ts`.
- **Reactions** (inbound reaction notifications + outbound ack reactions).
- **Interactive elements** (Cliq buttons/cards). Analog to Telegram inline buttons / Discord
  components; expose via `agentPrompt.messageToolCapabilities`.
- **Group tool policy** (`groups` adapter: `resolveRequireMention`, `resolveToolPolicy`).
  Per-group mention requirement and tool-permission scoping. See `docs/channels/group-messages.md`.
- **Native/custom commands** (`commands`). Slash-style Cliq commands mapped to agent actions.
- **Threading fidelity.** Map Cliq threads/replies properly (beyond the current top-level
  `reply` mode); Discord's `thread-binding-api.ts` is the model.

## Phase 4 — Operational / multi-account / enterprise

- **SecretRef-backed credentials** (`secret-contract-api.ts`). Support `openclaw secrets`
  (audit/apply/reload) so clientSecret/webhookSecret aren't plaintext in config.
- **Security audit** (`security-audit-contract-api.ts`). Contribute to `openclaw security` audits
  (open DM policy, missing webhook secret, wildcard allowlist).
- **Session binding** (`session-binding-contract-api.ts`, `session-key-api.ts`). Correct session
  keying per chat/thread/account.
- **Legacy state migrations** (`legacy-state-migrations-api.ts`). Safe config/state upgrades.
- **Multi-account** hardening. Verify multiple Cliq bots/accounts coexist (token cache already
  keyed; confirm routing + status + directory are per-account).
- **`lifecycle` hooks.** Register webhook on start, clean up on stop, instead of relying on
  manual Deluge setup.

## Phase 5 — Verification ladder (prove it, don't guess)

- **Confirm the DM reply round-trip on a real Cliq bot.** The outbound DM-vs-channel routing fix
  shipped in code (#11); a real Zoho round-trip on a live bot is the remaining confirmation
  (needs credentials — self-hosted runner or manual).
- **Confirm the channel reply round-trip on a real Cliq bot.** The channelsbyname send path
  (#26) and the user-context refresh-token grant for `ZohoCliq.Channels.UPDATE` (#27)
  shipped in code; a real channel @mention → bot reply round-trip (with a `refreshToken`
  obtained via the self-client authorization_code flow, scopes `ZohoCliq.Webhooks.CREATE
  ZohoCliq.Channels.UPDATE ZohoCliq.Messages.UPDATE` consented) is the remaining
  confirmation. Also confirm the bot is added as a participant of the target channel
  (Cliq rejects channel posts from non-participant bots).
- **Stage-4 smoke: real inbound dispatch.** Start the gateway, POST a canonical Deluge payload to
  `/cliq/webhook`, assert the pipeline dispatches to an agent (stub agent / local fake model; mock
  the outbound Cliq API). Extends `scripts/smoke-gateway.sh`.
- **Contract/test API** (`test-api.ts`). Adopt the SDK's channel test contract so the plugin is
  exercised the same way the bundled channels are.

---

## Explicitly out of scope (for now)

Telegram/Discord features with no Cliq analog or no near-term demand: long-polling transport
(Cliq is webhook-only), forum topics, voice channels, broadcast groups, exec-approval rendering.
Revisit only if a concrete use case appears.
