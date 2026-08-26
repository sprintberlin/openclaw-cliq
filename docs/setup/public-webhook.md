# Expose the webhook publicly

Zoho Cliq delivers inbound messages by **calling you**. A Deluge handler inside
the Cliq bot runs on Zoho's servers and performs an HTTP `POST` to your
gateway:

```
POST https://<public-host>/cliq/webhook
x-cliq-webhook-secret: <your webhookSecret>
```

This is the one part of the setup that is not configuration — it is
deployment. Telegram can long-poll, Discord holds an outbound WebSocket, and
Slack offers Socket Mode. Cliq has no such mode: **the plugin cannot receive a
message unless Zoho can open a connection to it.** If your gateway runs on a
laptop or a desktop behind a router, it is not reachable by default, and this
page is about closing that gap.

## What the endpoint must satisfy

Whichever option you pick, all of the following must hold:

| Requirement | Why |
|---|---|
| Public DNS record | Zoho resolves the hostname from its own network |
| Valid TLS certificate | HTTPS only — Zoho refuses plaintext `http://` |
| `POST` reaches the gateway | The route is `/cliq/webhook` on the OpenClaw gateway |
| `x-cliq-webhook-secret` is forwarded | The plugin verifies this header itself |
| No interactive challenge | Deluge cannot solve a login page, captcha, or JS challenge |
| Request body forwarded unmodified | The plugin parses the raw Deluge JSON |

Two consequences are worth calling out.

**The tunnel or proxy is not your authentication.** Anything on the public
internet can reach the URL. The plugin's shared secret is what separates Zoho
from everyone else, so always set a strong `webhookSecret`
(`openssl rand -hex 32`). Without it the plugin fails closed and answers `503`.

**Do not put an auth layer in front of the route.** Cloudflare Access, HTTP
basic auth, an IP allowlist that omits Zoho's ranges, or a bot-fight challenge
will all block delivery. The Deluge handler is not a browser.

## Verify before you wire up Zoho

The plugin ships a preflight that checks the whole public path and reports
which boundary failed:

```bash
openclaw cliq webhook-preflight https://<public-host>/cliq/webhook

# Stable machine-readable report for automation / doctor integration
openclaw cliq webhook-preflight https://<public-host>/cliq/webhook --json
```

By default the command uses `channels.cliq.webhookSecret` from the resolved
plugin config. For an unconfigured or external endpoint, provide it explicitly
with `--secret <value>` (avoid shell history in shared environments).

It distinguishes DNS, TLS, reverse-proxy, route, secret, and application
failures, and finishes with an authenticated probe that reaches the plugin
**without** dispatching an agent turn or producing a Cliq message.

A quick manual check of the same path:

```bash
# From an external host — 405 means the route is live and rejects GET
curl -i https://<public-host>/cliq/webhook

# Missing/incorrect secret must be rejected
curl -i -X POST https://<public-host>/cliq/webhook
```

Expect `405` on `GET` and `401` on an unauthenticated `POST`. A `200`, a
redirect, or an HTML page means something else is answering.

---

## Option 1 — VPS or server with a public IP

The most robust option when you already run a server. The gateway stays bound
to loopback and a reverse proxy terminates TLS.

```
Zoho ──HTTPS 443──▶ Caddy / nginx ──▶ 127.0.0.1:18789/cliq/webhook
```

Keep the gateway on `127.0.0.1` and publish only port 443. Forwarding only the
`/cliq/webhook` path (rather than the whole gateway) keeps the gateway's other
routes off the public internet.

### Caddy

```caddyfile
cliq.example.com {
	# Only the webhook route is public; everything else is not served.
	handle /cliq/webhook {
		reverse_proxy 127.0.0.1:18789
	}

	handle {
		respond 404
	}
}
```

Caddy obtains and renews the certificate automatically and forwards request
headers (including `x-cliq-webhook-secret`) unchanged.

### nginx

```nginx
server {
    listen 443 ssl http2;
    server_name cliq.example.com;

    ssl_certificate     /etc/letsencrypt/live/cliq.example.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/cliq.example.com/privkey.pem;

    # Publish only the plugin route.
    location = /cliq/webhook {
        proxy_pass http://127.0.0.1:18789;
        proxy_http_version 1.1;

        # Preserve the original host and the client IP.
        proxy_set_header Host              $host;
        proxy_set_header X-Real-IP         $remote_addr;
        proxy_set_header X-Forwarded-For   $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;

        # The agent turn happens while Deluge waits for the response.
        proxy_read_timeout 120s;
    }

    location / {
        return 404;
    }
}
```

Do not add `proxy_set_header Authorization ...`, basic auth, or a
`satisfy any` block on this location — the plugin performs its own
constant-time secret check and expects the request to arrive unmodified.

> **Timeouts.** With the default `ackPolicy: "after_dispatch"` the gateway
> answers only after the agent turn completes, which is what drives Cliq's
> native "bot is processing" indicator. If your proxy's read timeout is
> shorter than a slow turn, raise it (as above) rather than lowering the
> plugin's guarantees. If you cannot, switch to `ackPolicy: "immediate"` and
> accept the documented lost-message risk on a crash between ack and dispatch.

---

## Option 2 — Cloudflare Tunnel

The right choice for a machine **behind NAT** — a desktop agent, a home
server, or anything behind a router you do not control. `cloudflared` opens an
outbound connection to Cloudflare, so no port forwarding and no public IP are
required.

```
Zoho ──▶ Cloudflare ──▶ cloudflared (outbound) ──▶ 127.0.0.1:18789
```

You need a domain on Cloudflare. Create the tunnel, map a hostname to the
local gateway, and run `cloudflared` as a service:

```bash
# 1. Authenticate and create a named tunnel
cloudflared tunnel login
cloudflared tunnel create openclaw-cliq

# 2. Route a public hostname to the tunnel (creates the DNS record)
cloudflared tunnel route dns openclaw-cliq cliq.example.com
```

Local ingress configuration (`~/.cloudflared/config.yml`):

```yaml
tunnel: openclaw-cliq
credentials-file: /home/<user>/.cloudflared/<tunnel-id>.json

ingress:
  - hostname: cliq.example.com
    service: http://127.0.0.1:18789
  # A catch-all rule is mandatory and must be last.
  - service: http_status:404
```

Install it as a system service so it survives a reboot:

```bash
sudo cloudflared service install
sudo systemctl enable --now cloudflared
sudo systemctl status cloudflared
```

Tunnels can also be managed remotely (ingress stored in Cloudflare rather than
a local `config.yml`), in which case the host only holds the tunnel token.

> **A healthy tunnel does not prove the endpoint works.** `cloudflared` reports
> `healthy` as soon as it connects to Cloudflare's edge — that says nothing
> about whether a request reaches your origin. Zone-level rules (redirects,
> Access policies, bot-fight mode) are evaluated *before* the tunnel and can
> intercept the request. Always confirm with an external `curl` that
> `GET https://<host>/cliq/webhook` returns `405`. If you get a redirect or an
> HTML page instead, a rule in front of the route is intercepting Zoho's
> delivery and the hostname needs an exemption.

---

## Option 3 — An existing reverse proxy

If you already run Traefik, HAProxy, or a cloud load balancer, just add a
route for `/cliq/webhook` to the gateway. The same rules apply: preserve the
`Host` header, forward request headers unchanged, allow a long read timeout,
and place no authentication in front of the route.

Traefik labels for a gateway running in Docker:

```yaml
labels:
  - "traefik.enable=true"
  - "traefik.http.routers.cliq.rule=Host(`cliq.example.com`) && Path(`/cliq/webhook`)"
  - "traefik.http.routers.cliq.entrypoints=websecure"
  - "traefik.http.routers.cliq.tls.certresolver=myresolver"
  - "traefik.http.services.cliq.loadbalancer.server.port=18789"
```

---

## Option 4 — Temporary tunnels for development

For a quick test on a laptop, an ephemeral tunnel is the fastest path:

```bash
# ngrok
ngrok http 18789

# Cloudflare quick tunnel (no account needed)
cloudflared tunnel --url http://127.0.0.1:18789
```

Both print a public HTTPS URL you can paste into the Deluge handler.

**Development only.** The URL changes on every restart, so you must edit the
Deluge handler each time; free ngrok tunnels expire and may show an interstitial
warning page that breaks Deluge delivery. Use a named tunnel or a reverse proxy
for anything permanent.

---

## Option 5 — Self-hosted tunnel

If you would rather not depend on a third-party edge, a self-hosted tunnel
gives the same NAT traversal with your own public endpoint on one side:

- [`rathole`](https://github.com/rapiz1/rathole) — minimal, fast, single binary
- [`frp`](https://github.com/fatedier/frp) — mature and widely deployed
- [`Pangolin`](https://github.com/fosrl/pangolin) — tunnelled reverse proxy with a UI
- [`zrok`](https://zrok.io/) — built on OpenZiti, self-hostable

All of them require a server with a public IP to act as the rendezvous point,
plus TLS termination there — effectively Option 1 with an extra hop for the
NATed machine. Choose this when you already operate such a server and want to
keep the traffic path entirely under your control.

---

## Troubleshooting

| Symptom | Likely cause |
|---|---|
| DNS does not resolve | Record missing, or not yet propagated |
| TLS error | Certificate hostname mismatch, expired, or incomplete chain |
| `301` / `302` to another site | A redirect rule in front of the route intercepts the request |
| HTML page instead of the route | Login page, captcha, or bot-challenge in front of the route |
| `404` | Proxy does not forward `/cliq/webhook`, or the channel is not configured (the plugin registers the route only when `channels.cliq` exists) |
| `503` | `webhookSecret` is not set — the plugin fails closed |
| `401` | Header missing or the secret does not match |
| `405` on `POST` | Something upstream rewrote the method |
| Timeout in the Deluge log | Proxy read timeout shorter than the agent turn |

Run `openclaw cliq webhook-preflight <url>` first: it names the failing
boundary instead of leaving you to guess.
