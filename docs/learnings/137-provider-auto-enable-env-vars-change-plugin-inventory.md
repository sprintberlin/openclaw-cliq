---
title: Provider auto-enable env vars change plugin inventory on a fresh profile
category: Gateway smoke / real-loader verification
files: scripts/smoke-gateway.sh
apis: OPENROUTER_API_KEY,PERPLEXITY_API_KEY,fingerprintPluginAutoEnableEnv
---
- **OpenClaw auto-enables official external plugins from inherited credential env vars, even on a throwaway profile.** `OPENROUTER_API_KEY` and `PERPLEXITY_API_KEY` are Perplexity web-search provider env vars; if either is set, gateway startup installs `@openclaw/perplexity-plugin` as a missing configured plugin and then refuses to report ready (`plugin migration inputs changed during startup convergence`). Isolating `HOME` / `OPENCLAW_STATE_DIR` / `OPENCLAW_CONFIG_PATH` is not enough — the smoke must also `unset` those keys so a developer shell cannot change plugin inventory.
