---
title: A healthy tunnel does not prove the webhook endpoint is reachable
files: src/webhook-preflight.ts, src/webhook-probe.ts
apis: /cliq/webhook, x-cliq-webhook-secret, openclaw-probe
---

`cloudflared` (and any comparable tunnel) reports `healthy` as soon as it
connects outbound to the provider's edge — that says nothing about whether an
inbound request survives the edge and reaches the origin. Zone-level rules
evaluated *before* the tunnel (catch-all redirects, Access policies, bot-fight
challenges) can intercept the request, so the operator sees a healthy tunnel
and a `301`/HTML page at the same time.

The only honest check is an external request against the public URL: `GET
https://<host>/cliq/webhook` must return `405`, and an unauthenticated `POST`
must return `401`. `src/webhook-preflight.ts` treats a `3xx` and an HTML body
as distinct, named failures for exactly this reason — the fix (exempt the
hostname from a rule) is entirely different from a DNS or TLS fix.

The authenticated probe uses a dedicated `handler: "openclaw-probe"` envelope
rather than a deliberately malformed production payload: a malformed payload
asserts a *failure* mode (`400`), which is indistinguishable from a genuine
parser regression, whereas the probe branch in `index.ts` runs before dedupe
and dispatch and returns `dispatched: false` as a positive contract.
