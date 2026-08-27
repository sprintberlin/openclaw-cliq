---
title: Cliq organization identity is not a signed tenant boundary
files: src/identity.ts,src/inbound.ts,src/welcome.ts,src/trusted-org.ts
apis: user.organization_id,/api/v2/users,x-cliq-webhook-secret
---

Zoho Cliq's Deluge `user` object may contain `organization_id` for Message, Mention, Welcome, and handler-defined Form payloads, but the handler forwards it as ordinary operator-authored JSON; it is neither signed by Zoho nor independently bound to the request. The v2 organization-directory endpoint lists users visible to the installation but exposes no independent sender-to-tenant attestation. Runtime admission therefore trusts the constant-time verified private `x-cliq-webhook-secret` plus the installed bot-handler context; `organization_id` is useful diagnostic evidence only and must never be advertised as an enforced per-request tenant boundary.
