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

The plugin uses the **`client_credentials`** OAuth grant (no refresh token, no user interaction — the plugin fetches a fresh access token automatically when the cached one expires).

1. Open the **[Zoho API Console](https://api-console.zoho.eu)** (EU). Choose **Self Client** if you do not already have one for Cliq.
2. Create a **Server-based Application** (or Self Client) and note:
   - **Client ID**
   - **Client Secret**
3. Generate the access token once manually (or via the "Self Client" → **Generate Access Token** flow) using these **scopes**:

   | Scope | Purpose |
   | --- | --- |
   | `ZohoCliq.Webhooks.CREATE` | Post bot messages (the plugin's primary send scope) |
   | `ZohoCliq.Channels.READ` | Read channel / chat metadata |
   | `ZohoCliq.Users.READ` | Resolve sender user info |

   The plugin requests `ZohoCliq.Webhooks.CREATE` at runtime via `client_credentials`; list all three when registering the client so the granted token carries the full set.

4. Use the **EU** OAuth token endpoint:

   ```
   https://accounts.zoho.eu/oauth/v2/token
   ```

   (The plugin hard-codes `https://accounts.zoho.eu`. Do **not** use `accounts.zoho.com` unless your Zoho account is on the US data center.)

5. Copy **Client ID** and **Client Secret** — they go into `clientId` / `clientSecret` in the plugin config below.

---

### 4. OpenClaw Configuration

Add the `cliq` channel to your `openclaw.json` (or via `openclaw setup` / the setup wizard's `applyAccountConfig` step). The required fields are `clientId`, `clientSecret`, and `botId`; `botName`, `webhookSecret`, and `allowFrom` are recommended.

```jsonc
{
  "channels": {
    "cliq": {
      "accounts": {
        "default": {
          "clientId": "<OAuth client id from step 3>",
          "clientSecret": "<OAuth client secret from step 3>",
          "botId": "openclaw_agent",      // Bot Unique Name from step 1
          "botName": "OpenClaw Agent",    // Bot display name from step 1
          "webhookSecret": "<secret from step 2>",
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
| `allowFrom` | optional | Array of Zoho Cliq user ids allowed to DM the bot (only effective when `dmPolicy` is `allowlist` or `pairing`). |
| `dmPolicy` | optional | DM admission policy. Default is `allowlist` (deny by default). `pairing` starts the OpenClaw pairing approval flow for unknown senders. Accepted values: `open`, `allowlist`, `pairing`, `disabled` (schema-validated — unknown field names like `dmSecurity` are rejected). |

**Gateway reachability:** the host running the OpenClaw gateway must be reachable from the public internet at `https://<gateway-host>/cliq/webhook`. If you run the gateway behind a reverse proxy / Cloudflare Tunnel, make sure TLS termination and the `Host` header are preserved.

---

### 5. Deluge Webhook Handler

The Cliq bot must forward every mention / message event to the OpenClaw webhook. Paste this Deluge script into the bot's **Mention Handler** and **Message Handler** functions in the Cliq Bot editor.

```deluge
// === Configuration (set these once) ===
webhookUrl   = "https://<gateway-host>/cliq/webhook";
webhookSecret = "<the same secret you put in openclaw.json as webhookSecret>";

/*
 * Builds the JSON payload the plugin expects and POSTs it.
 * The plugin tolerates string|object `message` and a couple of
 * channel/chat key variants, but the shape below is canonical.
 */
payload = Map();
payload.put("handler", "mention");  // use "message" in the Message Handler

// message
message = Map();
message.put("text", message);
message.put("id", message_id);
message.put("time", message_time);
payload.put("message", message);

// sender
user = Map();
user.put("id", user.get("id"));
user.put("name", user.get("name"));
user.put("email_id", user.get("email_id"));
payload.put("user", user);

// chat / channel context
chat = Map();
chat.put("id", chat.get("chat_id"));
chat.put("type", chat.get("chat_type"));         // "channel" for groups
chat.put("title", chat.get("chat_title"));
payload.put("chat", chat);

channel = Map();
channel.put("id", channel.get("channel_id"));
channel.put("name", channel.get("channel_name"));
channel.put("unique_name", channel.get("channel_unique_name"));
payload.put("channel", channel);

// mentions (mention handler only)
if (mentions.size() > 0) {
    mentionList = List();
    for each  m in mentions {
        item = Map();
        item.put("id", m.get("id"));
        item.put("name", m.get("name"));
        item.put("type", m.get("type"));
        mentionList.add(item);
    }
    payload.put("mentions", mentionList);
}

// POST to OpenClaw as raw JSON.
// IMPORTANT: use `body: payload.toString()` (NOT `parameters:`). The
// `parameters` form posts an `application/x-www-form-urlencoded` body
// (e.g. `handler=mention&...`) which the plugin rejects with HTTP 400
// because it is not valid JSON. `body:` + the `application/json`
// header above sends the raw JSON object the parser expects.
response = invokeUrl
[
    url: webhookUrl
    type: POST
    body: payload.toString()
    headers: headers
];

info "openclaw webhook forwarded: " + response.get("status");
```

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
- The OAuth client has the three scopes from step 3 and the EU endpoint is in use.

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
