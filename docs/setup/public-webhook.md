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

# Or run the full staged doctor, which reuses this preflight as one stage
openclaw cliq doctor --json
```

By default the command uses `channels.cliq.webhookSecret` from the resolved
plugin config, which is the recommended way to run it. `--secret <value>` is
available for an endpoint whose secret is not in this config, but note that it
puts the secret in your shell history — prefer the config default or a shell
that ignores history-prefixed commands.

When the checked URL **is** the configured `channels.cliq.publicWebhookUrl`,
the result is recorded in the config: a passing run writes
`channels.cliq.inboundVerifiedAt`, a failing run writes
`channels.cliq.inboundVerificationFailedAt` and clears any stale verification —
so verifying from the CLI counts exactly like verifying inside the wizard, and
a formerly working install cannot keep claiming a stale verification after its
endpoint broke. The write only ever happens for the configured URL (running
the command against a third-party endpoint never touches your config) and can
be suppressed for a pure read-only probe:

```bash
openclaw cliq webhook-preflight https://<public-host>/cliq/webhook --no-write
```

Nothing is recorded when the run cannot speak for this install: `--secret`
overrides the configured secret (so the run proves nothing about the secret
Zoho actually uses), and an inconclusive run — an upstream `429` before the
plugin's own check, no resolvable secret, or an exhausted transient startup
condition — leaves both timestamps alone rather than destroying genuine prior
evidence. The method/reachability boundary retries `502`, `503`, `504`,
connection-refused/reset, and timeout outcomes three times with 250 ms then
500 ms backoff. Human and JSON output include the bounded attempt count and
elapsed retry delay, never a response body or secret; if readiness stays
inconclusive, the command exits non-zero without recording a failure.

Setup status reports three distinct states rather than a blanket "NOT
verified": `verified <timestamp>`, `last check FAILED <timestamp>`, and `never
checked`.

Every request — the reachability `GET`, both secret-enforcement `POST`s, and
the authenticated probe — sends this explicit, honest User-Agent:

```text
openclaw-cliq-preflight/<package-version> (+https://github.com/sprintberlin/openclaw-cliq)
```

The `<package-version>` is this plugin's `package.json` version, currently
`0.1.10`. Edge providers routinely block unfamiliar or missing User-Agents
before a request reaches the gateway. Allowlist that identity (or the pattern
`openclaw-cliq-preflight/*`) for the webhook hostname, or override it to
reproduce the identity your Zoho/Deluge delivery uses:

```bash
openclaw cliq webhook-preflight https://<public-host>/cliq/webhook \
  --user-agent 'ZohoCliq'
```

A `403` at any stage is therefore classified as a **probable edge/WAF/bot-rule
block**, with advice to allow the preflight identity or the Zoho source. It is
not reported as a missing route or as proof that a working reverse proxy needs
to be reconfigured.

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

Expect `405` on `GET`. An unauthenticated `POST` returns `401` when a
`webhookSecret` is configured, and `503` when one is not (the plugin fails
closed rather than accepting unauthenticated delivery). A `200`, a redirect,
or an HTML page means something else is answering.

To separate "the public path is broken" from "the route was never registered",
run the route check directly against the gateway on the host itself:

```bash
openclaw cliq webhook-route            # defaults to http://127.0.0.1:18789/cliq/webhook
openclaw cliq webhook-route --port 8080
openclaw cliq webhook-route --json     # machine-readable
```

Exit codes: `0` when the route is proven registered, `1` when the result is
anything else, and `2` for a bad `--port` (an unusable port is an error, never
a silent fallback to `18789`, which could report an unrelated gateway as
healthy).

Prefer the loopback default. Registration is proven by a route-signature
response header, and a reverse proxy that strips unknown headers will make an
otherwise healthy `--url https://…` run report `unknown`; querying the gateway
address directly avoids that.

If this reports the route as registered but the preflight fails, the problem is
in front of the gateway (DNS, TLS, proxy, tunnel rules). Registration is only
claimed on a `405` that also carries the plugin's own route signature header,
so an unrelated service that happens to reject `GET` cannot pass the check.
Every other outcome — an unreachable port, a bare `404` (which a proxy can
generate without ever reaching the gateway), or any unexpected status — is
reported as inconclusive with a non-zero exit code, never as a confirmed
verdict. When it is inconclusive, query the gateway address directly: if the
route is genuinely absent there, the plugin is not loaded or `channels.cliq`
is not configured — a channel plugin registers its route only once its channel
is configured.

> **`plugins inspect` cannot answer this question.** `openclaw plugins inspect
> cliq --runtime --json` prints `"httpRoutes": 0` even on a healthy install
> whose route is answering `405`/`401` at that very moment. That command loads
> plugins *without activating* them, and the route is registered in the
> activation step, so the count describes a throwaway registry rather than the
> running gateway. Reported upstream as
> [openclaw/openclaw#130773](https://github.com/openclaw/openclaw/issues/130773).

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
    listen 443 ssl;
    http2 on;
    server_name cliq.example.com;

    ssl_certificate     /etc/letsencrypt/live/cliq.example.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/cliq.example.com/privkey.pem;

    # Publish only the plugin route.
    location = /cliq/webhook {
        proxy_pass http://127.0.0.1:18789;
        proxy_http_version 1.1;

        # Preserve the original host and the client IP. Note the use of
        # $remote_addr (not $proxy_add_x_forwarded_for): see the warning below.
        proxy_set_header Host              $host;
        proxy_set_header X-Real-IP         $remote_addr;
        proxy_set_header X-Forwarded-For   $remote_addr;
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

> **`X-Forwarded-For` is a trust boundary.** The plugin rate-limits *failed*
> webhook authentications per client IP and reads that IP from the **first**
> entry of `X-Forwarded-For`. If your proxy *appends* to a client-supplied
> header (nginx's `$proxy_add_x_forwarded_for`, or a default Traefik/ALB
> setup), a caller can send their own `X-Forwarded-For` and control the value
> the limiter buckets on, evading the brute-force protection. Configure the
> edge proxy to **replace** the header with the real peer address, as the
> `$remote_addr` line above does. This does not weaken the shared-secret
> check itself — that is constant-time and independent of the client IP.

> **Timeouts.** With the default `ackPolicy: "after_dispatch"` the gateway
> answers only after the agent turn completes, which is what drives Cliq's
> native "bot is processing" indicator. If your proxy's read timeout is
> shorter than a slow turn, raise it (as above) rather than lowering the
> plugin's guarantees. If you cannot, `ackPolicy: "immediate"` trades the
> documented lost-message-on-crash risk for a fast ack — but do not use it on
> OpenClaw `2026.8.1-beta.3`, where post-ack turns can fail with
> `GatewayDrainingError`. `openclaw cliq doctor` warns whenever `immediate` is
> configured.

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
| OpenClaw web UI instead of the route | The request reached the gateway, but the plugin route is not registered — install/enable the plugin and configure `channels.cliq` |
| `404` | Proxy does not forward `/cliq/webhook`, or the channel is not configured (the plugin registers the route only when `channels.cliq` exists) |
| `502` / `503` / `504` on the reachability `GET`, or connection refused/reset/timeout | Gateway, proxy, or tunnel may still be starting. The preflight retries three bounded attempts, then reports inconclusive and preserves existing verification timestamps. A later `405` continues through authentication normally |
| `503` after the route returned `405` | `webhookSecret` is not set — the plugin fails closed |
| `401` | Header missing or the secret does not match |
| `403` | Probable edge/WAF/bot-rule block before the request reached the plugin. Allow `openclaw-cliq-preflight/<package-version> (+https://github.com/sprintberlin/openclaw-cliq)` (or `openclaw-cliq-preflight/*`) or the Zoho source; do **not** reconfigure a working reverse proxy based on this result alone |
| `429` | An upstream rate limiter answered before the plugin — the preflight reports the secret stage as inconclusive rather than passing it |
| `405` on `POST` | Something upstream rewrote the method |
| Timeout in the Deluge log | Proxy read timeout shorter than the agent turn |

Run `openclaw cliq webhook-preflight <url>` first: it names the failing
boundary instead of leaving you to guess.
