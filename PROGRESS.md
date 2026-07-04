# PROGRESS

> Living plan for `openclaw-cliq`. **Rewrite this file in place every run — do not append.**
> State = where we are now. Plan = the self-maintained backlog (top item = next run).
> No per-run changelog or history here — git log and the issue comments hold that.
> Durable insights (SDK quirks, gotchas) go into AGENTS.md → Learnings, not here.

## State

The plugin is feature-complete against the SDK surface we can verify headlessly: inbound
webhook, mention gating, DM admission + pairing, Markdown→Cliq, `sendText`/`sendMedia`,
cross-request OAuth token caching, a real `npm run build` producing `dist/`, and a full
Zoho-side README. `dmPolicy` config schema is aligned across manifest, runtime and README.
All tests green; typecheck and build exit clean.

**Real-gateway load is now VERIFIED** (openclaw@2026.6.11): `npm run smoke:gateway` builds
the plugin, links it into an isolated gateway profile, loads the runtime, and asserts
`status: loaded` + a registered `channel` capability (`plugins doctor` clean). So the entry,
manifest, and channel registration are proven against the real loader — not just a mock. The
remaining open work is the deeper pipeline: a real **inbound dispatch** (webhook → agent) and
a real **Zoho round-trip**, neither of which the current smoke exercises.

## Plan

- [ ] **Stage-4 smoke: real inbound dispatch** — extend `scripts/smoke-gateway.sh` (or a
      sibling) to start the gateway, POST a canonical Deluge payload to `/cliq/webhook`, and
      assert the dispatch pipeline runs. Needs a stub agent / local fake model so the pipeline
      does not require a real LLM, and a local mock for the outbound Zoho API call.
- [ ] **Verify inbound dispatch** against a live gateway — the `runtime.channel.*` argument
      shapes (`resolveAgentRoute`, `finalizeInboundContext`, `formatAgentEnvelope`,
      `dispatchReplyWithBufferedBlockDispatcher`, `recordInboundSession`) are inferred from
      the `.d.ts`, not runtime-tested. (Stage-4 smoke is how to prove this.)
- [ ] **Verify pairing end-to-end** — `upsertPairingRequest`/`buildPairingReply` against a
      real pairing store, plus the `openclaw pairing approve cliq <code>` → `notify` path.
- [ ] **Outbound DM vs channel** — `ChannelOutboundContext` has no `chatType`, so plugin-path
      `sendText`/`sendMedia` default to `chatid`. Decide a `user:`/`chat:` prefix convention
      on `ctx.to` (or extend the context) so outbound DMs route correctly.
- [ ] **Robust self-message detection** — currently naive (`senderId === botId` /
      `senderName === botName`); Zoho bot self-events may need a sturdier check.
- [ ] **setup wizard** — only `applyAccountConfig` exists; no interactive `setupWizard`.
- [ ] **CLI subcommands** — only a stub `cliq` command descriptor.

## Open questions / blockers

- Load + channel registration are now proven on a real gateway (Stage-3 smoke). The remaining
  risk is the **dispatch and pairing runtime glue**, still unit-tested with mocks only —
  correctness against a real gateway is unproven and gates a public release. A Stage-4 smoke
  (webhook → dispatch, with a stub agent/model) is the way to close it.
