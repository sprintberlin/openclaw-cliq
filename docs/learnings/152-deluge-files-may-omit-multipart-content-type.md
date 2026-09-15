---
title: Deluge files transport may omit the multipart Content-Type
files: [src/inbound-webhook-body.ts, src/bot-provisioning.ts]
apis: [invokeUrl, files, Content-Type, multipart/form-data, boundary]
issues: [#259]
---

Deluge `invokeUrl files:` can send a multipart body while omitting or mislabelling the HTTP `Content-Type`; live proof showed the boundary and `Content-Disposition` lines reaching `/cliq/webhook` under a non-multipart header. The webhook must therefore recognize only the generated handler's bounded first `payload` or `metadata` part before granting the larger multipart size limit; arbitrary dashed bodies must retain the ordinary JSON limit.
