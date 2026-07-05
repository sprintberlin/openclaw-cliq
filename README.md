# openclaw-cliq

Zoho Cliq channel plugin for [OpenClaw](https://github.com/openclaw/openclaw).

> **Status:** Early development. Not yet functional.

## What this is

A native OpenClaw channel plugin that connects OpenClaw agents to [Zoho Cliq](https://www.zoho.com/cliq/). Once installed, OpenClaw agents can receive messages (mentions + DMs) and respond as bots in Cliq channels and direct messages.

## Development

This plugin is developed iteratively by an autonomous coding agent (OpenCode via GitHub Actions). See `AGENTS.md` for project context and conventions, and `ROADMAP.md` for the open worklist / feature-parity target.

---

## Setup Guide — Zoho Cliq Bot with OpenClaw

This guide walks through everything that must be configured **on the Zoho side** so that the `cliq` channel plugin can talk to your OpenClaw gateway.

> **EU endpoint is used throughout.** Replace `zoho.eu` with `zoho.com` only if your Zoho account lives on the US data center. The plugin hard-codes the EU endpoints (`https://accounts.zoho.eu` for OAuth, `https://cliq.zoho.eu` for the API) — if you need the `.com` data center, file an issue.

### Prerequisites

- A Zoho account with access to **Zoho Cliq** and the **Zoho API Console**.
- A running OpenClaw gateway reachable from the public internet (so Zoho can call the webhook). A reverse proxy, Cloudflare Tunnel, or `ngrok` all work for development.
- The bot owner must be able to create a bot in Cliq (admin / developer permission).

---

### 1. Create a Zoho Cliq Bot

1. Open **Zoho Cliq** → left sidebar → **Bots** 
2. Click **Create Bot**.
3. Fill in:
   - **Bot Name** (display name, e.g. `OpenClaw Agent`) — this is what users see.
   - **Bot Unique Name** (e.g. `openclaw_agent`) — this is the `botId` you will put in the plugin config. Lowercase, underscores, no spaces.
   - **Bot Type**: choose **Custom Bot** (a Deluge-backed bot whose handlers forward to the webhook). A pure "Webhook Bot" is not required — we use a Custom Bot with a Deluge handler that `invokeUrl`s our endpoint.
4. Set the bot's **Functional Handlers**:
   - **Mention Handler** — fired when the bot is @mentioned in a channel.
   - **Message Handler** — fired when a user DMs the bot directly.
5. **Publish / Activate** the bot (it must be active to receive events).
6. **Invite the bot into the channel(s)** where it should respond to mentions. In a Cliq channel: ⋯ → **Bots** → add your bot. The bot can always receive DMs without an explicit invite.

> The **Bot Unique Name** you pick here is the `botId` config field. The display name is `botName` (used for @mention stripping in the agent-visible text).

---

### 2. Configure the Webhook

The plugin registers a single HTTP route at **`POST /cliq/webhook`** on your OpenClaw gateway. Zoho Cliq's Deluge bot handler must POST every mention / message event to that URL.

1. Pick a strong random secret (e.g. `openssl rand -hex 32`) — this becomes your **`webhookSecret`**.
2. Note the public URL of your OpenClaw gateway, e.g. `https://openclaw.example.com`. The full webhook URL is:

   ```
   https://<gateway-host>/cliq/webhook
   ```

   The route is registered with `auth: "plugin"`, so no additional gateway-level bearer token is required; the `webhookSecret` is verified by the plugin itself via the `x-cliq-webhook-secret` header.

3. Make sure the gateway host is reachable from the public internet (Zoho's servers POST to it). For local development use a Cloudflare Tunnel / `ngrok` / reverse proxy.

4. In the Cliq Bot's Deluge editor (see step 5 below), set the webhook URL and the secret header on every `invokeUrl` call.

---

### 3. OAuth / API Credentials

The plugin uses **two** OAuth grant types, because the **`client_credentials`** grant CANNOT obtain a usable token for the `ZohoCliq.Channels.UPDATE` or `ZohoCliq.Messages.UPDATE` scopes — Zoho issues a token whose response *reports* the scope, but the API rejects it on use with `{"code":"oauthtoken_scope_invalid"}`. So:

- **Bot DMs** (`/bots/{botId}/message`, scope `ZohoCliq.Webhooks.CREATE`) → `client_credentials` (the plugin fetches a fresh access token automatically when the cached one expires; no refresh token, no user interaction).
- **Channel posts** (`/channelsbyname/{unique_name}/message`, scope `ZohoCliq.Channels.UPDATE`) and **message edits** (`/chats/{chatId}/messages/{messageId}`, scope `ZohoCliq.Messages.UPDATE`) → a **user-context refresh token** obtained once via the self-client `authorization_code` flow. The plugin mints short-lived access tokens from it via `grant_type=refresh_token` and caches them until they expire (~1h). Without a refresh token, channel replies and live-edit streaming previews will fail with `oauthtoken_scope_invalid` — DM-only setups keep working.

#### 3a. Create the OAuth client

1. Open the **[Zoho API Console](https://api-console.zoho.eu)** (EU). Choose **Self Client** if you do not already have one for Cliq.
2. Create a **Server-based Application** (or Self Client) and note:
   - **Client ID**
   - **Client Secret**
3. Use the **EU** OAuth token endpoint:

   ```
   https://accounts.zoho.eu/oauth/v2/token
   ```

   (The plugin hard-codes `https://accounts.zoho.eu`. Do **not** use `accounts.zoho.com` unless your Zoho account is on the US data center.)

4. Copy **Client ID** and **Client Secret** — they go into `clientId` / `clientSecret` in the plugin config below.

#### 3b. Consent the scopes

When registering / re-consenting the self-client, request **all five** scopes so both the `client_credentials` (DM) and refresh-token (channel/edit) paths work:

| Scope | Grant | Purpose |
| --- | --- | --- |
| `ZohoCliq.Webhooks.CREATE` | `client_credentials` | Post bot DMs (the `/bots/{botId}/message` send path) |
| `ZohoCliq.Channels.UPDATE` | refresh token | Post bot messages to channels (the `/channelsbyname/{unique_name}/message` send path) |
| `ZohoCliq.Channels.READ` | `client_credentials` | Read channel / chat metadata |
| `ZohoCliq.Users.READ` | `client_credentials` | Resolve sender user info |
| `ZohoCliq.Messages.UPDATE` | refresh token | Edit a sent message in place (live-edit streaming previews) |

> If you previously consented with only the original three scopes, you must re-consent (generate a fresh self-client token) with `ZohoCliq.Channels.UPDATE` and `ZohoCliq.Messages.UPDATE` added — channel replies will be rejected with `invalid_scope` / 401 until you do.

#### 3c. Obtain the user-context refresh token (required for channel posts + edits)

This is a **one-time** exchange. The refresh token does not expire (unless revoked), so you only do this once per Cliq org.

1. In the **[Zoho API Console](https://api-console.zoho.eu)**, open your **Self Client**.
2. Under **Generate Access Token**, choose **Grant Type: Authorization Code** (a.k.a. "Self Client" code flow).
3. Enter the same **scopes** as above (space-separated: `ZohoCliq.Webhooks.CREATE ZohoCliq.Channels.UPDATE ZohoCliq.Channels.READ ZohoCliq.Users.READ ZohoCliq.Messages.UPDATE`).
4. Click **Generate**. The self-client flow returns both a short-lived `access_token` (ignore it) and a long-lived **`refresh_token`** — copy the `refresh_token`.
5. Put the `refresh_token` in the plugin config as `refreshToken` (see §4).

> The self-client authorization-code flow is the documented way to get a refresh token for a single-org server integration without standing up a redirect URL. See Zoho's OAuth docs for the exact button names if the console UI differs.

If you skip this step, the plugin still works for **bot DMs** (the `client_credentials` path). Channel @mention replies and message edits will fail with `oauthtoken_scope_invalid` until a refresh token is provided.

---

### 4. OpenClaw Configuration

Add the `cliq` channel to your `openclaw.json` (or via `openclaw setup` / the setup wizard's `applyAccountConfig` step). The required fields are `clientId`, `clientSecret`, and `botId`; `botName`, `webhookSecret`, and `allowFrom` are recommended.

```jsonc
{
  "channels": {
    "cliq": {
      "accounts": {
        "default": {
          "clientId": "<OAuth client id from step 3a>",
          "clientSecret": "<OAuth client secret from step 3a>",
          "botId": "openclaw_agent",      // Bot Unique Name from step 1
          "botName": "OpenClaw Agent",    // Bot display name from step 1
          "webhookSecret": "<secret from step 2>",
          "refreshToken": "<refresh token from step 3c — required for channel posts / edits>",
          "allowFrom": ["<zoho user id of each allowed DM sender>"],
          "dmPolicy": "allowlist"         // "open" | "allowlist" | "pairing" | "disabled"
        }
      }
    }
  }
}
```

| Field | Required | Description |
| --- | --- | --- |
| `clientId` | yes | OAuth client id from the Zoho API Console. |
| `clientSecret` | yes | OAuth client secret (sensitive). |
| `botId` | yes | Bot **Unique Name** (the path segment in the bot message API). |
| `botName` | recommended | Bot display name. Used to strip the `@botName` mention from the text the agent sees. |
| `webhookSecret` | recommended | Shared secret the Deluge handler sends in the `x-cliq-webhook-secret` header. If unset, the webhook accepts all requests (not recommended). |
| `refreshToken` | recommended | User-context OAuth refresh token (sensitive). Obtained once via the self-client `authorization_code` flow (§3c). **Required for channel @mention replies and live-edit message edits** — without it, those paths fail with `oauthtoken_scope_invalid` (the `client_credentials` grant cannot obtain a usable token for `ZohoCliq.Channels.UPDATE` / `ZohoCliq.Messages.UPDATE`). DM-only setups can leave it unset. |
| `allowFrom` | optional | Array of Zoho Cliq user ids allowed to DM the bot (only effective when `dmPolicy` is `allowlist` or `pairing`). |
| `dmPolicy` | optional | DM admission policy. Default is `allowlist` (deny by default). `pairing` starts the OpenClaw pairing approval flow for unknown senders. Accepted values: `open`, `allowlist`, `pairing`, `disabled` (schema-validated — unknown field names like `dmSecurity` are rejected). |

**Gateway reachability:** the host running the OpenClaw gateway must be reachable from the public internet at `https://<gateway-host>/cliq/webhook`. If you run the gateway behind a reverse proxy / Cloudflare Tunnel, make sure TLS termination and the `Host` header are preserved.

---

### 5. Deluge Webhook Handler

The Cliq bot must forward every mention / message event to the OpenClaw webhook. Paste this Deluge script into the bot's **Mention Handler** and **Message Handler** functions in the Cliq Bot editor.

```deluge
// === Configuration (set these once) ===
// Public URL of your gateway's /cliq/webhook route. If you expose the gateway
// port directly (no reverse proxy / TLS) this is http://<host>:18789/cliq/webhook.
webhookUrl    = "https://<gateway-host>/cliq/webhook";
webhookSecret = "<the same secret you set as webhookSecret in openclaw.json>";

// Cliq provides `message`, `user`, and `chat` in the Message/Mention handler
// scope. The plugin's parser accepts these Cliq objects as-is (it tolerates the
// different chat/channel key variants), so just forward them directly.
payload = Map();
payload.put("handler", "message");   // <-- use "mention" in the Mention Handler
payload.put("message", message);
payload.put("user", user);
payload.put("chat", chat);

// Auth + content type. The secret header is REQUIRED when webhookSecret is set
// in openclaw.json; Content-Type MUST be application/json.
headers = Map();
headers.put("Content-Type", "application/json");
headers.put("x-cliq-webhook-secret", webhookSecret);

// POST to OpenClaw as raw JSON. Use `body:` (NOT `parameters:`) — see note below.
invoke_response = invokeUrl
[
    url    : webhookUrl
    type   : POST
    body   : payload.toString()
    headers: headers
];

// The reply is delivered by the OpenClaw gateway via the Cliq bot API, so the
// handler itself returns an empty response.
response = Map();
return response;
```

> This is the same script for both handlers — the **only** difference is the
> `handler` value: `"message"` in the **Message Handler** (DMs) and `"mention"`
> in the **Mention Handler** (channel/group @mentions). Group vs DM is detected
> automatically from the forwarded `chat` object, so no extra mapping is needed.

> **Do not use `parameters: payload.toString()`.** In Deluge, `invokeUrl`'s
> `parameters:` key serializes the value as form-urlencoded data
> (`handler=mention&message=...`), which is **not** the JSON body this
> plugin expects — the gateway returns `400 Unexpected token 'h',
> "handler=me"... is not valid JSON`. Always use `body:` together with
> the `Content-Type: application/json` header shown above.

#### Payload format reference

The plugin parses the JSON payload posted by the Deluge handler. The canonical shape is:

```jsonc
{
  "handler": "mention",            // "mention" | "message"
  "message": { "text": "hi", "id": "msg_123", "time": "2026-07-04T10:00:00Z" },
  "user":    { "id": "12345", "name": "Jane Doe", "email_id": "jane@example.com" },
  "chat":    { "id": "cl_abc", "type": "channel", "title": "Engineering" },
  "channel": { "id": "ch_1", "name": "engineering", "unique_name": "engineering" },
  "mentions": [ { "id": "openclaw_agent", "name": "OpenClaw Agent", "type": "bot" } ]
}
```

Notes (the parser is tolerant):

- `message` may be a plain string instead of `{ text, id, time }`.
- A wrapped `params` object (`{ params: { message, user, channel } }`) is also accepted.
- Group vs DM detection: `chat.type === "channel"` (or the presence of `channel.*` fields) marks a group; otherwise the message is treated as a DM.
- The `x-cliq-webhook-secret` header is checked against the configured `webhookSecret`. The plugin also accepts `x-webhook-secret` or `Authorization: Bearer <secret>` for convenience.

---

### Verification

After the steps above, send a test message:

1. **DM the bot** in Cliq (if `dmPolicy` is `allowlist`, make sure your Zoho user id is in `allowFrom`).
2. **@mention the bot** in a channel it was invited to.

Both should trigger a `POST /cliq/webhook` on your gateway (visible in the gateway logs) and an agent reply in the same chat. If nothing arrives, check:

- The bot is **active/published** in Cliq.
- The Deluge handler is saved and the webhook URL / secret are correct.
- The gateway host is reachable from the public internet (curl `https://<gateway-host>/cliq/webhook` from an external host — a `405 Method Not Allowed` on GET means the route is live).
- The OAuth client has all the scopes from step 3b (including `ZohoCliq.Channels.UPDATE` for channel replies) and the EU endpoint is in use. For channel @mention replies and message edits, `refreshToken` from step 3c must be set — otherwise those paths fail with `oauthtoken_scope_invalid`.

#### Smoke testing with curl

You can verify the webhook route and the expected JSON body shape independently of Zoho Cliq. Replace `<gateway-host>` and `<secret>` with your values:

```bash
curl -i -X POST 'https://<gateway-host>/cliq/webhook' \
  -H 'Content-Type: application/json' \
  -H 'x-cliq-webhook-secret: <secret>' \
  --data '{
    "handler": "message",
    "message": { "text": "hello from curl", "id": "smoke_1" },
    "user":    { "id": "smoke-user", "name": "Smoke Tester" },
    "chat":    { "id": "smoke-chat", "type": "channel", "title": "Smoke" }
  }'
```

Expected response (the webhook acknowledges receipt synchronously and dispatches asynchronously):

```
HTTP/2 200
content-type: application/json

{"status":"received"}
```

- `200 {"status":"received"}` — the route is live, the secret matched, and the body parsed as JSON. The agent reply (if any) is delivered asynchronously to the chat id you supplied.
- `401 unauthorized` — the `x-cliq-webhook-secret` header did not match `webhookSecret`.
- `400 ... is not valid JSON` — the body was not JSON (e.g. you used `parameters:` in Deluge, or `Content-Type` was `application/x-www-form-urlencoded`). Re-check the Deluge handler in §5.
- `503 cliq not configured` — the channel account is not configured in `openclaw.json` (see §4).

---

## License

MIT
