---
title: EU endpoints are the default but no longer hard-coded
category: Zoho Cliq specifics
files: [src/region.ts]
source: migrated from AGENTS.md
---
- **EU endpoints are the default but no longer hard-coded:** `accounts.zoho.eu` (OAuth), `cliq.zoho.eu` (API) are the fallbacks in `CliqClient`'s constructor defaults; the region catalog (`src/region.ts`) holds every other DC, and the setup wizard writes both fields together so a non-EU install is configured up front.
