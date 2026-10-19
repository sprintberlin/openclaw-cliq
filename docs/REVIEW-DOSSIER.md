# Review Dossier — `@sprintcx/openclaw-cliq`

Public evidence pack for reviewers evaluating this plugin (issue #263).
Audience: maintainers who need to decide whether the package is review-ready
and trustworthy — not end users.

## Status (2026-10-17)

OpenClaw maintainers reviewed the catalog-admission request
([openclaw/openclaw#175516](https://github.com/openclaw/openclaw/issues/175516))
and closed it as ClawHub-scoped: the durable-ingress APIs this request was
built around (`runtime.state.openChannelIngressQueue`,
`openChannelIngressDrain`) are available to every loaded plugin since
[openclaw/openclaw#165063](https://github.com/openclaw/openclaw/pull/165063),
so official catalog admission is not required for the stated capability.
Distribution and promotion stay on ClawHub. This dossier remains the public,
redacted evidence pack for that ClawHub review and for any future vetted-tier
process ([openclaw/clawhub#2272](https://github.com/openclaw/clawhub/issues/2272)).

What is true today, verifiable without this repository's word:

- ClawHub listing: `channel: "community"`, `isOfficial: false`,
  `scanStatus: "clean"`, verification tier `source-linked` / scope
  `artifact-only`, source-bound to commit `1289e0d` (tag `v0.6.1`).
  `hasProvenance: false` — the OIDC trusted-publisher config can be attached by
  dispatching `.github/workflows/clawhub-trusted-publisher.yml` (see
  "Provenance gap" below), but `hasProvenance` flips only after a later
  supported publish, which no release has done yet.
- npm: `@sprintcx/openclaw-cliq@0.6.1` carries an SLSA provenance attestation
  (`dist.attestations.provenance`) plus registry signatures. Integrity
  `sha512-iyOpRG84KZ89uQhIc+ynLbUNKNjT5folNnY+/duZTOwSAVjBI+PDBD4HVNZ8leGRlYSRQ4zq/sjTgaP0g4jY6A==`.
- No config field, CLI flag, or operator consent can self-assert official
  trust. Local path, git, archive, and `npm-pack:` installs remain outside
  ClawHub review metadata by OpenClaw's own rules.

## Package facts

| Field | Value |
|---|---|
| Package | `@sprintcx/openclaw-cliq` |
| Repository | <https://github.com/sprintberlin/openclaw-cliq> (MIT) |
| Channel | `cliq` (Zoho Cliq) |
| Minimum OpenClaw | `>=2026.8.2` (peer + `pluginApi`) |
| Tests | ~2,550 tests, 112 files (`vitest run`) |
| CI | typecheck · test · build · `resolve supported versions` · floor build · gateway smoke per matrix version · publish verify (tag: pack + verify + publish, dry-run on dispatch) |
| Compatibility matrix | `.github/openclaw-compat.json`: build floor 2026.8.2, smoke-verified 2026.8.2 / 9.3 / 9.8 / 10.2, nightly against newest stable |
| Distribution | ClawHub + npm (same tarball, provenance on npm) |
| Security reporting | SECURITY.md: GitHub private vulnerability reporting |

## What the plugin does

Full two-way Zoho Cliq channel: DMs and channel @mentions via a Deluge webhook
handler, outbound as the bot. OAuth 2.0 client-credentials for DMs, user-context
refresh token for channel posts/edits. Multi-data-center. See README for the
complete feature set; the security-relevant surface is listed below.

## Data flow & threat model

1. **Webhook authentication** — `POST /cliq/webhook` (`auth: "plugin"`) accepts
   exactly one header, `x-cliq-webhook-secret`, compared in constant time; a
   length mismatch still runs a dummy compare (`src/webhook-security.ts`). No
   configured secret fails closed with **503**. Wrong or missing header →
   **401**; more than 60 failures per source IP per 60 s → **429**. Denied
   responses carry `Connection: close`. The limiter trusts the first
   `X-Forwarded-For` hop, so the gateway must sit behind a proxy that
   overwrites that header.
2. **Sender / organization admission** — DM policy defaults to `allowlist`
   (unknown policy values deny). Group traffic passes the mention gate first,
   then `groupPolicy` (fresh setups default `disabled`; pre-existing configs
   without the field keep legacy open behavior and are never rewritten).
   `trustedOrganization.acknowledged` is audit metadata only: Cliq's
   `user.organization_id` is forwarded by Deluge as ordinary JSON and is **not**
   a signed tenant boundary. The real boundary is the verified webhook secret
   plus the installed bot-handler context (`src/admission.ts`,
   `src/security-audit.ts`).
3. **OAuth / SecretRef** — `client_credentials` for DMs, user-context
   `refresh_token` for channel posts, edits, reactions, and attachment reads;
   tokens are cached until 60 s before expiry and are never logged. The three
   secrets accept plaintext or a SecretRef; runtime resolution supports
   plaintext and env-backed refs, and file/exec refs resolve to empty and fail
   closed (`src/secret-resolve.ts`). The security audit flags plaintext secrets
   and a missing webhook secret.
4. **SSRF / egress** — attachment downloads must be `https:` with the exact
   origin of the configured `apiBase` and an `/api/…` or
   `/company/{digits}/v2/attachments/{id}` path; the query string is never
   logged (`src/client.ts`). `apiBase` itself is operator configuration (it may
   point at loopback), and there is no DNS-rebinding or redirect guard beyond
   the origin check. A failed download degrades that one attachment; the turn
   continues.
5. **Media limits** — JSON bodies over **1 MiB** and multipart bodies over
   **25 MiB** are rejected with **413** before parsing
   (`src/inbound-webhook-body.ts`). Per-file size, count, and MIME policy are
   delegated to Core's media store. Outbound text is chunked at Cliq's
   **5000**-character limit.
6. **Replay / dedupe** — events with a stable identity (native message id or a
   Deluge-minted `evt:` id) are appended to Core's durable ingress queue
   **before** the HTTP 200 (`ackPolicy: "after_receive_record"`, the default);
   queue tombstones are the replay guard. Content-derived `syn:` identities
   never enter the queue — a day-long tombstone would swallow a deliberate
   repeat of the same text — and stay on the 60 s in-memory dedupe. Duplicates
   are acknowledged with **200** and no second turn. A dispatch failure on the
   blocking path releases the claim and returns **500** so Cliq retries.
7. **Logging / redaction** — logs carry lengths and masked shapes, never the
   body, the access token, the client secret, or the webhook secret
   (`src/logger.ts`). Known gap: Zoho's OAuth error body is truncated to 500
   characters and logged, so a misconfigured token exchange can echo part of
   Zoho's own error text.
8. **Queue retention / dead letter** — the monitor runs with Core's `standard`
   retention; retryable delivery failures stay with Core's drain. Corrupt or
   identity-mismatched records are classified non-retryable and dead-lettered
   instead of retrying forever (`src/ingress-runtime.ts`). Append failure or a
   monitor that is not ready answers **503**, so Cliq redelivers an unrecorded
   event. Installs whose runtime lacks the queue surface keep the legacy
   await-dispatch behavior and log one diagnostic. Numeric retention, TTL, and
   retry limits are Core's, not this plugin's.
9. **Unparseable input** — an empty or unparseable body is a **400** and never
   reaches the agent (smoke stage 11 asserts no secret or message content in
   the logs for a corrupt body).

## Verification evidence

| Claim | Where it is proven |
|---|---|
| Typecheck, unit/integration tests, build | CI `verify` job; `npx tsc --noEmit`, `npm test`, `npm run build` |
| Install + load + capability registration | `npm run smoke:gateway` stages 1–4 (isolated profile, real gateway) |
| DM, group mention, missing/wrong secret (401), malformed body (400), no secret or content in logs, duplicate = one turn | smoke stages 7–11 |
| Crash between durable ack and turn adoption re-dispatches exactly once; HTTP replay produces none; queue row tombstoned | smoke stage 11b (runtimes exposing `openChannelIngressQueue`) |
| No configured secret fails closed (503, no agent lane) | `scripts/smoke-gateway.sh` pre-secret probe |
| Oversize body rejected (1 MiB JSON / 25 MiB multipart) | `src/inbound-webhook-body` unit tests — not re-run inside the gateway smoke |
| npm provenance | `npm view @sprintcx/openclaw-cliq@0.6.1 dist.attestations.provenance` |
| ClawHub scan | `https://clawhub.ai/api/v1/packages/@sprintcx/openclaw-cliq` → `scanStatus: "clean"` |

Explicitly **not** covered here, so not claimed:

- upgrade, rollback, and uninstall flows (no plugin command or smoke stage);
- a live multi-account inbound proof — inbound is root-account only by design
  (see ROADMAP: one gateway deployment per conversational bot);
- a live production round trip in this document (recorded separately in the
  README and release notes);
- the 429 rate-limit path and large-payload behavior inside the gateway smoke
  (both are unit-tested only).

## Provenance gap

npm publish already uses `npm publish --provenance` (SLSA attestation on
`0.6.1`). ClawHub OIDC trusted publishing is attached by a package manager:
dispatch `.github/workflows/clawhub-trusted-publisher.yml` (action `set`) — it
authenticates with the `CLAWHUB_TOKEN` repository secret and runs
`clawhub package trusted-publisher set @sprintcx/openclaw-cliq --repository
sprintberlin/openclaw-cliq --workflow-filename publish-clawhub.yml`. The action
`inspect` reads the config back and `delete` is the rollback. Per ClawHub's
docs only supported `workflow_dispatch` publishes mint a token via OIDC;
tag-push publishes keep the `CLAWHUB_TOKEN` fallback, so the secret stays.
`verification.hasProvenance` flips to `true` only after such a publish, and the
publish workflow's manual dispatch is forced to a dry-run, so the flip is
confirmed on the next real release. It is release-provenance hardening only —
it is not Core trust and not publisher "Official" status.

## Catalog artwork

ClawHub ignores manifest icon URLs and reads only `assets/icon.png` from the
published archive. The repository now ships that file (the same artwork as
`assets/zoho-cliq-128.png`); it appears on the listing with the next release.
The current `0.6.1` listing therefore still reports `icon: null`.

## Maintenance commitment

- **Owner:** SprintCX (Berlin), public issues on
  `sprintberlin/openclaw-cliq`, private vulnerability reports via GitHub
  Security Advisories (SECURITY.md).
- **Response:** security reports acknowledged within a few business days;
  functional issues triaged through the public tracker. The plugin runs on a
  production gateway, so regressions surface quickly.
- **Compatibility:** the tested matrix is `.github/openclaw-compat.json`
  (build floor `2026.8.2`; smoke-verified `2026.8.2`, `2026.9.3`, `2026.9.8`,
  `2026.10.2`) plus a nightly, non-blocking smoke of the newest stable. A
  release is only advertised as supporting a host version after that version is
  in the matrix.
- **Release cadence:** deliberate tagged releases from merged `main` commits;
  no schedule is promised beyond "when a verified change is ready".
- **Revocation:** a faulty release is superseded by a patched tag. Registry-side
  removal or deprecation is a ClawHub/npm operation and is not promised here.

## What this dossier does not ask for

Official-catalog admission was requested and declined (see Status). Nothing in
this repository requests a local trust override, a bypass of Core's
authority-elevation gates, or a self-asserted official flag. ClawHub publisher
"Official" status is a staff identity-verification decision
(`openclaw/clawhub` `specs/official-publishers.md`) and is not claimed here.
