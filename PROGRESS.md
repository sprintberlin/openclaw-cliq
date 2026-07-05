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
All tests green; typecheck and build exit clean; gateway smoke still passes.

**Issue #11 fixed (DM reply delivery):** runtime testing on Martin's gateway proved inbound +
agent dispatch work for a real Cliq user, but the agent reply never landed in the Cliq DM
because the outbound `sendText`/`sendMedia` path (a) didn't pass `isDm` for direct sessions
(so `CliqClient` defaulted to `chatid`) and (b) forwarded `ctx.to` verbatim including the
`cliq:` route prefix. Fixed by making the inbound `responseTarget` chat-type-aware
(`user:<id>` for DMs, `chat:<id>`/`channel:<name>` for groups) and adding
`normalizeCliqRouteTarget()` which the outbound path now uses to strip the prefix and set
`isDm`. New tests cover DM-via-`userids`, group-via-`chatid`, and the normalizer. A real
Zoho round-trip on Martin's box is the remaining confirmation (needs credentials).

## Plan

> Next items are drawn from **ROADMAP.md** (the parity north star). Phase 1 there —
> correctness & reliability — outranks the Stage-4 smoke.

- [ ] **Confirm issue #11 fix end-to-end on Martin's gateway** — the outbound DM-vs-channel
      routing fix (ROADMAP Phase 1, `normalizeCliqRouteTarget` + chat-type-aware
      `responseTarget`) shipped in code; re-run the real Cliq DM test with the new build and
      confirm the agent reply now lands in the DM via `userids`. (Headless run can only ship
      the code; Martin verifies the round-trip.)
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
- [ ] **Robust self-message detection** — currently naive (`senderId === botId` /
      `senderName === botName`); Zoho bot self-events may need a sturdier check.
- [ ] **setup wizard** — only `applyAccountConfig` exists; no interactive `setupWizard`.
- [ ] **CLI subcommands** — only a stub `cliq` command descriptor.

## Open questions / blockers

- Load + channel registration are now proven on a real gateway (Stage-3 smoke). The remaining
  risk is the **dispatch and pairing runtime glue**, still unit-tested with mocks only —
  correctness against a real gateway is unproven and gates a public release. A Stage-4 smoke
  (webhook → dispatch, with a stub agent/model) is the way to close it.
