# Changelog

All notable changes to `@sprintcx/openclaw-cliq` are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

Each released version has a `## [X.Y.Z] - YYYY-MM-DD` heading; the ClawHub
publish workflow extracts the matching section as the release notes (see
[RELEASING.md](RELEASING.md)).

## [Unreleased]

### Added

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
  Tapping a button posts `<fieldName>: <value>` back to the bot as an
  ordinary inbound message the agent reads as the user's answer (e.g.
  `priority: high`) — no inbound-side changes required, so this works on
  both v2 and v3 without a separate Form Handler. An optional `message`
  param prefixes the first card's text as extra context. A degenerate form
  (no viable fields) returns an error so the agent can correct and retry.
  The `form` param takes precedence over `buttons` / `theme` / `slides` when
  present. No new OAuth scope — prompt cards reuse the same card-path scopes
  (`Webhooks.CREATE` for DM cards via `client_credentials`; `Channels.UPDATE`
  on v2 / `Channels.CREATE` on v3 for channel cards) the existing
  `message(action=send, buttons=…)` path uses. No new config field. The
  first increment of the Phase 3 "Outbound Cliq Forms" item (sub-part a —
  the renderer); pairing-approval and parameter-capture flows follow. See
  README §5c.

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

[Unreleased]: https://github.com/sprintberlin/openclaw-cliq/compare/v0.1.2...HEAD
[0.1.2]: https://github.com/sprintberlin/openclaw-cliq/compare/v0.1.1...v0.1.2
[0.1.1]: https://github.com/sprintberlin/openclaw-cliq/compare/v0.1.0...v0.1.1
[0.1.0]: https://github.com/sprintberlin/openclaw-cliq/releases/tag/v0.1.0
