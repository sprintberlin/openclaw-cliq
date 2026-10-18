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
3. **Every bug and every improvement idea gets a GitHub issue** on `sprintberlin/openclaw-cliq`, filed in the same task. No issue, no done. See "Issue Rule" below.

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

## Issue Rule

Everything that does not work or could be better gets a GitHub issue on `sprintberlin/openclaw-cliq` — bugs and improvement ideas alike, from agents, operators, and humans. File it in the same task, before reporting done. Unsure whether it is a defect? File anyway; duplicates are closed without fuss.

```bash
gh issue create --repo sprintberlin/openclaw-cliq --label bug \
  --title "<one line>" --body "<what happened / what you expected / environment>"
```

Use label `enhancement` for improvement ideas.

Not an issue on our side (fix locally instead): expired OAuth tokens, network/gateway down, Zoho rate limiting (429), missing Deluge handlers in Zoho.

Never put in an issue: `clientSecret`, `refreshToken`, `webhookSecret`, OAuth codes, message text, file content, user/chat IDs, email addresses. When in doubt, redact more.
