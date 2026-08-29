# Changelog

All notable changes to `@sprintcx/openclaw-cliq` are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

Each released version has a `## [X.Y.Z] - YYYY-MM-DD` heading; the ClawHub
publish workflow extracts the matching section as the release notes (see
[RELEASING.md](RELEASING.md)).

## [Unreleased]

### Changed

- **README now documents that named Cliq accounts are outbound/diagnostics-only (issue #191).** Inbound `POST /cliq/webhook` traffic is resolved against the root account only. Running multiple conversational bots still requires a separate gateway deployment per bot, as described in `docs/setup/running-multiple-agents.md`.

- **New installations are now directed to the combined 14-scope OAuth profile first (issue #192).** README §3b recommends one initial consent covering runtime messaging plus bot/handler inspection and provisioning. The 11-scope runtime-only profile remains available as an explicitly minimal alternative, with a warning that Zoho does not add scopes retroactively: expanding it later requires re-consent and a regenerated refresh token.

- **Breaking: OpenClaw `2026.8.1-beta.3` is now the minimum supported runtime (issue #189).** Older OpenClaw versions are no longer supported or tested. The plugin API range, minimum gateway version, peer dependency, compatibility matrix, and current installation guidance now require Beta 3 or later; the build metadata and development dependency remain pinned to exactly `2026.8.1-beta.3`.

- **Block streaming is now the default (issue #181).** An unset
  `channels.cliq.streaming.preview` resolves to `"on"`, so complete response
  blocks live-edit one Cliq message instead of arriving as a single final
  reply. This applies on upgrade too: installs that never set the key change
  behavior without a config edit, and no migration rewrites their config. Set
  `channels.cliq.streaming.preview: "off"` (per account under
  `channels.cliq.accounts.<id>` if needed) to opt out explicitly; an explicit
  `"on"` is unchanged. The edit throttle/coalescing default stays 1000 ms.
  Live-edit still needs a user-context `refreshToken`
  (`ZohoCliq.Messages.UPDATE`) — without one, previews degrade to one normal
  final response and `openclaw doctor` now warns for the default-on case, not
  only for an explicit opt-in.

- **The OpenClaw build floor is now `2026.8.1-beta.3` (issue #156).** Typecheck, build, and the development tree pin that version. At the time of this change, existing installs on `2026.7.1-2` remained supported and runtime-smoked.

### Added

- **Block-streaming live-edit of one Cliq response (issue #175).** `channels.cliq.streaming.preview` controls whether complete response blocks update one message; it now defaults to `"on"` (issue #181), while `"off"` keeps one final reply. The thinking placeholder, when present, is that same message rather than a second progress surface. Preview edits are throttled and coalesced (`streaming.minEditIntervalMs`, default 1000 ms), unchanged content is not sent, and a late edit cannot overwrite newer content. A 429 backs off before retrying the latest preview. Edit failures fall back to one normal final response without failing the turn. Message edit stays on the v2 chat-messages path. Independent of native v3 typing (issue #178); no live Cliq DM round-trip was run in this increment.

- **Native v3 chat typing (issue #178).** `heartbeat.sendTyping` posts `{"action":"typing"}` to `POST /api/v3/chats/{chat_id}/activities` (scope `ZohoCliq.Chats.UPDATE`, success is empty HTTP 204) when a refresh token is configured and a real inbound chat id is known. A user id is never used as a chat id. Pulses are throttled to at most one request every 4.5 s and stop after 60 s; a 429 stops further activity for the rest of the turn; `clearTyping` posts `text_cleared`. Failures never fail or delay the agent turn. HTTP 204 is API acceptance only — Cliq client UI visibility is unconfirmed and currently looks negative. Independent of block-streaming live-edit (issue #175).

- **Required runtime OAuth scope `ZohoCliq.Chats.UPDATE` for native v3 chat typing.** Operators must re-consent the Self Client including this scope and regenerate the refresh token. Previously consented tokens without this scope fail typing with `oauthtoken_scope_invalid`.

- **Doctor can adopt a verified Zoho handler URL when `publicWebhookUrl` is missing (issue #172).** Default `openclaw cliq doctor` stays read-only: if both Message and Mention handlers agree on one valid HTTPS `/cliq/webhook` URL and their secret fingerprints match config, it names that candidate and points at `--adopt-handler-url`. That explicit path runs a full authenticated preflight first, then writes the URL and `inboundVerifiedAt` in one mutation. Disagreement, an invalid URL, a secret mismatch, a failed or inconclusive preflight, a foreign-secret probe, or a write error leaves config unchanged and never mutates Zoho handlers.

- **Guided Cliq onboarding is now one resumable flow (issue #92).** `openclaw setup` integrates the existing capability, SecretRef, provisioning, preflight, doctor, and first-contact work into a single wizard: it checks the installed OpenClaw package against the shared support matrix, names the unavoidable Zoho Self Client and Deluge UI actions, stores newly entered secrets as canonical env-backed SecretRefs, validates generated config, offers the read-only doctor plus an optional consented roundtrip, and prints a machine-readable final report covering config, OAuth, bot, handlers, lifecycle, webhook, admission, and delivery. Reruns preserve existing credentials and handlers unless a change is confirmed. Partial completion reports the next required action; cancelled optional message tests are not treated as failures.

### Fixed

- **Fresh bot provisioning now includes Zoho's required description (issue #193).** `openclaw setup` sends a non-empty `description` in `POST /api/v3/bots`; omitting it is rejected by Zoho with `param_missing`. Zoho still derives `unique_name` from the display name, so the plugin does not send that field.

- **Gateway smoke no longer auto-installs Perplexity from a developer shell (issue #182).** `scripts/smoke-gateway.sh` now unsets `OPENROUTER_API_KEY` and `PERPLEXITY_API_KEY` so OpenClaw cannot auto-enable `@openclaw/perplexity-plugin` from inherited provider credentials and refuse to report the gateway ready.

- **Block-streaming previews now grow during generation, even with `thinking.animate: "off"` (issue #185).** OpenClaw's buffered `deliver()` only flushes coalesced blocks, so a long turn could sit on the static placeholder until one final edit. The inbound path now also forwards `onPartialReply` snapshots into that same Cliq message, so `textLen` grows monotonically while the model is still writing. Independent of the thinking animator (issue #184).

- **Thinking animator no longer overwrites the block-streaming preview (issue #184).** With `streaming.preview: "on"` (the default) and `thinking.animate: "dots"`, both loops previously PUT the same Cliq message, so users saw only `💭 .` / `💭 ..` / `💭 ...` until the final answer. The animator now runs only when block streaming is off; the placeholder remains the same draft the live-edit path grows. `thinking.animate` is unchanged for the explicit `streaming.preview: "off"` path.

- **Transient gateway startup failures no longer erase valid inbound
  verification (issue #171).** The public webhook preflight now retries bounded
  `502`, `503`, `504`, connection-refused/reset, and timeout outcomes at the
  method/reachability boundary. A route that becomes ready continues through
  secret enforcement normally; exhausted transient conditions are reported as
  inconclusive with attempt and retry-delay evidence, return a nonzero exit,
  and preserve both `inboundVerifiedAt` and `inboundVerificationFailedAt`.
  Stable route, edge/WAF, and secret-enforcement failures remain definitive.

- **`$NAME` / `${NAME}` env shorthands are resolved instead of used as
  literal credentials (issue #170).** The security audit already classified
  those strings as SecretRefs, but runtime resolution and the staged doctor
  treated them as available plaintext, so OAuth, webhook, and refresh secrets
  could become the placeholder text itself. All three secret-bearing fields
  now coerce the shorthand first, honor `secrets.defaults.env` and provider
  allowlists, report a missing or empty environment value as unresolved, and
  never print the resolved value.

- **Multi-user Cliq bots no longer enter service with a shared DM session
  silently (issue #104).** `channels.cliq.dmPolicy` / `allowFrom` control who
  may contact the bot, but only global `session.dmScope` isolates those users'
  conversation history. OpenClaw resolves an absent `session` block to
  `dmScope: "main"`, including on fresh installs; every sender and every
  channel then collapses into `agent:<agentId>:main`, which can leak context
  between users and leave the shared session's latest delivery route pointing
  at another channel. Setup now shows a prominent privacy warning and offers
  (default no) to set `per-channel-peer`, never silently overwriting the global
  value. `openclaw cliq doctor` covers the absent-session case, and
  `openclaw security audit` emits the critical
  `channels.cliq.session_scope.shared` finding for `open`, `pairing`, wildcard,
  or multi-sender allowlist configurations. Single-sender allowlists and
  disabled DMs are not warned; `per-account-channel-peer` is documented as the
  stricter multi-account option.

- **Canonical structured SecretRefs are accepted again (issue #95).** The
  plugin manifest typed `clientSecret`, `webhookSecret`, and `refreshToken` as
  bare strings in all four schema locations, so the exact shape
  `openclaw secrets apply` writes was rejected with
  `invalid config for plugin cliq: must be string`, while `$ENV_VAR`
  interpolation passed. All three representations — structured SecretRef,
  environment interpolation, and a literal value — are now accepted at the
  channel root and under `channels.cliq.accounts.<id>`, and are verified
  against both supported OpenClaw versions (`2026.7.1-2` and
  `2026.8.1-beta.3`), so no version-gated fallback is needed.
- **`openclaw secrets audit` no longer reports Cliq plaintext as clean.** The
  plugin's secret contract was published under export names OpenClaw's
  contract loader does not read, so it silently registered zero targets: a
  config with three plaintext Cliq secrets audited as `"status": "clean"`.
  The contract is now exposed as `secret-contract-api.ts`, the artifact the
  loader actually resolves. Secrets stored under a named account
  (`channels.cliq.accounts.<id>.*`) are registered too — previously they were
  never scanned even though `apply` would have rewritten them.
- **Setup no longer reports success for a config the gateway would reject.**
  The generated `channels.cliq` section is now validated against the real
  manifest schema using OpenClaw's own validator before setup finishes, and
  fails closed if the validator is unavailable. Validation failures name the
  offending path only; secret values never appear in the message.
- **The advertised compatibility floor matches the range actually tested.**
  `openclaw.compat` and the `openclaw` peer dependency claimed `>=2026.6.6`,
  a version no longer built, smoke-tested, or checked by `check:sdk-compat`.
  Both now state `>=2026.7.1-2`, matching `.github/openclaw-compat.json`.
- **`openclaw cliq doctor` distinguishes an unresolved secret reference from
  an unset field.** A configured-but-broken reference — a missing environment
  variable, an unavailable or mis-sourced provider, or a `file`/`exec` ref
  that cannot resolve at runtime — used to be indistinguishable from an
  optional field that was never set. Each secret is now reported as resolved,
  unresolved, provider-unavailable, plaintext, or absent, identified by
  `source:provider:id` and never by value.

- **OAuth capability evidence is no longer conflated with consent (issue #93,
  including #110).** The capability matrix now distinguishes four outcomes
  instead of three: a capability is `pass` only when a real read-only API call
  succeeded, `not verified` when no safe non-destructive probe exists, and
  `reported from the granted scope set, not proven` when the only real proof
  would mutate Zoho (bot creation). A copied scope string, or a token response
  that echoes a scope Zoho later rejects, can no longer read as proof. Every
  unprobeable capability must now state *why* it cannot be probed, which also
  prevents a destructive "probe" (a real send, a live handler `PATCH`, a bot
  create) from being added later to make an honest gap look green.
  `ZohoCliq.Bots.READ` gained a genuine read-only probe
  (`GET /api/v3/bots?limit=1`).
- **Bot and handler provisioning now fails closed without capability
  evidence.** A failed bot listing is treated as "existence unknown" instead
  of "bot absent", so a token lacking `ZohoCliq.Bots.READ` can no longer
  conclude the bot is missing and create a duplicate on every setup run. When
  the granted scope set is known, a missing `ZohoCliq.Bots.CREATE` or
  `ZohoCliq.Bots.UPDATE` blocks the mutation and names the exact scope and
  regeneration step rather than surfacing a generic
  `oauthtoken_scope_invalid` from Zoho. A read failure after a create no
  longer fabricates a bot record. The gate is one-directional: a missing
  scope blocks, but a present scope never authorises on its own.
- **The setup wizard printed an incomplete scope list.** It hardcoded six
  scopes and omitted `ZohoCliq.Bots.CREATE`, so operators who followed it
  could not provision a bot. The wizard, README §3c, and the multi-agent guide
  now all derive from the capability matrix. Missing-capability warnings quote
  the matrix's per-capability scope and regeneration instructions instead of a
  generic README pointer.

### Added

- **Idempotent bot and handler provisioning from `openclaw setup` (issue #94).**
  Setup now inspects the Zoho-held Message and Mention handlers (plus the
  Welcome handler when the greeting is opted in) and reports a redacted
  read-only dry-run before offering any change. Missing handlers are created;
  when Zoho answers the full-script create with a generic `operation_failed`,
  a minimal handler is created and then completed with `PATCH`, and that
  fallback stays visible in the report. `execution_handler_update_failed` is
  reported as a probable script-validity fault rather than retried, because
  the Mention Handler does not receive the `attachments` parameter. Every
  mutation needs its own explicit confirmation that defaults to no, and each
  write is read back and only reported as successful when Zoho stored the
  configured URL and secret.
  **"Bot exists, handlers exist, URL matches, secret does NOT" is treated as
  a first-class conflict**, never as "already configured, nothing to do": a
  matching unique name is not proof that a bot belongs to this deployment,
  and that exact state otherwise yields a green preflight while real inbound
  traffic is rejected with `401`. An unreadable handler, an unrecognised
  hand-written script, and a bot whose Zoho-derived unique name differs from
  `channels.cliq.botId` all block instead of being overwritten. Handler
  bodies, secrets, and OAuth material never reach the plan, the wizard notes,
  or any report — only SHA-256 fingerprints.

- **Read-only bot/subscription inspection and consented first-contact onboarding
  (issue #99).** `openclaw setup` can now resolve an optional user and channel
  by name, email, id, or handle through the existing directory adapter; show
  the configured bot's documented active state, visibility scope, subscriber
  count, and handler consistency; and send one clearly labeled first-contact
  DM only after a separate explicit confirmation. The result exposes only
  non-reversible redacted chat/message identifiers. Subscriber membership is
  listed only when Zoho grants the bot-creator/organization-admin read;
  unavailable, incomplete, unscoped, or unrecognised data is explicitly
  `unknown` rather than guessed as unsubscribed. The same shared inspector now
  powers doctor stage 5. Setup also exposes the existing greeting behavior as
  an explicit Welcome Handler opt-in, preserves custom greeting text, and
  explains bot discovery/subscription plus channel add, admission, mention,
  and trusted-organization behavior without mutating any real channel.

- **Explicit trusted-organization admission mode (issues #100, #103).**
  Organization-wide deployments can now be declared deliberately via
  `channels.cliq.trustedOrganization.acknowledged`, which `openclaw setup`
  writes only after showing the resulting DM, group, and tool exposure and
  asking for confirmation. The acknowledgement is never inferred from
  `allowFrom: ["*"]` or `dmPolicy: "open"`, and upgrades never modify an
  existing open configuration. `openclaw security audit` keeps reporting an
  unacknowledged wildcard/open policy as critical, and downgrades an
  acknowledged deployment to informational alongside a finding that records
  the deliberate policy; `openclaw doctor` restates the real boundary.
  Group admission is now enforced at the webhook: `groupPolicy: "allowlist"`
  admits only channels listed in `groups`, `disabled` blocks all group
  traffic, and configurations without `groupPolicy` keep the previous open
  behavior. Fresh generic setup offers group access as disabled and resolves
  DM and channel allowlist entries through the existing `openclaw directory`
  adapter; entries the directory cannot resolve are kept exactly as entered
  rather than silently broadened.
  **Runtime organization verification is not implemented, because it is not
  possible:** Zoho Cliq webhook payloads carry no signed tenant claim
  (`user.organization_id` is handler-forwarded JSON) and the directory API
  offers no independent sender-to-organization proof. The enforced boundary
  remains the constant-time verified `x-cliq-webhook-secret` plus the
  installed bot-handler context, and the config, README, doctor, and audit
  wording now say exactly that instead of implying stronger isolation. The
  normalized organization evidence is surfaced on inbound DM, mention,
  welcome, form, and button-callback turns for diagnostics.

- **Multi-agent rollout guide (issue #109).** The setup documentation now
  distinguishes the shared OAuth app and same-org user-context refresh token
  from each agent's dedicated bot identity, webhook secret, public URL, and
  handlers. It also records per-organization data-center selection, the
  setup-scope error and re-consent requirement, and the need to diff an
  existing bot's stored handler URL and secret before treating a matching
  unique name as this deployment.
- **`openclaw cliq webhook-route` (issue #108).** A local, unauthenticated
  check that asks the running gateway whether `/cliq/webhook` is registered.
  Registration is only claimed on a `405` that also carries the plugin's own
  route-signature header, so an unrelated service that rejects `GET` cannot
  pass; every other outcome (unreachable port, a bare `404` a proxy may have
  generated, any unexpected status) is reported as inconclusive with a
  non-zero exit code, so the command is safe as a deploy gate. The report
  always explains why `openclaw plugins inspect cliq --runtime --json` prints
  `"httpRoutes": 0` even for a healthy install: that command loads plugins
  without activating them, so `registerFull` (the only place the route is
  registered) never runs for it. Tracked upstream as
  [openclaw/openclaw#130773](https://github.com/openclaw/openclaw/issues/130773).

### Fixed

- **Webhook preflight resolves the configured bot unique name before reading
  handlers (issue #149).** Zoho handler-management routes require the internal
  `b-…` bot id, while `channels.cliq.botId` normally stores the unique name
  required by message delivery. The preflight now uses the complete paginated
  bot listing to resolve that name, caches the result for the run, and passes
  an already-internal id through without a lookup. Missing or ambiguous
  matches, incomplete listings, API failures, and missing
  `ZohoCliq.Bots.READ` are explicit skipped states rather than false passes;
  their CLI and JSON diagnostics never expose raw API responses, handler
  bodies, webhook secrets, or OAuth tokens.
- **Directory listing no longer sends a query param Zoho rejects, and a failed
  directory read no longer blocks the consented doctor send (issue #146).**
  `GET /api/v2/users` and `GET /api/v2/channels` accept only `limit` (maximum
  100) and the `next_token` cursor; the offset-style `from` the list calls
  added was answered with HTTP 400 `extra_param_found` even on an account
  whose `ZohoCliq.Users.READ` / `ZohoCliq.Channels.READ` probes passed, so
  `openclaw directory`, setup allowlist resolution, and `openclaw cliq doctor`
  all came back empty or failed. The shared request construction now sends
  only the documented params, clamps the page size to 100, and stops when a
  response carries no cursor instead of retrying with an offset — the same
  class of bug fixed earlier for `listChatMessages`. `openclaw cliq doctor`
  additionally treats stage 7 as a target-selection aid: a rejected directory
  read warns (run `degraded`, exit `1`) instead of failing, and the consented
  `--outbound-test` / `--roundtrip` still run against an explicit `--target`.
  Failures in the config, runtime, OAuth, capability, bot-handler, and public
  webhook stages keep blocking the send.
- **Local checkout install is documented with the version-specific `--force`
  rule (issue #126).** `openclaw plugins install --link <path>` is cancelled on
  OpenClaw `2026.8.1-beta.3` unless `--force` acknowledges that the source is
  outside ClawHub trust metadata; the same `--force` is rejected with `--link`
  on the retained runtime baseline `2026.7.1-2`. The README now states both commands, why
  the confirmation exists, that the manifest-id / package-name line is
  expected, and that every later `git pull` on a `--link` install needs a
  rebuild plus a gateway restart.
- **`channels.cliq.enabled` is a valid channel switch (issue #125).** The
  schema now accepts the boolean used by every bundled OpenClaw channel and
  already written by this plugin's setup wizard, instead of rejecting it as
  an additional property. Omitted/`true` keeps current behaviour; `false`
  stops the account from starting while leaving credentials in place.
  `plugins.entries.cliq.enabled: false` still unloads the plugin entirely and
  cannot be overridden from the channel section. The documented
  `channels.cliq.accounts.<id>` shape is now in the schema as well, so a
  multi-account config no longer fails validation for the same reason.
- **A green webhook preflight no longer falsely claims Zoho holds the same
  secret as the gateway (issue #124).** When `botId` and
  `ZohoCliq.Bots.READ` are available, a sixth stage reads the bot's Message and
  Mention handlers, compares SHA-256 fingerprints of their `webhookSecret`
  literals with the resolved config secret, and compares their `webhookUrl`
  with the public URL. A mismatch fails and names the handler without exposing
  either secret. Missing scope, unreadable handlers, hand-written script
  shapes, and missing `botId` are explicitly skipped rather than passed; the
  report warns that the original five stages only prove the configured secret
  works against this install's own endpoint.
- **`ackPolicy: "immediate"` no longer fails every turn with a false gateway
  drain on OpenClaw 2026.8.x (issue #122).** The webhook now reserves the SDK's
  independent admission root with `runDetachedWebhookWork` before writing the
  HTTP 200, so the post-ack continuation remains accepted instead of failing
  with `GatewayDrainingError` / *"Couldn't process that message"*. The helper
  is resolved dynamically for dual-version safety: `2026.7.1-2` keeps its
  working fire-and-forget path, while `>= 2026.8.1-beta.3` uses detached work.
- **Redelivered slow turns no longer show a false failure placeholder (issue
  #123).** When Deluge redelivers a content-derived message after the short
  dedupe TTL while its original turn is still running, the duplicate no longer
  posts a second thinking placeholder; if the runtime reports the benign skip
  after a placeholder was posted, the plugin deletes that placeholder instead
  of editing it into *"Couldn't process that message"*. Genuine failed or empty
  turns still produce the configured failure text.
- **The public webhook preflight now identifies itself explicitly at the edge
  (issue #107).** Every reachability, secret-enforcement, and authenticated
  probe request sends the documented User-Agent
  `openclaw-cliq-preflight/<package-version> (+https://github.com/sprintberlin/openclaw-cliq)`
  instead of relying on Node's runtime-dependent default or sending no identity
  at all — avoiding false diagnostics when an edge WAF blocks unfamiliar bot
  clients before they reach an otherwise healthy gateway. Operators can pass
  `--user-agent <value>` to reproduce Zoho/Deluge's identity, and an HTTP `403`
  is now classified as a probable edge/WAF/bot-rule block with allowlisting
  guidance rather than blamed on the route or reverse proxy.
- **A passing CLI preflight now records the inbound verification (issue
  #106).** `channels.cliq.inboundVerifiedAt` was only ever written by the setup
  wizard, so an operator who configured the channel by hand and verified the
  endpoint with `openclaw cliq webhook-preflight` still saw "inbound: NOT
  verified" — a real proof of reachability was silently discarded. The CLI now
  records `inboundVerifiedAt` on a passing run and the new
  `inboundVerificationFailedAt` on a failing run (clearing any stale
  verification), but **only** when the checked URL is the configured
  `channels.cliq.publicWebhookUrl`: running the command against any other
  endpoint never touches config, `--no-write` keeps it a pure read-only probe,
  and an inconclusive run (upstream `429`, no resolvable secret) preserves the
  previous state instead of destroying a genuine verification. Setup status
  now distinguishes three states — verified, last check FAILED, never checked —
  instead of folding two of them into "NOT verified".
- **Cliq security audit delivery (issue #111).** Route Cliq-specific findings through the channel security adapter so `openclaw security audit` includes them in its default output. `--deep` remains reserved for live gateway probes.
- **Documented and contained the Deluge handler secret exposure (issue #113).**
  Zoho stores the webhook secret as a literal in each handler script and
  returns that script — secret included — to anyone with bot-edit access or
  `ZohoCliq.Bots.READ`; handler creation responses also echo it. The setup
  guide now explains the blast radius, requires distinct per-agent secrets,
  recommends rotation whenever bot-edit access changes, warns that
  `Bots.READ` grants secret-reading power, records Zoho's lack of handler
  secret storage, and cross-links the two-copy drift diagnostic gap in #124.
  A regression audit locks the invariant that plugin tooling never logs
  handler scripts, raw provisioning responses, or configured secret values.
- **`ZohoCliq.Bots.CREATE` added to the capability matrix (issue #110).**
  The setup/maintenance profile previously documented only `Bots.READ` and
  `Bots.UPDATE`, which suffice to inspect bots but not to create one: a token
  consented with the full documented set is issued successfully and still
  fails `POST /api/v3/bots` with `oauthtoken_scope_invalid`. Bot creation is
  now its own `client_credentials` capability, the setup profile is split
  into an inspect-only string (`Bots.READ`) and a provisioning string
  (`Bots.READ,Bots.CREATE,Bots.UPDATE`), the combined consent string
  includes the new scope, and a missing `Bots.CREATE` produces a message
  naming that exact scope. Because creating a bot is destructive, the
  capability is reported from the granted scope set and labelled
  consent-reported, never proven by a live probe.
- **Zoho provisioning guidance now matches the live v3 API contract (issue
  #112).** The setup guide distinguishes the configured bot unique name from
  the internal `b-...` ID required by bot/handler CRUD, records the verified
  create/read/handler endpoint methods and body fields, and no longer claims
  that Message and Mention handlers use byte-identical Deluge. Mention handlers
  must omit the Message Handler's `attachments` block; an
  `execution_handler_update_failed` response can indicate invalid handler
  script references rather than a transient failure.

- **Webhook accounts now report as running, configured, and event-driven
  (issue #98).** A configured Cliq account keeps a passive `startAccount`
  lifecycle so OpenClaw does not treat the webhook transport as `stopped` /
  `health:not-running` and restart it. Status surfaces agree that the
  account is `configured` (the Health table no longer contradicts the
  Channels table for the same credentials), identify the integration as
  `mode: webhook` at `/cliq/webhook`, and populate `lastInboundAt` /
  `lastOutboundAt` after a verified round-trip. The lifecycle resolves
  cleanly on abort; `/cliq/webhook` registration and delivery are unchanged.
- **Pairing Approve/Deny buttons now enforce owner identity (issue #117).**
  Button clicks are short-circuited before the agent turn and may only be
  performed by the DM identity configured in `pairing.notifyOwnerTarget`;
  non-owner, self-approval, channel-target, and unconfigured-owner attempts are
  rejected without revealing whether a code is valid. Approved senders are
  persisted in a plugin-owned store with single-use, one-hour codes, so button
  approval works on both `2026.7.1-2` and `2026.8.1-beta.3` while CLI approvals
  remain honored through the SDK allow-from store.
- **OpenClaw 2026.8 load compatibility (issue #116).** Version-dependent SDK
  pairing approval is resolved dynamically instead of through a static named
  import, and the secret-contract helpers use the SDK subpath shared by
  `2026.7.1-2` and `2026.8.1-beta.3`. The plugin now loads and registers the
  Cliq channel on both versions; where button-based pairing approval is absent,
  the owner receives the portable `openclaw pairing approve cliq <code>`
  command instead of a false success.
- **Repeated identical slash commands no longer disappear for 30 minutes
  (issue #114).** Live Cliq Message Handlers can forward `message` as a bare
  string with no `message.id` or `message.time`, so the plugin derives a
  content-based synthetic id. That id now uses a 60-second dedupe TTL, matching
  Cliq's practical retry window: a short redelivery (including caption-less
  files) is still suppressed, while a deliberate later `/status`, `/new`, or
  other identical command starts a new agent turn. Real message ids and
  plugin-owned event ids retain the 30-minute replay-protection TTL.

### Added

- **Staged Cliq doctor with optional end-to-end roundtrip (issue #97).**
  `openclaw cliq doctor` orchestrates a nine-stage diagnostic over the existing
  static doctor warnings, OAuth capability probes, public webhook preflight,
  and directory listing. Default mode is read-only (no messages, handler
  updates, config writes, or restarts). `--outbound-test` and `--roundtrip`
  require an explicit target, kind, and `--confirm`. `--roundtrip` posts a
  nonce-bearing challenge and waits for the exact nonce reply in the same
  chat, so a completed roundtrip proves the inbound webhook, agent turn,
  configured policy, and outbound reply; a timeout or partial failure names
  the boundary that broke. `--json` emits a documented stable report
  (`schemaVersion: 1`). Exit codes distinguish healthy (`0`), degraded (`1`),
  failed (`2`), and invalid invocation (`3`). Secrets, tokens, auth codes, and
  sensitive response bodies are redacted. The config stage also warns about a
  shared `session.dmScope: main` on a multi-user bot and about
  `ackPolicy: "immediate"`. Bot/handler inspection is used when a subsystem is
  available and otherwise reported as `skipped` (degrading the run) rather
  than guessed — including the Zoho-held webhook-secret comparison that a
  green public preflight cannot see.
- **Declared OpenClaw support range, enforced in CI (issue #118).** The
  supported versions live in a single file (`.github/openclaw-compat.json`).
  A compatibility workflow builds once against the pinned floor and loads that
  identical artifact on every supported version via the real gateway smoke,
  and `npm run check:sdk-compat` fails when any static runtime SDK import
  resolves to a module or symbol missing from a supported version.
- **Public HTTPS webhook preflight (issue #96).** A reusable, non-dispatching
  preflight (`src/webhook-preflight.ts`) validates the whole public path to
  `/cliq/webhook` and reports which boundary failed: URL syntax/HTTPS, public
  DNS, TLS (hostname, validity, chain), route reachability through the reverse
  proxy, `GET` method handling, and shared-secret enforcement (both a missing
  and a wrong secret must be rejected). Redirects and HTML challenge pages in
  front of the route are called out explicitly, because a healthy tunnel does
  not prove that requests reach the origin — as is the OpenClaw web UI, which
  means the request reached the gateway but the plugin route is not
  registered. A `429` from an upstream rate limiter is reported as an
  inconclusive `warn` rather than counted as proof that the secret check ran.
  The authenticated probe must echo the correlation nonce, so an unrelated
  endpoint that merely answers `200` cannot pass. The report has a stable JSON
  shape for reuse by the staged doctor (#97), and secrets are redacted from
  every stage detail, including thrown network errors.
- **Dedicated webhook probe protocol (`src/webhook-probe.ts`).** The preflight
  finishes with an authenticated probe carrying `handler: "openclaw-probe"`.
  The webhook route answers it directly — before welcome/message parsing,
  dedupe, and dispatch — so a successful probe reaches the plugin but never
  creates an agent turn, session entry, outbound reply, or user-visible Cliq
  message. The response echoes a correlation nonce and reports
  `dispatched: false` so callers can assert the no-dispatch guarantee.
- **Setup verifies inbound instead of assuming it.** `openclaw setup` now asks
  for the public webhook URL (stored as `channels.cliq.publicWebhookUrl`) and
  runs the preflight before finishing. Complete credentials alone no longer
  count as inbound-ready: when the endpoint is unreachable or unauthenticated,
  setup reports inbound Cliq as NOT ready and prints the specific failing
  boundary plus a pointer to the setup guide. The verdict is persisted as
  `channels.cliq.inboundVerifiedAt` and surfaced in the channel's setup status
  lines, so the claim survives the wizard run instead of being a transient
  note; a later failing run clears a stale timestamp. The webhook secret is
  resolved through the canonical SecretRef path, so an install configured by
  `openclaw secrets apply` is verified rather than skipped. Neither a crashing
  preflight nor a failing prompter aborts the wizard.
- **`openclaw cliq webhook-preflight <url>` CLI command.** Runs the same
  preflight on demand, defaulting the secret to `channels.cliq.webhookSecret`
  (`--secret` to override, `--json` for the machine-readable report). Exits
  non-zero when inbound is not ready, so it works as a deployment gate.

### Documentation

- **Corrected the documented webhook authentication headers (issue #128).**
  The README claimed the endpoint also accepts `x-webhook-secret` or
  `Authorization: Bearer <secret>` "for convenience". The runtime has always
  enforced single-header authentication and rejects both, so operators who
  followed that note configured a header the gateway answers with `401`. Only
  `x-cliq-webhook-secret` is documented now.
- Added [docs/setup/public-webhook.md](docs/setup/public-webhook.md): how to
  make the webhook publicly reachable, with five options (VPS + reverse proxy,
  Cloudflare Tunnel, an existing reverse proxy, temporary dev tunnels, and
  self-hosted tunnels), secure Caddy and nginx examples with trust-boundary
  notes, and a symptom/cause troubleshooting table. README now links to it
  from the prerequisites, the webhook setup step, and the gateway-reachability
  note.

## [0.1.10] - 2026-08-20

### Documentation

- Added a prominent link identifying the GitHub repository as public and open
  source on both GitHub and the rendered ClawHub package page.
- Replaced repository-relative footer links with absolute GitHub URLs so they
  also work when the README is rendered on ClawHub.
- Updated README image URLs to follow the public `main` branch and removed an
  accidental line of unrelated text.

## [0.1.9] - 2026-08-20

### Added

- **OAuth capability profiles with non-destructive validation (issue #93).**
  A centralized capability matrix (`src/capabilities.ts`) defines every OAuth
  scope the plugin uses, organized into two profiles: **runtime** (DM send,
  channel send, message edit, user/channel lookup, reactions, media, streaming)
  and **setup/maintenance** (bot read, bot/handler update). Each capability
  declares its required grant type (`client_credentials` vs `refresh_token`),
  whether it is optional (degrades features, not messaging), and a
  non-destructive API probe for validation. `openclaw doctor` now warns when
  a configured account is missing `refreshToken` — identifying blocked
  capabilities by name and degraded optional features — instead of silently
  failing at delivery time with `oauthtoken_scope_invalid`. Canonical
  comma-separated scope strings for runtime, setup, and combined profiles are
  documented in README §3b. The `inspectAccount` output now includes
  `scopeProfiles` (runtime/setup/full canonical strings). Grant-type
  requirements are documented for every capability. Optional features
  (reactions, media download, message read, message delete, channel card v3)
  are reported as degraded/skipped when their scopes are missing, not as
  errors that block unrelated messaging.
- **Real OpenClaw gateway ingress integration coverage (issue #102).** The CI
  smoke test now loads the built plugin into an isolated gateway, exercises
  authenticated DM and group webhook delivery, verifies deduplication and
  outbound routing, and checks that credentials never leak into captured logs.

### Fixed

- **Passive webhook accounts now remain running (issue #98).** The Cliq channel
  registers a passive gateway lifecycle task, reports `mode: "webhook"` and
  `/cliq/webhook`, and no longer appears stopped or enters the health monitor's
  restart loop while its HTTP webhook transport is healthy.
- **Webhook ingress fails closed without a configured secret (issue #101).** A
  missing server-side `webhookSecret` returns `503`; a missing or incorrect
  request secret returns `401`. Neither path parses or dispatches the payload.

## [0.1.8] - 2026-08-05

### Fixed

- Missing `channels.cliq.thinking` objects now resolve to the documented
  animated placeholder defaults (`mode: "placeholder"`, `animate: "dots"`).
  OpenClaw applies defaults to fields inside an existing object but does not
  create an omitted parent object, so existing single-account configs silently
  fell back to `off` despite the manifest defaults.
- Top-level single-account configurations are now discovered as the implicit
  `default` account, so deep health checks no longer report Cliq as
  "not configured" while the channel is active and replying normally.
- Status snapshots now accept OpenClaw's redacted `inspectAccount` shape as
  well as the runtime account shape; the previous resolver looked for secret
  credentials in the redacted snapshot and incorrectly marked it disabled.

### Documentation

- Corrected the single-account example: the default account belongs directly
  under `channels.cliq`, not under `channels.cliq.accounts.default`.
- Added an agent-assisted Zoho MCP onboarding and verification workflow, while
  documenting that OAuth credentials and the webhook secret still need to be
  supplied separately.
- Removed a duplicated/corrupted REST API compatibility sentence.

## [0.1.7] - 2026-07-09

### Fixed

- **DM messages are no longer wrongly dropped as duplicates (intermittent "bot went silent" / "command did nothing").**
  A Cliq bot Message handler delivers `message` as a bare string with no
  `message.id` **and** no `message.time`, so the plugin derives a synthetic
  message id. That id hashed only `sender + chat + (time?) + attachments` — for a
  text DM (no time, no attachment) it reduced to a **constant** `hash(sender +
  chat)`, identical for every message a user sent in that chat. With the 30-min
  dedupe TTL, the first message was processed and **every subsequent message was
  dropped as a "duplicate" for 30 minutes** (until a gateway restart cleared the
  in-memory cache) — which looked like random flakiness: `/model` worked once,
  then a follow-up `hallo`/`/model`/`/models` "did nothing" and the bot appeared
  dead. The synthetic id now includes the message **text**, so distinct messages
  get distinct ids and are all processed; a genuine Cliq redelivery of the same
  message still hashes identically and is still correctly deduped. See
  `docs/learnings/110-*`.

- **Slash commands (`/model`, `/models`, `/commands`) now work in Cliq DMs with the thinking placeholder active (issue #91).**
  The SDK's `resolveCommandTurnContext` requires `CommandSource: "native"` and
  `CommandAuthorized: true` on the inbound context to route a message through the
  native command handler (which calls `build*ChannelData` and produces interactive
  buttons). The Cliq plugin only set `CommandBody` — the SDK defaulted to
  `kind: "normal"`, treating `/model` as plain text. The native command handler
  never fired, `deliver` was never called with `channelData`, and the placeholder
  was cleaned up to `⚠️ Couldn't process that message.` The context now sets
  `CommandSource: "native"` + `CommandAuthorized: true` for all `/`-prefixed
  messages (except abort intents, which keep `CommandSource: "text"`).

- **A no-block turn no longer wedges the DM session (issue #91, Part 2).**
  When a turn produced no reply block (agent error, empty response, or a
  mis-routed command), the thinking placeholder was edited to the failure notice
  via a raw `client.editMessage` call that bypassed the live-edit deliver path.
  The SDK's delivery lifecycle never saw a `deliver` call for the turn, leaving
  the session in `state=processing` and queuing all subsequent messages until
  stuck-session recovery (~127 s). The cleanup now routes through the live-edit
  `deliver` callback, which (a) sets `placeholderConsumed`, (b) handles edit
  failures gracefully (delete placeholder + fresh send fallback), and (c)
  completes the delivery lifecycle so the session is released promptly.

- **Command menus (`/model`, `/models`) now deliver as plain text instead of failing the send.**
  Follow-up to #91: with native routing fixed, the model-menu *card* still failed
  live with HTTP 400 — the Cliq REST API rejects the `invoke.bot` button action
  the quick-reply menus rely on (`Unidentified value passed for the 'type' key`
  on both the bot-message and chat endpoints; nested `card.buttons` is rejected
  as `extra_key_found`). `invoke.bot` is the only action that re-posts a slash
  command back to the bot, so an interactive menu is not deliverable on this
  Cliq API — the failed card send left the placeholder as
  `⚠️ Couldn't process that message.` The `cliqCommandsAdapter` now returns `null`
  for the model-menu builders, so the runtime delivers the command's own reply
  **text** (which lists the `/model <provider>/<model>` refs to type) — model
  switching works without the interactive menu. The button builders + their tests
  are retained to restore the menus if Cliq starts accepting `invoke.bot`. See
  `docs/learnings/109-*`.

- **Inbound image/file DM no longer aborts or leaves an orphaned placeholder (issue #88).**
  Three bugs that caused a real Cliq bot-DM image to show `💭 …` then nothing:

  1. **Placeholder cleanup now edits instead of deleting.** Zoho rejects
     `DELETE /api/v2/chats/{chatId}/messages/{messageId}` for bot messages with
     HTTP 400 `message_delete_failed`, so the old cleanup path left an orphaned
     `💭 …`. The cleanup now always edits the placeholder into a user-visible
     notice (`thinking.failureText` or the default `⚠️ Couldn't process that
     message.`); no delete is attempted. The `thinking.failureText` field is
     unchanged — if set, it is used; otherwise the default notice is used.

  2. **`ackPolicy: "immediate"` now handles session-init conflicts gracefully.**
     The `after_dispatch` branch already treated `"reply session initialization
     conflicted"` as a benign transient (warn, ack 200, stop retrying). The
     `immediate` branch logged it as an error. Now both branches handle it the
     same way: warn-level log, no scary error state.

  3. **Empty-id image/file messages now get a stable synthetic message id.** A
     Cliq bot Message handler delivers `message` as a plain string, so
     `message.id` is empty for image/file messages. Without a stable id,
     `MessageSid` was empty and the dispatch path could self-conflict on retries
     (`"reply session initialization conflicted"`). The parser now derives a
     deterministic `syn:<hash>` id from sender + chat + attachments + timestamp
     when the real id is absent, so dedupe and session init are robust. The
     dedupe layer uses the synthetic id directly as the key (the `mid:` path),
     so duplicate/retied deliveries are suppressed instead of self-conflicting.

- **Inbound image analysis requires a vision-capable model or explicit
  `tools.media.image` provider (issue #88, documented limitation).** Plugin
  channels (like Cliq) attach images via `MediaPath` flat fields, which the
  runtime routes through the `media-understanding` describe pipeline. Bundled
  channels (Telegram/Discord) can pass images inline to the LLM directly. When
  the primary model is text-only and no `tools.media.image` provider is
  configured, the describe pipeline fails with `"Model does not support images"`.
  The turn now degrades gracefully (placeholder edited to a notice, no orphan)
  instead of aborting. To get image analysis, configure a vision-capable primary
  model, a `tools.media.image` provider, or ensure a vision-capable model is in
  the fallback chain. See `docs/learnings/106-*.md` for the technical details.

- **Inbound bot-DM image/file upload now works end-to-end (issue #87).** Three
  latent bugs from #84 only surfaced on a real image send:
  1. `listChatMessages` sent an invalid `from=0` query param that Zoho rejects
     with HTTP 400 (`extra_param_found`). Removed — `?limit=N` alone returns 200.
  2. `parseCliqChatMessages` required a `chat_id` on each message object, but
     `GET /api/v2/chats/{chatId}/messages` returns no per-message `chat_id`
     (the chat id is only in the request URL). The parser now accepts the
     request-context chat id as a fallback, so file messages are no longer
     silently discarded.
  3. Downloaded media was written to a plugin-chosen temp dir (`/tmp`) that the
     agent's image tool refused as "not under an allowed directory". The
     download now stages into the media-store `inbound` bucket via
     `saveMediaBuffer` (the SDK's canonical pattern), producing a `media://`
     path the runtime trusts automatically. The vestigial `mediaDir` plumbing
     and dead helpers (`sanitizeFileName`, `inferExt`, `MIME_TO_EXT`) were
     removed.

- **The `apiVersion` manifest schema no longer forces a `"v2"` default that
  silently overrode the per-family code defaults (issue #86).** The manifest
  declared `apiVersion` as a string with `"default": "v2"`; OpenClaw injects
  manifest config-schema defaults at runtime, so the resolved config got
  `apiVersion: "v2"` even when the operator set nothing — which
  `normalizeCliqApiVersionConfig` then read as a GLOBAL `"v2"` override,
  defeating the `dmPost: "v3"` code default shipped in #85. Net effect: the
  v3 bot-DM path (and the thinking-placeholder + DM live-edit-in-place it
  unlocks) was dead unless the operator manually set `apiVersion: "v3"`. The
  schema now accepts BOTH the string global override AND the per-family
  object `{ dmPost?, channelPost?, channelCard?, delete? }` (each
  `enum ["v2","v3"]`), and declares **no default** — so an omitted
  `apiVersion` stays `undefined` through resolution and the code's
  `CLIQ_API_FAMILY_DEFAULTS` apply (`dmPost → "v3"`, the rest `"v2"`). The
  temporary global `apiVersion: "v3"` override on the live bot can now be
  removed so the channel-card / channel-post families fall back to v2
  correctly.

### Added

- **Animated "thinking" placeholder (issue #86).** A new `thinking.animate`
  config optionally cycles the placeholder through text frames on an interval
  while the agent turn runs (Cliq has no native typing indicator — this
  simulates one via periodic edits), then edits it into the final reply when
  the reply arrives. `"off"` (default) is a static placeholder; `"dots"`
  cycles `💭 .` → `💭 ..` → `💭 ...`; `"spinner"` cycles braille-spinner frames
  prefixed with a fixed `thinking…` label; `"custom"` cycles
  `thinking.animateFrames` (a string array — needs ≥2 non-empty entries or it
  degrades to the static placeholder). The interval is
  `thinking.animateIntervalMs` (default 1200 ms, **hard-floored to 800 ms** to
  protect the Cliq edit rate limit) and the total animation duration is capped
  (default 60 s — past the cap the animation stops and holds the last frame).
  The animation reuses the existing `editMessage` path (`Messages.UPDATE`,
  same `refreshToken` precondition as the placeholder itself); a failed frame
  edit stops the animation but never breaks the turn (the reply is still
  delivered). Only one animation runs per in-flight message — it is stopped
  the moment the reply (or failure text) arrives so a late frame edit can
  never clobber the reply. New config fields under `channels.cliq.thinking`:
  `animate`, `animateFrames`, `animateIntervalMs`. No new OAuth scope.

### Fixed

- **The v3 bot-DM send path no longer 400s, and DMs now return the sent
  message id (issue #85).** The v3 "Send a bot message" endpoint
  (`POST /api/v3/bots/{botId}/messages`) requires the recipient key
  **`userids`** (v2-style, no underscore) — the plugin was sending `user_ids`,
  which the endpoint rejected with `extra_key_found`. With `sync_message: true`
  the response carries the sent `message_id` + `chat_id` under
  `message_details.<userId>` (URL-encoded — `…995%20…547`, `%20` = a space);
  the parser now decodes it once so the v2 edit/delete URL builder encodes it
  exactly once (no double-encode / stray `%2520`). This is what the
  `thinking.mode: "placeholder"` acknowledgement and DM live-edit-in-place
  need to edit the placeholder into the final reply; on the broken path they
  silently left an orphaned `💭 …`.

### Changed

- **`apiVersion` is now per-family, and the bot-DM family defaults to v3
  (issue #85).** `apiVersion` now accepts EITHER a string global override
  (`"v2"` / `"v3"` — forces all migratable families) OR a per-family object
  `{ dmPost?, channelPost?, channelCard?, delete? }`. The built-in defaults
  now flip **`dmPost` → `"v3"`** (the sole family where v3 is strictly
  better: it returns the sent message id, unlocking the thinking placeholder
  + DM live-edit-in-place that v2 DM cannot support); `channelPost`,
  `channelCard`, and `delete` stay `"v2"` (v3 channel text post returns no
  message id; v3 channel card posts as the authenticated user, not the bot;
  v3 delete offers no functional win). The bot-DM v3 path uses the *same*
  `ZohoCliq.Webhooks.CREATE` scope as v2 DMs (`client_credentials`, **no
  refresh token needed**), though some orgs may additionally require
  `ZohoCliq.BotMessages.CREATE` — if yours does, restore the v2 path with
  `apiVersion: { dmPost: "v2" }`. Locked families (message edit, reactions,
  media posts, directory listing, file download, channel-chat-id resolution,
  message list) stay on `/api/v2/...` regardless — v3 has no endpoint for
  them (a v3-posted DM is edited via the v2 edit endpoint; that hybrid is
  intended). See README §4 for the full per-family table. There are no
  foreign installations yet, so the default change is safe.

### Fixed

- **Inbound file / image messages sent to the bot no longer fail (issue #84).**
  A Zoho Cliq bot **Message handler** delivers `attachments` as an array of bare
  file-name strings (no file id, no MIME) — unlike the rich *message object*
  the inbound-media path was built against. A caption-less image was rejected
  as `400 invalid payload` (no text, no resolvable attachment); an image with a
  caption dispatched but the file never reached the agent, and a redelivery
  during session init tripped a `reply session initialization conflicted`
  retry storm. Two independent fixes:

  - **Robustness.** The parser now recognizes name-only `attachments` (string
    entries and object entries without an `id`); a caption-less file
    dispatches with a useful body (`<file: <name>>`, or `<file: <name>>` + the
    caption when present) instead of `400 invalid payload`. The dedupe key
    incorporates the attachment names when `messageId` is empty, so Cliq's
    ~20 s retries of the same upload are deduped as `duplicate`/`inflight`
    (acked `200`) instead of re-dispatched. A `reply session initialization
    conflicted` dispatch error is acked `200` so Cliq stops retrying instead of
    looping the conflict.
  - **File-id resolution.** A name-only attachment is enriched with a real file
    id (best-effort) via `GET /api/v2/chats/{chatId}/messages` — the uploaded
    file exists as a `type:"file"` message with `content.file.{id,name,type}`,
    which `downloadAttachment` then fetches. Only attempted when an attachment
    is name-only, a `chatId` is present, and a `refreshToken` is configured; a
    failed resolution degrades to "no media for that attachment" (the name
    still surfaces in the body). Never breaks the turn.

### Added

- **`ZohoCliq.Messages.READ` scope** (refresh-token grant). Required to resolve
  an inbound attachment's file id from the chat-messages list (and to fetch the
  quote/reply parent text). Added to the §3b scope list and the §3c scope
  string; skip it for a text-only bot and inbound images degrade to name-only.

### Changed

- **The §5 Deluge Message/Mention handler now forwards the `attachments`
  argument.** Existing installs that don't update the handler keep working
  exactly as before (text messages unaffected); updating is required for
  inbound image / file messages to dispatch (without it, a caption-less image
  is still `400 invalid payload` and an image with a caption still drops the
  file). The forward guards against a null `attachments` (text-only messages).

## [0.1.6] - 2026-07-07

### Changed

- **Scopes (§3b) and Configuration (§4) reference sections are now lists, not
  tables.** ClawHub renders README tables with `table-layout: fixed` and a very
  narrow (~60px) first column, which char-wrapped the first-column code
  identifiers (e.g. `clientSecret` stacked one letter per line). Rewriting these
  two dense reference tables as bullet lists renders cleanly on ClawHub while
  staying readable on GitHub. The Data centers table is kept (short region names
  in the first column wrap fine). Documentation only — content is unchanged.

## [0.1.5] - 2026-07-07

### Fixed

- **Header logo now renders on the ClawHub package page.** In 0.1.4 the logo
  pointed at an external CDN (`sprintcx.net`); ClawHub proxies README images
  through Vercel image optimization, which rejects non-allowlisted domains with
  HTTP 400, so the logo showed as broken there (the file itself was reachable).
  It now uses the same tag-pinned `raw.githubusercontent.com` URL as the
  screenshots — an allowlisted domain that the proxy optimizes. Documentation
  only; no plugin or runtime behavior change.

## [0.1.4] - 2026-07-07

### Fixed

- **README renders correctly on ClawHub.** The logo and screenshots now use
  absolute image URLs (the logo via CDN, the screenshots via tag-pinned GitHub
  raw URLs) instead of repo-relative `assets/…` paths, which ClawHub could not
  resolve on its package page — the images showed as broken. Separately, the
  **Features** section is now a bullet list instead of a two-column table:
  ClawHub renders README tables with `table-layout: fixed` and a very narrow
  first column, which char-wrapped the feature labels (e.g. "Messaging" became
  "Mess aging"). Purely a documentation/presentation change — no plugin or
  runtime behavior is affected.

### Documentation

- Document the ClawHub publish source-commit gotcha in
  [RELEASING.md](RELEASING.md): a manual publish must pass the **commit** SHA
  (`git rev-parse vX.Y.Z^{commit}`), not an annotated tag's object SHA, or
  ClawHub builds a broken `raw.githubusercontent.com` image URL. CI is
  unaffected — it uses `github.sha`.

## [0.1.3] - 2026-07-07

### Added

- **Cliq Forms — parameter capture (button-click re-entry as structured
  input).** An agent-rendered form's prompt-card button click now re-enters
  as a structured `FormValues` entry on the inbound context (structured
  params for a tool call) rather than plain text. Each prompt-card button
  posts a `__cliq_form__ <fieldName>=<value>` sentinel payload back to the
  bot; the inbound path recognizes the sentinel, parses the
  `<fieldName>=<value>` pair (split on the first `=`, so a value may contain
  `=` or spaces), and surfaces it as `FormValues: { <fieldName>: <value> }`
  on the inbound context — the same surfacing the Cliq platform Form Handler
  path uses, so an agent tool can read the answer as structured data. The
  agent envelope body is the clean `<fieldName>: <value>` rendering (sentinel
  stripped). A button click is a directed action at the bot, so a group form
  response is admitted without a separate @mention, and it bypasses the
  `thinking.confirm` sensitive-keyword gate (a structured submission is an
  explicit action, not free text). Free-text replies to the summary card
  (text / number fields, or overflow select options) are NOT sentinel-
  prefixed and re-enter as ordinary message text. No new OAuth scope, no new
  config field — the structured re-entry is automatic for any
  `message(action=send, form=…)` prompt-card button click. The final
  increment of the Phase 3 "Outbound Cliq Forms" item (sub-part c —
  parameter capture). See README §5c.

- **Cliq Forms — outbound structured-input renderer.** The agent can now
  **solicit** structured input by rendering a form as a native Cliq `prompt`
  card with a button per option — the portable equivalent of a Cliq platform
  Form, emitted on demand. The shared `message` tool accepts a new `form`
  param (`message(action=send, to=…, form={ title?, fields: [{ name, label?,
  type?: "select"|"text"|"number", options?, placeholder? }] })`). Each
  `select` field with ≥2 options becomes a `prompt`-theme Message Card (a
  button per option, capped at 5; extras listed in the card body); `text` /
  `number` fields fold into a single `modern-inline` summary card posted
  first, listing each as a question with a `reply with <name>: <value>` hint.
  Tapping a button posts a `__cliq_form__ <fieldName>=<value>` sentinel back
  to the bot (see the parameter-capture entry above for the structured
  re-entry). An optional `message` param prefixes the first card's text as
  extra context. A degenerate form (no viable fields) returns an error so
  the agent can correct and retry. The `form` param takes precedence over
  `buttons` / `theme` / `slides` when present. No new OAuth scope — prompt
  cards reuse the same card-path scopes (`Webhooks.CREATE` for DM cards via
  `client_credentials`; `Channels.UPDATE` on v2 / `Channels.CREATE` on v3
  for channel cards) the existing `message(action=send, buttons=…)` path
  uses. No new config field. The first increment of the Phase 3 "Outbound
  Cliq Forms" item (sub-part a — the renderer). See README §5c.

- **Form-driven DM pairing approval.** When `dmPolicy` is `pairing`, an
  unknown sender's pairing request can now be approved inline from Cliq
  instead of running `openclaw pairing approve cliq <code>` on the CLI. Set
  the new `channels.cliq.pairing.notifyOwnerTarget` config field to a Cliq
  route target (`cliq:user:<zohoUserId>` / `user:<zohoUserId>` /
  `cliq:channel:<uniqueName>` / `channel:<uniqueName>`; a bare string is a DM
  user id) and the pairing flow additionally posts an approval **prompt
  card** to that target (Approve / Deny `invoke.bot` buttons carrying the
  sender id + pairing code). The owner taps **Approve** to admit the sender
  (the plugin calls the SDK's `approveChannelPairingCode`, writing the
  sender to the channel allowFrom store, and DMs the sender that they were
  approved) or **Deny** to dismiss (the pending request is left in place;
  the sender is re-challenged idempotently if they message again). The CLI
  step keeps working alongside the card. The button click arrives as an
  ordinary inbound message and is short-circuited before the mention /
  admission gates so the owner need not be on the allowlist to approve.
  Optional overrides: `approveLabel` / `denyLabel` / `approvalTitle` /
  `approvedOwnerText` / `deniedOwnerText`. Requires `botId`; no new OAuth
  scope (reuses the card-path scopes). The second increment of the Phase 3
  "Outbound Cliq Forms" item (sub-part b — pairing approval); parameter
  capture (sub-part c) follows. See README §4 (`pairing` config row).

- **Cliq Forms — inbound structured input.** When a Zoho Cliq platform
  **Form** is submitted, the bot's **Form Handler** Deluge script can forward
  the submitted field values to the OpenClaw webhook (`/cliq/webhook`) and
  the plugin now recognizes it as a form submission, synthesizing the
  agent-readable message body from the submitted values (e.g. `Form:
  approval_request\napprover: alice@corp.com\npriority: High`). The raw
  structured values are ALSO surfaced on the inbound context as `FormValues`
  (a string-keyed map) and `FormName` (the form's display name) so an agent
  tool or downstream flow can read them as structured data rather than
  parsing the body text — the foundation for approval / collection flows
  (pairing approval, parameter capture) instead of free-text parsing. A form
  submission is treated as a directed action at the bot: a group form
  submission is admitted without a separate @mention (the same way a reply
  to the bot is). DM admission (`dmPolicy` / `allowFrom`) and self-message /
  dedupe guards apply unchanged; form submissions bypass the `thinking.confirm`
  sensitive-keyword gate (a structured submission is an explicit action, not
  free text to keyword-match — a "reason: delete prod" field does not trip
  the gate). A form whose every field is empty is dropped (no agent-readable
  content). The payload is recognized when `handler: "form"` and/or a non-
  empty `values` object is present (also accepted under `form.values` /
  `form_data` / `formvalues`, including inside a `params` wrapper); field
  values may be primitives, arrays (multi-select), or Cliq `{ label, value }`
  dropdown objects. No new OAuth scope — the Form Handler is a bot handler
  that posts to the webhook over the same `x-cliq-webhook-secret`-
  authenticated transport as Message / Mention / Welcome. No opt-in config
  field — if no form is wired up, no form submissions arrive. The first
  increment of the Phase 3 "Cliq Forms for structured input" item. See
  README §5b for the Deluge Form Handler script + payload reference.

- Confirmation buttons for sensitive actions (`thinking.confirm`): when
  `thinking.mode === "card"` and `thinking.confirm` is set (`"sensitive"` or
  `"always"`), a sensitive inbound message is gated behind an explicit
  Confirm / Cancel button card instead of dispatching the agent immediately.
  A `prompt`-theme Message Card titled `thinking.confirmText` (default
  `⚠️ Confirm action?`) with `thinking.confirmLabel` / `thinking.cancelLabel`
  buttons (defaults `Confirm` / `Cancel`) is posted and the agent turn is
  held until the user taps a button. **Confirm** re-posts the original
  message (prefixed with a `__cliq_confirm__` sentinel) so the next webhook
  call dispatches the agent with the gate skipped (no re-prompt loop);
  **Cancel** posts a `__cliq_cancel__` sentinel that short-circuits the turn
  with `thinking.cancelledText` (default `🚫 Cancelled.`) and no agent
  dispatch. The button clicks arrive as ordinary inbound messages via the
  bot's Message handler (`invoke.bot`) — no Cliq Context handler is required,
  so this works with the existing Deluge webhook wiring. `"sensitive"` mode
  matches the cleaned message against `thinking.confirmKeywords` (case-
  insensitive word-boundary match; defaults to a conservative destructive-
  verb list — `delete`, `drop`, `reset`, `wipe`, `purge`, …); `"always"`
  gates every turn (apart from abort intents and Confirm re-dispatches).
  Messages longer than 1500 chars bypass the gate (cannot be safely encoded
  in the confirm button payload). The gate is a UX guardrail, not a security
  boundary — the agent's own tool / permission policy still applies to the
  confirmed action. A failed confirm-card post is swallowed + reported and
  falls through to a normal dispatch. New optional `thinking.confirm`,
  `thinking.confirmKeywords`, `thinking.confirmText`, `thinking.confirmLabel`,
  `thinking.cancelLabel`, and `thinking.cancelledText` config fields (under
  `channels.cliq.thinking`, card-mode only). No new OAuth scope (reuses the
  card-path + `Messages.UPDATE` scopes). Completes the Phase 3 "interactive
  status card: confirmation buttons for sensitive actions" item.
- Status card phase transitions (`thinking.mode === "card"`): the status
  card now advances its title through explicit phases as the turn runs rather
  than only swapping for the reply. The card is first posted with the
  "thinking" phase title (`thinking.thinkingText`, default `💭 thinking…`),
  then edited in place to the "generating" phase title (`thinking.text`,
  default `Generating…`) right before the agent turn dispatches, and finally
  edited into the reply text when the reply arrives (the existing
  edit-into-reply path). The thinking→generating edit reuses the v3
  `modern-inline` card renderer and the existing `editMessage` path; it is
  best-effort (swallowed + reported on failure, never breaks the turn) and
  resolves the chat id lazily for group posts (cached on the client). The
  `failed`/no-reply tail (edit to `thinking.failureText` or delete) is
  unchanged. New optional `thinking.thinkingText` config field (under
  `channels.cliq.thinking`, card-mode only, default `💭 thinking…`). No new
  OAuth scope. The second increment of the Phase 3 "interactive status card
  (thinking → generating → done)" item — the phase transitions.
- Thinking status card mode (`thinking.mode === "card"`): a new instant-
  acknowledgement style that posts a v3 Message Card status indicator (a
  `modern-inline` card titled with `thinking.text`, default `Generating…`)
  instead of the plain-text `💭 …` placeholder. On `apiVersion: "v3"` this is
  a real card posted via `CliqClient.sendCard` (DM via
  `POST /api/v3/bots/{botId}/messages` with scope `ZohoCliq.Webhooks.CREATE`,
  channel via `POST /api/v3/channels/{name}/message` with scope
  `ZohoCliq.Channels.CREATE`); on v2 it degrades to the plain-text placeholder
  (v2 has no buttonless card). The card becomes the `initialDraft` the
  existing live-edit flow replaces — when the reply arrives the card is edited
  into the reply text in place (when the edit API accepts a card→text swap) or
  deleted + the reply sent fresh (the existing edit-failure fallback); on a
  no-reply turn the card is edited to `thinking.failureText` or deleted (the
  existing cleanup path). Same gating as `placeholder` mode: a no-op when
  `streaming.preview` is `"on"`, when no `refreshToken` is configured, or for
  an abort-intent turn. No new OAuth scope (reuses the card-path +
  `Messages.UPDATE` scopes). The first increment of the Phase 3 "interactive
  status card (generating → done)" item — the "generating" card surface.
- Thinking-placeholder cleanup on no-reply turns: when the instant-
  acknowledgement placeholder (`thinking.mode === "placeholder"`) is enabled
  and the agent turn ends **without producing a reply** (the turn threw, or
  the dispatcher flushed no blocks), the untouched `💭 …` placeholder is no
  longer left stray. New optional `thinking.failureText` (string, under
  `channels.cliq.thinking`) edits the placeholder into an explicit failure
  indicator (e.g. `⚠️ No reply generated.`) instead of deleting it; when
  `failureText` is unset (the default), the placeholder is **deleted** so no
  stray `💭 …` lingers (consistent with the existing "no stray placeholder"
  contract on edit failure). The cleanup runs in a `finally` so a throwing
  `inbound.run` still cleans up; the failure-text edit falls back to a delete
  if the edit is rejected, and a failed cleanup is swallowed + reported via
  `onError` (`kind: "thinking-placeholder-cleanup"`) so it never breaks the
  turn. Group/channel placeholders resolve the chat id lazily before cleanup
  (the send response carries no chat id). The feature reuses the existing
  `ZohoCliq.Messages.UPDATE` scope (no new OAuth scope). Exposed
  `getLiveEditPlaceholderConsumed(deliver)` on the live-edit deliver for the
  inbound path to detect the untouched-placeholder case. The first increment
  of the Phase 3 "interactive status card (thinking → generating → done /
  failed)" item — the "failed" tail.
- REST API v3 Message Card `modern-inline` `sections` + `thumbnail`
  (issue #73): the remaining v3 Message Card surfaces per
  <https://www.zoho.com/cliq/help/restapi/v3/messagecards/>. Both are
  `modern-inline`-only in-card fields (NOT top-level slides — they nest
  inside `card` alongside `title` / `buttons`) and are ignored for `prompt` /
  `poll` themes and on v2. `thumbnail` (string) is a publicly accessible HTTPS
  URL shown in the card header next to the title; non-HTTPS / empty / over-
  length URLs are dropped silently. `sections` is an array of
  `{ title?, fields: [{ title, value }] }` labeled field groups; the renderer
  (`normalizeV3Section` / `normalizeV3Sections` in `src/v3-card.ts`) clamps
  section titles + field values, drops fields with an empty title OR value,
  drops empty sections, and caps sections (10) + fields-per-section (50) at
  defensive limits — invalid entries never fail the whole send. Wired behind
  `apiVersion: "v3"` in `CliqClient.sendCard` for BOTH the channel
  (`POST /api/v3/channels/{name}/message`, scope `ZohoCliq.Channels.CREATE`)
  and DM (`POST /api/v3/bots/{botId}/messages`, scope
  `ZohoCliq.Webhooks.CREATE`) v3 paths via new optional `thumbnail` + `sections`
  fields on `SendCardMessageOptions` / `CliqV3CardInput`. The agent-facing
  surface is the shared `message` tool: `message(action=send,
  thumbnail="https://…", sections=[{ title, fields: [{ title, value }] }])`
  attaches a header image + labeled field groups to a card send (combined with
  `buttons` / `theme` / `pollOptions` / `slides` / `message` text as usual);
  on v2 / unconfigured v3 the fields are ignored. No new OAuth scope (reuses
  the existing card-path scopes).
- REST API v3 Message Card supporting-content `slides` (issue #70): the
  remaining v3 Message Card slide surfaces per
  <https://www.zoho.com/cliq/help/restapi/v3/messagecards/>. `slides` is a
  top-level array that sits alongside `card` (NOT nested inside it) and is
  compatible with ALL card themes (`modern-inline`, `prompt`, `poll`). Each
  entry is a discriminated-union `{ type, title?, ... }` block whose `data`
  payload structure is per-type: `table` (`{ headers: string[], rows:
  Record<header,string>[] }` — a data table), `list` (`string[]` — a bulleted
  list), `label` (`Array<{ label, value }>` — key/value pairs), `images`
  (`string[]` — publicly accessible HTTPS image URLs; non-HTTPS dropped), and
  `text` (`string` — a plain / formatted text block). The renderer
  (`normalizeV3Slide` / `normalizeV3Slides` in `src/v3-card.ts`) validates +
  clamps each slide (drops empty headers / list items / label pairs, enforces
  HTTPS-only image URLs, caps headers/rows/items/images/slides at defensive
  limits, ellipsizes over-length cells + titles) and silently drops invalid
  slides so a malformed slide never fails the whole send. The input `slides`
  are appended to the payload's `slides` array AFTER the text-remainder slide
  derived from the card `text` (so a card with a multi-line body + a table
  slide emits `[ { type: "text", data: <remainder> }, { type: "table", ... } ]`).
  Wired behind `apiVersion: "v3"` in `CliqClient.sendCard` for BOTH the channel
  (`POST /api/v3/channels/{name}/message`, scope `ZohoCliq.Channels.CREATE`)
  and DM (`POST /api/v3/bots/{botId}/messages`, scope
  `ZohoCliq.Webhooks.CREATE`) v3 paths via a new optional `slides` field on
  `SendCardMessageOptions` / `CliqV3CardInput`. The agent-facing surface is
  the shared `message` tool: `message(action=send, slides=[{ type: "table",
  headers: [...], rows: [...] }, ...])` attaches structured content to a card
  send (combined with `buttons` / `theme` / `pollOptions` / `message` text as
  usual); on v2 / unconfigured v3 the slides are ignored. No new OAuth scope
  (reuses the existing card-path scopes).

### Changed

- Directory list calls (`listUsers`, `listChannels`) now follow the v3
  `next_token` cursor convention. v3 standardizes ALL list endpoints on a
  two-token model (`next_token` for paging, `sync_token` for incremental
  sync); v2 used six different tokens and the directory endpoints stayed on
  v2 (v3 has no org-directory equivalent — see learning 094). The new
  `paginateList` helper (`src/pagination.ts`) follows a `next_token` cursor
  when the v2 response carries one (v2 `next_token` was one of its six
  tokens) and falls back to `from`/`limit` offset pagination otherwise, so
  the directory is forward-compatible with v3's standardized pagination
  model and is the primitive the future v3 CRUD list endpoints (Phase 4)
  will build on. No config change; behavior is strictly more correct for
  Zoho orgs whose v2 endpoints return a `next_token`.

### Changed

- Outbound error classification + the data-center hint now parse the v3
  `{"message":"…"}` error envelope (issue #67). v3 endpoints return a
  consistent JSON error envelope whose auth-failure phrasings differ from
  v2's tokens (a v3 401 is `Request was rejected because of invalid
  AuthToken.` and a 403 is `The user does not have enough permission…`),
  so the previous pattern set — which matched raw substrings like
  `invalid_token` / `unauthorized` — never fired for v3: a non-EU account
  hitting the EU endpoints via a v3 endpoint got an opaque error with no
  `verify your Zoho data center` pointer. The new `parseCliqErrorBody`
  helper extracts the `message` field; `appendCliqDataCenterHint` and
  `classifyCliqSendResponse` now match patterns against both the raw body
  and the extracted message, and `CliqSendError` exposes an `errorMessage`
  field carrying the extracted text. v2 opaque-string bodies are passed
  through unchanged.

### Changed

- Confirmed channel media posts (`sendMediaMessage`) stay on the v2 multipart
  endpoints indefinitely regardless of `apiVersion` (issue #65). v3 has no
  byte-upload surface — the v3 Messages post endpoints take a JSON
  `{ text, reply_to?, sync_message? }` body with no `attachments` field, v3
  has no Files API, and the only v3 image option is a Message-Card `images`
  slide that accepts public HTTPS image URLs only (no raw bytes) via the
  Message-Card channel endpoint, which posts as the authenticated user (not
  the bot) and needs the user-context refresh token. That path is strictly
  worse than the v2 multipart path (bot sender identity, raw bytes, any MIME
  type), so `CliqClient.sendMediaMessage` stays on `/api/v2/...` for both
  DMs and channel posts even when `apiVersion === "v3"` (locked by a
  regression test in `src/channel.test.ts`). The §3c / §4 v3 opt-in notes in
  the README now state this explicitly. No behavior change — media already
  used the v2 path; this just documents the v3 dead end.

### Added

- REST API v3 `poll` Message Card theme (issue #64): the third v3 Message
  Card theme (alongside `modern-inline` and `prompt`) per
  <https://www.zoho.com/cliq/help/restapi/v3/messagecards/>. The `poll`
  theme renders a voting card — a `title` (the poll question, ≤200 chars,
  same first-line split as the other themes) plus 2–10 `options` (each
  `{ text }`, ≤100 chars). Cliq tracks live vote counts + percentages
  **natively** — a vote does NOT post anything back to the bot (votes are
  counted in-place by Cliq, not surfaced as an inbound message), so poll
  options are NOT action buttons (the `buttons` field is ignored for a
  poll). `options` is REQUIRED (min 2) per the v3 docs, so the renderer
  returns `null` when fewer than 2 options survive (empties / whitespace
  dropped before counting; options capped at 10, over-length clamped to
  100 chars with an ellipsis) and the caller falls back to the v2 /
  plain-text path (never emits an invalid card). The top-level `text`
  fallback and `slides` (a `text` slide carries the body remainder) apply
  exactly as for the other themes. Wired behind `apiVersion: "v3"` in
  `CliqClient.sendCard` for BOTH the channel
  (`POST /api/v3/channels/{name}/message`, scope `ZohoCliq.Channels.CREATE`)
  and DM (`POST /api/v3/bots/{botId}/messages`, scope
  `ZohoCliq.Webhooks.CREATE`) v3 paths via a new optional `pollOptions`
  field on `SendCardMessageOptions` / `CliqRenderedCard` (a string array;
  `theme: "poll"` selects the theme). The agent-facing surface is the
  shared `message` tool: `message(action=send, theme="poll",
  pollOptions=["A","B",...])` posts a poll (the `message` text is the poll
  question; on v2 / unconfigured v3 it degrades to plain text). The
  `message` tool schema is `null` (params flow through regardless), so the
  new `theme` + `pollOptions` params are documented in the agent prompt
  hints instead. No new OAuth scope (the `poll` theme reuses the same
  scopes as the other card themes: `Channels.CREATE` for channel cards,
  `Webhooks.CREATE` for DM cards). See README §4.

- REST API v3 `prompt` Message Card theme (issue #63): a second v3 Message
  Card theme (alongside the existing `modern-inline`) per
  <https://www.zoho.com/cliq/help/restapi/v3/messagecards/>. The `prompt`
  theme renders a focused quick-reply card — a `title` (the question / alert
  text, ≤200 chars, same first-line split as `modern-inline`) plus 1–5
  action buttons (no `sections` / `thumbnail`, which are `modern-inline`-
  only). `buttons` is REQUIRED for a `prompt` (min 1) per the v3 docs, so the
  renderer returns `null` for a buttonless prompt and the caller falls back
  to the v2 / plain-text path (never emits an invalid card). The same
  v2→v3 button action mapping (`openurl` → `open.url`, `invoke` →
  `invoke.bot` carrying `{ bot_name, message }`), v3 limits (title ≤200
  chars, max 5 buttons, label ≤30 chars), top-level `text` fallback, and
  `slides` (a `text` slide carries the body remainder) apply. Wired behind
  `apiVersion: "v3"` in `CliqClient.sendCard` for BOTH the channel
  (`POST /api/v3/channels/{name}/message`, scope `ZohoCliq.Channels.CREATE`)
  and DM (`POST /api/v3/bots/{botId}/messages`, scope
  `ZohoCliq.Webhooks.CREATE`) v3 paths via a new optional `theme` field on
  `SendCardMessageOptions` / `CliqRenderedCard` (`"modern-inline"` default).
  The slash-command quick-reply buttons emitted by `src/commands.ts`
  (`/models`, `/model`) now set `theme: "prompt"` on their `cliqCard`
  channel-data marker so they render as a Cliq quick-reply prompt under v3
  (the v2 path ignores the field and keeps the raw `buttons` array — no
  behavior change on the default). No new OAuth scope (the `prompt` theme
  reuses the same scopes as `modern-inline`: `Channels.CREATE` for channel
  cards, `Webhooks.CREATE` for DM cards). See README §4.

- REST API v3 opt-in for DM card/button posts (issue #60): the v3 path for
  sending interactive cards (buttons) to a **DM** recipient. Under
  `apiVersion: "v3"`, `CliqClient.sendCard` routes a DM card through the v3
  "Send a bot message" endpoint `POST /api/v3/bots/{botId}/messages` — the
  SAME endpoint the v3 DM **text** post uses — with a top-level `card` field
  carrying the `modern-inline` Message Card body rendered by `src/v3-card.ts`
  (the renderer introduced for v3 channel cards). The v3 bot-message endpoint
  accepts a `card` object directly and posts **as the bot** (sender identity
  preserved — the bot unique name is in the URL path, unlike
  `POST /api/v3/chats/{chatId}/messages` which posts as the authenticated
  user), so **no chat-id resolution is needed**: recipients are addressed via
  `user_ids` (comma-separated), exactly like the v3 DM text post. The scope is
  `ZohoCliq.Webhooks.CREATE` (obtainable via `client_credentials` — **no
  refresh token required** for DM cards in v3 mode, unlike v3 *channel* cards
  which need the user-context `Channels.CREATE` scope). `sync_message: true`
  is set so the response carries `{ data: { message_id, chat_id } }`
  (unwrapped by `parseCliqMessageRef`), giving live-edit streaming for DM
  cards the message id without the nested `message_details` parse the v2
  path needed. The same v2→v3 button mapping, v3 limits (title ≤200 chars,
  max 5 buttons, label ≤30 chars), and "fall back to v2 when the v3 renderer
  yields no payload" contract as v3 channel cards apply. The v2 default is
  unchanged (DM cards use `POST /api/v2/bots/{botId}/message` with `userids`
  + top-level `buttons`). No new OAuth scope (DM cards reuse
  `ZohoCliq.Webhooks.CREATE`). See README §3c and §4.

- REST API v3 opt-in for channel card/button posts (issue #59): the Phase 3
  v3 **Message Cards** renderer. A new `src/v3-card.ts` module converts the
  plugin's existing v2 card/button shape (`CliqButton` / `CliqRenderedCard`)
  into a v3 `modern-inline` Message Card payload per
  <https://www.zoho.com/cliq/help/restapi/v3/messagecards/> — a `card` object
  with `theme: "modern-inline"`, a `title` (first line of the card text,
  ≤200 chars), optional `slides` (a `text` slide carrying the remainder when
  the body text exceeds the title), and action `buttons`. The v2 button
  action mapping: `openurl` + `url` → `{ type: "open.url", data: { web: url } }`;
  `invoke` + `data` (the slash command / message text the Deluge Message
  Handler receives) → `{ type: "invoke.bot", data: { bot_name, message } }`
  (the closest v3 analog, which posts `message` back to the bot so the
  Deluge handler receives it — same loop as v2 `invoke`). v3 limits honored:
  title max 200 chars, max 5 buttons per card (vs v2's 10), button label max
  30 chars. Wired behind `apiVersion: "v3"` in `CliqClient.sendCard` for the
  **channel** (non-DM) path: when `apiVersion === "v3"` and the send targets a
  channel, the card routes through `POST /api/v3/channels/{name}/message`
  (note: `channels`, NOT `channelsbyname`, and singular `message`) with the
  `ZohoCliq.Channels.CREATE` scope (user-context, refresh-token grant — same
  constraint as `Channels.UPDATE`, so a `refreshToken` is still required for
  channel cards in v3 mode) and the `modern-inline` Message Card body. DM
  cards in v3 mode route through the v3 bot-message endpoint's `card` field
  (see the dedicated DM card entry below). When the v3 renderer yields no payload (no text AND all
  buttons dropped during conversion — e.g. all `action: "api"`), the send
  falls back to the v2 path so a degenerate card never fails. The v3 Message
  Card docs do not document a `bot_unique_name` query param, so a v3 channel
  card posts **as the authenticated user** (the OAuth client owner), not as
  the bot — a behavior difference from the v2 channel card path; users who
  need bot sender identity for cards stay on `"v2"`. The 2xx response is
  `{ data: { id, card: {...} } }` (the existing `parseCliqMessageRef` already
  unwraps the v3 top-level `data` wrapper and reads `id`). This is the fourth
  increment of the incremental v3 migration (one endpoint family at a time,
  keeping v2 as the default so the core never regresses): channel media
  posts, message edits / list, reactions, directory, file download, and
  channel-chat-id resolution stay on v2 until their own increments. New
  OAuth scope `ZohoCliq.Channels.CREATE` added to README §3b (scope table)
  and §3c (scope string) — only needed when `apiVersion: "v3"` is set AND you
  send cards to channels; the v2 channel card path reuses `Channels.UPDATE`,
  so if you stay on the `"v2"` default you can skip it. See README §3c and §4.

- REST API v3 opt-in for message delete (issue #56): extending the existing
  `apiVersion` config (`"v2"` (default) | `"v3"`) to also cover the message
  **delete** family. When set to `"v3"`, message deletes route through the v3
  "Delete multiple messages" endpoint
  `DELETE /api/v3/chats/{chatId}/messagess?message_ids=<id>` (the path's
  triple-s `messagess` is the published v3 path, not a typo) instead of the v2
  `DELETE /api/v2/chats/{chatId}/messages/{messageId}` endpoint. v3 Messages
  has NO single-message delete endpoint — only the bulk one — so a single
  delete is a 1-element delete-multiple call. The v3 endpoint uses the
  `ZohoCliq.Messages.DELETE` scope, a user-context scope the
  `client_credentials` grant cannot obtain a usable token for (same
  constraint as `Messages.UPDATE` — see issue #27), so the path routes through
  the refresh-token grant and still requires `refreshToken` to be configured
  (the v2 delete path reuses `Messages.UPDATE`, so the `"v2"` default is
  unchanged). The v3 2xx response is a per-message result list
  `{ type: "message.delete_result", data: [{ id, status, error? }] }` where
  `status` is `"success"` or `"failed"`; for a 1-id delete the response
  carries exactly one entry, and success is `data[0].status === "success"`.
  A 2xx with no/empty/unmatched data is treated as a logical failure
  (returns `false`) — the caller (live-edit best-effort placeholder cleanup,
  message-action `delete`) degrades gracefully, matching the v2 delete
  contract; a non-2xx is classified + retried by `withSendRetry` (transient
  429/5xx retried with backoff, 4xx fatal → throws `CliqSendError`). This is
  the third increment of the incremental v3 migration (one endpoint family
  at a time, keeping v2 as the default so the core never regresses): channel
  card / button posts, channel media posts, message edits / list, reactions,
  directory, file download, and channel-chat-id resolution stay on v2 until
  their own increments. Confirmed against the v3 OpenAPI / REST docs that v3
  Messages has no single-message edit or get endpoint (only delete-multiple,
  post, forward, search) and v3 Chats has no message operations at all, so
  the v2 edit + list-by-chat paths stay v2 indefinitely (dead end for v3).
  Per-account overrides supported (one account can pilot v3 while others
  stay on v2). New OAuth scope `ZohoCliq.Messages.DELETE` added to README §3b
  (scope table) and §3c (scope string) — only needed when `apiVersion: "v3"`
  is set; consent it alongside the existing scopes. See README §3c and §4.

- REST API v3 opt-in for bot DM posts (issue #55): extending the existing
  `apiVersion` config (`"v2"` (default) | `"v3"`) to also cover the bot **DM**
  send family. When set to `"v3"`, bot DMs route through the v3 "Send a bot
  message" endpoint `POST /api/v3/bots/{botId}/messages` instead of the v2
  `POST /api/v2/bots/{botId}/message` endpoint. The v3 endpoint posts **as the
  bot** (sender identity preserved — the bot unique name is in the URL path,
  unlike `POST /api/v3/chats/{chatId}/messages` which posts as the
  authenticated user), uses the `ZohoCliq.Webhooks.CREATE` scope obtainable
  via `client_credentials` (so **no user-context refresh token is required**
  — same as v2 DMs and v3 channel text posts), and uses the v3 body shape
  (`user_ids` comma-separated string instead of v2's `userids`, plus
  `sync_message: true`). With `sync_message: true` the v3 response carries
  `{ data: { message_id, chat_id } }` (unwrapped by the shared
  `parseCliqMessageRef`, which now also handles the v3 `data` wrapper) —
  giving live-edit streaming for DMs the message id without the nested
  `message_details` parse the v2 path needed; a `204 No response` (no ids) is
  tolerated and degrades to block-streaming. The v3 docs list the endpoint's
  OAuth scope as `ZohoCliq.Webhooks.CREATE,ZohoCliq.BotMessages.CREATE`; the
  plugin requests only `ZohoCliq.Webhooks.CREATE` (the one `client_credentials`
  can obtain and the existing v2 DM path already uses) — if a Zoho org requires
  the additional `BotMessages.CREATE` scope, keep `apiVersion` at `"v2"`. This
  is the second increment of the incremental v3 migration (one endpoint family
  at a time, keeping v2 as the default so the core never regresses): channel
  card / button posts, channel media posts, message edits / deletes / list,
  reactions, directory, file download, and channel-chat-id resolution stay on
  v2 until their own increments. Per-account overrides supported (one account
  can pilot v3 while others stay on v2). No new OAuth scope required (v3 reuses
  `ZohoCliq.Webhooks.CREATE`). See README §3c and §4.

- REST API v3 opt-in for channel text posts (issue #54): a new `apiVersion`
  config (`"v2"` (default) | `"v3"`, schema-validated in both the top-level and
  `channelConfigs.cliq` schemas with `uiHints`, surfaced in
  `openclaw channels inspect`) routes channel **text** posts through the v3
  endpoint `POST /api/v3/channelsbyname/{name}/messages` when set to `"v3"`. The
  v3 endpoint uses the `ZohoCliq.Webhooks.CREATE` scope — obtainable via
  `client_credentials` — so **no user-context refresh token is required for
  channel text posts** in v3 mode (the v2 channel endpoint requires
  `ZohoCliq.Channels.UPDATE`, which `client_credentials` cannot obtain). This is
  the first increment of the incremental v3 migration (one endpoint family at a
  time, keeping v2 as the default so the core never regresses): DM posts, card
  / button posts, media posts, message edits / deletes / list, reactions,
  directory, and file download stay on v2 until their own increments. v3
  channel posts return `204 No response` (no message id), so live-edit
  streaming for channel posts degrades to block-streaming (still correct, just
  less granular); v3 has no `buttons` field, so `sendCard` stays on v2
  regardless of `apiVersion`. Per-account overrides supported (one account can
  pilot v3 while others stay on v2). No new OAuth scope required (v3 reuses
  `ZohoCliq.Webhooks.CREATE`, which the existing DM path already requests). See
  README §3c and §4.

- Welcome message on subscribe (issue #52): the Cliq bot **Welcome Handler**
  fires when a user subscribes (or re-subscribes) to the bot, but the plugin
  ignored it. A new `welcome` config (`{ enabled, text, textRejoin }`, default
  `enabled: false`, schema-validated in both the top-level and
  `channelConfigs.cliq` schemas with `uiHints`) opts the channel into posting a
  configurable greeting DM to the subscriber when the Deluge Welcome Handler
  forwards the event to `/cliq/webhook` with `handler: "welcome"` (or
  `"subscribe"`) and Cliq's `newuser` boolean. `text` is used for first-time
  subscribers and `textRejoin` for returning ones; both default to a friendly
  greeting and support `{{firstName}}` / `{{lastName}}` / `{{name}}` / `{{id}}`
  / `{{email}}` placeholders resolved from the forwarded `user` object. The DM
  admission policy (`dmPolicy` / `allowFrom`) is honored — a denied sender is
  never greeted, and under the `pairing` policy an un-paired subscriber is
  skipped (the pairing flow owns their first contact). A redelivered subscribe
  event is deduped by subscriber id so the user is never greeted twice. A
  failed greeting send is swallowed + logged and never breaks or delays the
  webhook ack. No new OAuth scope required (greeting DMs use the same
  `ZohoCliq.Webhooks.CREATE` scope as any bot DM, obtained via the existing
  `client_credentials` grant). See README §5a for the Deluge Welcome Handler
  script.
- Stop / abort the running turn (issue #51): sending a stop intent (`stop`,
  `/stop`, `esc`, plus common localized equivalents such as `halt`, `arrête`,
  `停止`, `стop`, …) now interrupts the in-flight agent run for that chat
  instead of queueing another turn behind it. The plugin delegates to the
  OpenClaw runtime's shared fast-abort path (`tryFastAbortFromMessage`), which
  cancels the active session run (`cancelSession` + run-target abort), clears
  queued follow-ups, stops spawned sub-agents, and replies with the canonical
  acknowledgement (`⚙️ Agent was aborted.`) in the same chat. The trigger set
  is the shared one every OpenClaw channel uses — no per-channel trigger list
  to drift out of sync. In a DM any stop intent aborts; in a channel the user
  must `@mention` the bot (`@bot stop`) so the abort is admitted under the
  same mention gate as a normal reply. No new config, OAuth scope, or Deluge
  wiring required.
- Inbound quote / reply context (issue #49): when a user replies to or quotes a
  message in Cliq, the referenced message's id + text + sender are now carried
  into the agent context. The parser reads `message.reply_to` (the documented
  Cliq message id) and tolerates a sibling parent-message object forwarded by
  the Deluge handler under `parent` / `quoted` / `parent_message` /
  `quoted_message` / `reply_to_message`. When only the parent id is present
  and a user-context `refreshToken` is configured, the plugin best-effort
  fetches the parent text via `GET /api/v2/chats/{chatId}/messages` and
  prepends it to the agent envelope as a quoted block (`↩ Replying to <name>:`
  + indented text). A failed or empty fetch degrades to "no quote text" and
  never breaks the turn. A reply to the bot in a group is now also admitted as
  an implicit mention (`reply_to_bot` / `quoted_bot`), so the user no longer
  needs to re-@mention the bot when replying to one of its messages.
- Inbound media attachments (issue #48): images, files, and voice messages a user
  sends are downloaded via the Cliq Files API (`GET /api/v2/files/{id}`, new scope
  `ZohoCliq.Attachments.READ`) and handed to the agent as local media; voice is
  left for the runtime media-understanding pipeline to transcribe. A failed
  download degrades to "no media" for that attachment and never breaks the turn.
  DM-only setups without a `refreshToken` simply skip inbound media.
- Instant acknowledgement / "thinking" placeholder (issue #47): Zoho Cliq
  exposes no bot "typing" REST API, so the bot's progress is invisible until
  the final reply lands (the native "processing" hint is easy to miss). A new
  `thinking` config (`{ mode: "off" | "placeholder", text }`, default `"off"`,
  schema-validated in both the top-level and `channelConfigs.cliq` schemas with
  `uiHints`) opts the channel into posting a lightweight placeholder message
  (default `💭 …`) the moment an inbound message is accepted, then editing it
  in place into the final agent reply — exactly one message, no duplicate. The
  feature is a no-op when `streaming.preview` is on (the live-edit path already
  shows progress) or when no `refreshToken` is configured (editing a message
  needs the user-context token). A failed placeholder post or edit is
  swallowed + logged and never breaks or delays the agent turn; when the
  placeholder cannot be cleanly turned into the reply it is deleted so no
  stray `💭 …` lingers. DMs and channel posts both support it.

## [0.1.2] - 2026-07-06

### Added

- Multi-data-center auto-detection so non-EU Zoho installs work out of the box
  (issue #46):
  - The setup wizard prompts for your Zoho data center (region) first and
    writes `oauthBase` + `apiBase` together from a region→endpoints map (EU
    default; existing region reused on re-run). The printed API Console URL
    matches the chosen region (no more hard-coded `api-console.zoho.eu`).
  - After the first OAuth token exchange, the plugin reads the `api_domain`
    Zoho returns in the token response and self-corrects `apiBase` to the
    matching `cliq.zoho.<tld>` when it disagrees with the configured region
    (the raw `zohoapis` host is mapped back to the Cliq host, never used
    directly); `oauthBase` is left unchanged. Applies to both the
    `client_credentials` and `refresh_token` grants.
  - `openclaw doctor` warns when only one of `oauthBase` / `apiBase` is set, or
    when the two point at different regions.
  - Zoho auth failures (`invalid_client` / `oauthtoken_scope_invalid` / 4xx
    auth) now surface a `verify your Zoho data center` hint on the thrown
    error for both the OAuth token path and the outbound send path.
- Setup guide screenshots: navigating to **Bots & Tools** (profile → My Cliq),
  and the **Edit Handlers** page (where the Deluge script goes into Message
  Handler / Mention Handler).

### Fixed

- Corrected the bot-creation navigation: bots live under **profile picture → My
  Cliq → Bots & Tools**, not a left-sidebar "Bots" entry.

### Changed

- Documented multi-data-center support: the setup guide now uses `.com` (US)
  example URLs with a "pick your data center" callout and anchor, and a new
  **Data centers** section maps every Zoho region to its `oauthBase` / `apiBase`.
  Corrected the outdated "hard-coded EU / file an issue" note — the `oauthBase`
  and `apiBase` config fields (default EU) already select the region. Added
  wizard labels for both fields.

## [0.1.1] - 2026-07-06

### Added

- Product-first README landing: Zoho Cliq logo hero, a 4-step Quick start, and a
  scannable feature/capability table.
- `CI` workflow (`typecheck` · `test` · `build`) on every push and pull request.
- `Publish ClawHub` workflow — publishes to ClawHub on a stable `vX.Y.Z` tag
  push (dry-run on manual dispatch), with a strict `package.json`↔tag version
  check and a GitHub Release carrying the CHANGELOG section as notes.
- Contributor docs: `CONTRIBUTING.md`, `RELEASING.md`, `SECURITY.md`, GitHub
  issue forms, and a pull-request template.

### Changed

- Unified the plugin summary across `package.json`, `openclaw.plugin.json`, and
  `index.ts`.

## [0.1.0] - 2026-07-06

### Added

- Initial public release of the Zoho Cliq channel plugin for OpenClaw.
- Inbound DMs and channel @mentions via a Deluge webhook (`POST /cliq/webhook`);
  outbound as the bot (DMs via `userids`, channel posts via `channelsbyname`).
- OAuth 2.0 dual-grant: `client_credentials` for DMs, a user-context refresh
  token for channel posts and message edits (EU endpoints).
- Rich messaging: Markdown → Cliq formatting, live-edit streaming previews,
  interactive buttons & cards, slash-style commands, reply threading.
- Message actions: edit / delete / react.
- DM security policies (`allowlist` / `pairing` / `open` / `disabled`) with an
  approval flow, plus group admission and per-channel mention & tool policy.
- Reliability: durable-before-ack ingest, de-dup on redelivery, bot-loop /
  self-message protection, outbound retry with error classification, hardened
  webhook auth (constant-time secret compare, failed-auth rate limiting).
- Operations: `openclaw status` / `channels` health probe, `openclaw directory`
  lookup, plugin doctor, interactive setup wizard, SecretRef-backed credentials,
  security audit collector, session binding, multi-account, lifecycle hooks.

[Unreleased]: https://github.com/sprintberlin/openclaw-cliq/compare/v0.1.8...HEAD
[0.1.8]: https://github.com/sprintberlin/openclaw-cliq/compare/v0.1.7...v0.1.8
[0.1.7]: https://github.com/sprintberlin/openclaw-cliq/compare/v0.1.6...v0.1.7
[0.1.6]: https://github.com/sprintberlin/openclaw-cliq/compare/v0.1.5...v0.1.6
[0.1.5]: https://github.com/sprintberlin/openclaw-cliq/compare/v0.1.4...v0.1.5
[0.1.4]: https://github.com/sprintberlin/openclaw-cliq/compare/v0.1.3...v0.1.4
[0.1.3]: https://github.com/sprintberlin/openclaw-cliq/compare/v0.1.2...v0.1.3
[0.1.2]: https://github.com/sprintberlin/openclaw-cliq/compare/v0.1.1...v0.1.2
[0.1.1]: https://github.com/sprintberlin/openclaw-cliq/compare/v0.1.0...v0.1.1
[0.1.0]: https://github.com/sprintberlin/openclaw-cliq/releases/tag/v0.1.0
