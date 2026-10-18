---
title: "ClawHub catalog trust is staff-controlled; icon comes only from assets/icon.png"
files: docs/REVIEW-DOSSIER.md, README.md, .github/workflows/publish-clawhub.yml
apis: assets/icon.png, clawhub package trusted-publisher set, publisher.trust, officialPublishers
---

ClawHub "Official" status is a staff-identity-verification decision on the
publisher (`officialPublishers` row per `specs/official-publishers.md` in
openclaw/clawhub); it cannot be requested via package metadata, and there is no
self-service promotion from a clean security scan — the only public route is a
plain review issue on `openclaw/clawhub` (precedents #3086, #3933; a vetted
community tier is only an RFC, openclaw/clawhub#2272). ClawHub reads catalog
artwork exclusively from `assets/icon.png` inside the published archive (valid
PNG ≤ 512 KiB; manifest `icon` URLs are ignored), so a package listing
`icon: null` is missing that file, not metadata. OIDC trusted publishing for a
package is set by a package manager via `clawhub package trusted-publisher set
<name> --repository <repo> --workflow-filename <workflow>`; per ClawHub docs it
covers `workflow_dispatch` publishes while tag-push publishes still need the
`CLAWHUB_TOKEN` fallback.
