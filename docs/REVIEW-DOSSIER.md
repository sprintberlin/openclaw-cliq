# Review Dossier — `@sprintcx/openclaw-cliq`

Standalone evidence pack for OpenClaw maintainers evaluating this plugin for
the official channel catalog (issue #263). Audience: maintainers who need to
decide whether the package is review-ready and trustworthy — not end users.

## Package facts

| Field | Value |
|---|---|
| Package | `@sprintcx/openclaw-cliq` |
| Repository | <https://github.com/sprintberlin/openclaw-cliq> (MIT) |
| Channel | `cliq` (Zoho Cliq) |
| Minimum OpenClaw | `>=2026.8.2` (peer + `pluginApi`) |
| Tests | ~2,500 tests, 111 files (`vitest run`) |
| CI | typecheck · test · build · `resolve supported versions` · floor build · gateway smoke per matrix version · publish verify (tag: pack + verify + publish, dry-run on dispatch) |
| Compatibility matrix | `.github/openclaw-compat.json`: build floor 2026.8.2, smoke-verified 2026.8.2 / 9.3 / 9.8 / 10.2, nightly against newest stable |
| Distribution | ClawHub + npm (same tarball, provenance on npm) |
| Security reporting | SECURITY.md: GitHub private vulnerability reporting |

## What the plugin does

Full two-way Zoho Cliq channel: DMs and channel @mentions via a Deluge webhook
handler, outbound as the bot. OAuth 2.0 client-credentials for DMs, user-context
refresh token for channel posts/edits. Multi-data-center. See README for the
complete feature set; the security-relevant surface is listed below.

## Security posture (attack surface under review)

1. **Webhook ingress** — single route `POST /cliq/webhook`, `auth: "plugin"`,
   single shared secret header (`x-cliq-webhook-secret`), **constant-time
   compare**, failed-auth **rate limiting** scoped per source, denied requests
   get connection close. Covered by tests.
2. **Inbound integrity** — durable-before-ack ingest, de-dup on redelivery
   (per-execution `eventId` with 30-minute replay protection; legacy handlers
   fall back to a content-derived id with 60 s expiry), bot-loop /
   self-message protection.
3. **Admission** — DM policies `allowlist` / `pairing` / `open` / `disabled`;
   group admission per channel (`allowlist`, `requireMention` default,
   `disabled`). Trusted-organization mode is a deliberate, acknowledged
   broadening, not a signed tenant check (documented as such).
4. **Secrets** — OAuth client secret, refresh token, webhook secret stored via
   SecretRef; never logged; scrubber in the issue helper strips tokens,
   credentials, and emails before filing.
5. **Provenance** — releases are tag-pushed on merged main commits only,
   package version must equal tag, CI builds and publishes the verified
   tarball; npm publish carries provenance attestation.

## Maintenance commitment

Maintained by SprintCX (Berlin). Issues handled in the public repo; security
via private reporting with coordinated disclosure. The plugin is deployed live
on a production gateway at SprintCX, so regressions surface fast and releases
follow. The current supported matrix is extended as new OpenClaw stable
versions ship.

## Verification evidence for the reviewing maintainer

- Latest release workflow run: verify job includes typecheck, full test suite,
  build, artifact presence check, `npm pack`, tarball upload; publish job
  publishes the exact tarball to ClawHub and (with this PR) to npm.
- Gateway smoke tests boot a real OpenClaw gateway per matrix version and run
  the plugin's smoke suite against it (scripts/smoke-gateway.sh).
- Live verification on a production gateway is documented in the README and
  release notes (DM + mention round trips, doctor runs green).

## Requested from maintainers

1. Review of the package for the official channel catalog entry
   (`scripts/lib/official-external-channel-seed.json`): pinned npm version +
   integrity hash, as used for existing official external channels.
2. Whether protected durable-ingress APIs (`runtime.state.openChannelIngressQueue`,
   `openChannelIngressDrain`) can be made available to catalog-pinned external
   plugins, or what the intended path for non-bundled webhook channels is.
3. Confirmation of the intended maintenance expectations for
   trusted-official plugins (release cadence, compat-matrix obligations).
