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

A helper script is bundled with this skill to automatically scrub sensitive patterns (tokens, secrets, email addresses, IDs) and search for existing reports before filing:

```bash
# When installed via ClawHub or running from another working directory:
python3 ~/.openclaw/plugin-skills/cliq/scripts/report_plugin_issue.py \
  --kind "parser-bug" \
  --title "Inbound multipart parser drops Deluge requests with custom boundary format" \
  --expected "Deluge message body parsed and dispatched to agent" \
  --actual "HTTP 400 parser_rejected returned to Deluge" \
  --repro "Send message with specific multipart framing observed in logs"

# Or from inside a local git clone of sprintberlin/openclaw-cliq:
python3 skills/cliq/scripts/report_plugin_issue.py ...
```

Supported `--kind` values:
- `parser-bug`: Inbound webhook body, multipart, or header parsing issues.
- `api-error`: Outbound Zoho REST API client failures or unhandled status codes.
- `cli-bug`: Issues with `openclaw cliq` subcommands (`doctor`, `provision`, etc.).
- `doc-mismatch`: Inaccuracies in setup instructions or Deluge templates.

If the Python helper is unavailable, file directly via GitHub CLI after verifying all secrets are removed:

```bash
gh issue create \
  --repo sprintberlin/openclaw-cliq \
  --label "bug" \
  --title "bug(inbound): <short description>" \
  --body "### What happened\n...\n### Steps to reproduce\n...\n### Version\n..."
```
