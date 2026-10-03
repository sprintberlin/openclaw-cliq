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
3. **Report reproducible plugin defects**: If an agent or operator observes a reproducible defect in the plugin (parser rejections, Deluge framing errors, CLI failures, schema mismatches), filing or linking a GitHub issue on `sprintberlin/openclaw-cliq` is an explicit part of the Definition of Done.

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
OPENCLAW_CLIQ_AUTH_CODE="1000.xxxx..." openclaw cliq oauth-exchange
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

### What is a Defect (File an Issue)
- **Deluge Inbound Parser Failures**: Webhook calls returning 400 with `parser_rejected` or dropping valid text, files, or attachments due to unexpected framing or missing multipart headers.
- **API Status Misclassifications**: Unexpected error codes from Zoho REST endpoints (e.g. unhandled 4xx/5xx envelopes) causing false retries or unhandled exceptions.
- **CLI / Doctor Crashes**: `openclaw cliq doctor`, `webhook-preflight`, `provision`, or `print-handlers` exiting with stack traces or schema validation errors.
- **Contract Mismatches**: Plugin configuration rejected by `openclaw config validate` or channel options ignored during message dispatch.

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

Redaction is the filer's responsibility before running `gh issue create`. Never include:
- `clientSecret`, `refreshToken`, `webhookSecret`, OAuth codes, or any token
- message text, file names, file bytes, or attachment content
- user IDs, chat IDs, email addresses, or customer data

Masked evidence is enough: content type, multipart part names, payload syntax fingerprint (`describeBodySyntax` output), parser outcome, and the `handlerSchema` marker. When in doubt, redact more.

Prefix conventions: `bug(inbound)`, `bug(outbound)`, `bug(cli)`, `bug(doctor)`, `doc(...)`.
