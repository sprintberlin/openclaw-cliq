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
All tests green; typecheck and build exit clean. The open work is almost entirely
**live-gateway verification** — nothing headless can prove the dispatch/pairing glue against
a real OpenClaw gateway.

## Plan

- [ ] **Real-gateway install** — `npm link` / drop into a plugin dir on a live gateway,
      restart, check `openclaw status` + logs load the plugin without errors.
- [ ] **Verify inbound dispatch** against a live gateway — the `runtime.channel.*` argument
      shapes (`resolveAgentRoute`, `finalizeInboundContext`, `formatAgentEnvelope`,
      `dispatchReplyWithBufferedBlockDispatcher`, `recordInboundSession`) are inferred from
      the `.d.ts`, not runtime-tested.
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

- The dispatch and pairing runtime glue is unit-tested with mocks only; correctness against a
  real gateway is unproven. This is the single biggest risk and gates a public release.
