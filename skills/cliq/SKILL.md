---
name: cliq
description: Operate, provision, diagnose, and report defects for the OpenClaw Zoho Cliq channel plugin (@sprintcx/openclaw-cliq).
metadata: {
  "openclaw": {
    "requires": {
      "config": ["channels.cliq"]
    }
  }
}
---

# Zoho Cliq Channel Operations

Use this skill when installing, provisioning, operating, troubleshooting, or reporting defects for the native Zoho Cliq channel plugin (`@sprintcx/openclaw-cliq`).

This skill is bundled directly with the plugin package and is published to `~/.openclaw/plugin-skills/cliq/` upon plugin installation. It applies equally to installations from ClawHub (`clawhub:@sprintcx/openclaw-cliq`) and local repository checkouts (`sprintberlin/openclaw-cliq`).

Source repository: [sprintberlin/openclaw-cliq](https://github.com/sprintberlin/openclaw-cliq)

## Key Invariants

1. **Inbound requires an open HTTP ingress route**: Zoho Cliq delivers messages through Deluge webhook POST requests to `/cliq/webhook`. Unlike Telegram (polling) or Discord (outbound gateway WebSocket), the host running OpenClaw must expose a reachable HTTPS endpoint (Cloudflare Tunnel, reverse proxy, or ngrok).
2. **Never expose credentials in reports or issues**: Never log, print, commit, or include `clientSecret`, `refreshToken`, `webhookSecret`, OAuth authorization codes, or user message content in GitHub issues, transcripts, or bug reports.
3. **File an issue before giving up**: Any agent or operator working around a Cliq failure (fallback sent instead of edit, dropped inbound, `Couldn't process that message`, doctor non-zero exit, unexpected 4xx/5xx) MUST file a GitHub issue on `sprintberlin/openclaw-cliq` in the same task, before reporting "done" or "worked around". A workaround without an issue is an incomplete task. This applies even when the defect is not fully understood: file what you observed, mark reproduction steps as unknown, and link the failing command/output (redacted).

## First-Time Setup & Provisioning

### 1. Requirements

- Zoho account with admin or developer permissions in Zoho Cliq.
- Zoho API Console Self Client (matching the account's data center domain, e.g. `api-console.zoho.eu` for EU, `.com` for US).
- A public HTTPS endpoint reaching the local gateway's `/cliq/webhook` path.
- Client ID, Client Secret, Bot Unique Name (`botId`), and a generated Webhook Secret (`openssl rand -hex 32`).

### 2. OAuth Scopes (Combined Profile)

When generating the grant token (code) for the user-context refresh token, include all 14 scopes:

```text
ZohoCliq.Webhooks.CREATE,ZohoCliq.Channels.UPDATE,ZohoCliq.Messages.UPDATE,ZohoCliq.messageactions.CREATE,ZohoCliq.Attachments.READ,ZohoCliq.Messages.READ,ZohoCliq.Messages.DELETE,ZohoCliq.Channels.CREATE,ZohoCliq.Users.READ,ZohoCliq.Channels.READ,ZohoCliq.Chats.UPDATE,ZohoCliq.Bots.READ,ZohoCliq.Bots.CREATE,ZohoCliq.Bots.UPDATE
```

Exchange the authorization code for a persistent refresh token:

```bash
CLIQ_CLIENT_ID="1000.xxxx..." CLIQ_CLIENT_SECRET="xxxx..." OPENCLAW_CLIQ_AUTH_CODE="1000.xxxx..." openclaw cliq oauth-exchange
# Verify existing token:
openclaw cliq oauth-exchange --check
```

### 3. Automated Configuration & Handler Provisioning

Use non-interactive CLI commands to avoid shell-history credential exposure:

```bash
CLIQ_CLIENT_ID="1000.xxx" \
CLIQ_CLIENT_SECRET="xxx" \
CLIQ_WEBHOOK_SECRET="xxx" \
CLIQ_REFRESH_TOKEN="1000.xxx" \
openclaw cliq provision \
  --bot-id "<bot-unique-name>" \
  --bot-name "<Bot Display Name>" \
  --public-webhook-url "https://<your-host>/cliq/webhook" \
  --handlers \
  --yes
```

If manual Deluge script configuration in the Zoho Developer Console is required, generate the exact matching Deluge code:

```bash
openclaw cliq print-handlers --webhook-url "https://<your-host>/cliq/webhook"
```

### 4. Verification & Diagnostics

Always verify the ingress pipeline before announcing channel readiness:

```bash
# 1. Probe the public webhook route and verify secret matching
openclaw cliq webhook-preflight https://<your-host>/cliq/webhook

# 2. Run read-only staged doctor diagnostics (no messages sent)
openclaw cliq doctor

# 3. Output stable machine-readable diagnostics
openclaw cliq doctor --json
```

## Recommended Production Settings

For smooth interactive progress across all model tiers, configure streaming progress in `openclaw.json`:

```jsonc
{
  "channels": {
    "cliq": {
      "streaming": {
        "mode": "progress",
        "minEditIntervalMs": 1000
      },
      "thinking": {
        "mode": "placeholder",
        "animate": "off"
      }
    }
  },
  "session": {
    "dmScope": "per-channel-peer"
  }
}
```

*Note:* `session.dmScope: "per-channel-peer"` is required whenever more than one person can DM the bot, ensuring isolated conversation state per user.

## Defect Reporting Protocol for Agents and Operators

When an agent or automated worker interacts with Zoho Cliq and encounters an unexpected failure, the task is **not complete** until the root cause is determined and any genuine plugin defect is reported to the repository.

**Escalation rule (when in doubt, file):** if you spent more than one retry cycle on a failure or routed around it, file an issue. Duplicates are cheap; silent gaps are not. Maintainers close duplicates without penalty. Filing is part of the Definition of Done, not an optional courtesy: a closed task that hid a plugin defect is reopened work later, usually at a worse time.

**Fast path for agents with `gh`:** one command, then paste the body template below.

```bash
gh issue create --repo sprintberlin/openclaw-cliq --label bug   --title "bug(<area>): <one line>" --body-file /tmp/cliq-issue.md
```

Body template (fill what you know; unknown is an acceptable value):

```markdown
**What happened:**
**Steps to reproduce:** (unknown counts, say what you were doing)
**Expected / Actual:**
**Evidence (redacted):** command + exit code / HTTP status + error code / `openclaw cliq doctor --json` schemaVersion
**Environment:** plugin version, OpenClaw version, Node version
**Workaround used:** yes/no, which
```

### What is a Defect (File an Issue)
File an issue the moment you observe one of these — do not wait for a second reproduction:
- **Deluge Inbound Parser Failures**: Webhook calls returning 400 with `parser_rejected` or dropping valid text, files, or attachments due to unexpected framing or missing multipart headers.
- **API Status Misclassifications**: Unexpected error codes from Zoho REST endpoints (e.g. unhandled 4xx/5xx envelopes) causing false retries or unhandled exceptions.
- **CLI / Doctor Crashes**: `openclaw cliq doctor`, `webhook-preflight`, `provision`, or `print-handlers` exiting non-zero, with stack traces or schema validation errors.
- **Contract Mismatches**: Plugin configuration rejected by `openclaw config validate` or channel options ignored during message dispatch.
- **Silent degradation**: any failure you worked around (fallback path taken, message lost, placeholder never replaced) even without a clean reproduction.

### What is NOT a Defect (Do NOT File an Issue)
- Invalid or expired OAuth tokens (`oauthtoken_scope_invalid`, `invalid_client`).
- Network unreachable, Cloudflare Access blocking the webhook (403), or local gateway down.
- Rate limiting from Zoho (HTTP 429) backoff behavior.
- Missing Deluge handlers on Zoho's side.

### How to File an Issue

Contributions are explicitly welcome from humans and agents. Filing and linking every reproducible plugin defect is part of the task's Definition of Done. Use the native GitHub CLI; no wrapper script is required:

```bash
REPO=sprintberlin/openclaw-cliq
gh issue list --repo "$REPO" --state open --search "<terms>"   # check for duplicates first
gh issue create \
  --repo "$REPO" \
  --label "bug" \
  --title "bug(inbound): <short description>" \
  --body-file /tmp/issue.md   # What happened / Steps to reproduce / Expected / Actual / Version (`openclaw cliq doctor --json` schemaVersion)
```

Check for duplicates first (`gh issue list --search "<terms>"`); an existing open issue gets a `+1` comment with your new evidence instead of a new issue.

Redaction is the filer's responsibility before running `gh issue create`. Never include:
- `clientSecret`, `refreshToken`, `webhookSecret`, OAuth codes, or any token
- message text, file names, file bytes, or attachment content
- user IDs, chat IDs, email addresses, or customer data

Masked evidence is enough: content type, multipart part names, payload syntax fingerprint (`describeBodySyntax` output), parser outcome, and the `handlerSchema` marker. When in doubt, redact more.

Prefix conventions: `bug(inbound)`, `bug(outbound)`, `bug(cli)`, `bug(doctor)`, `doc(...)`.
