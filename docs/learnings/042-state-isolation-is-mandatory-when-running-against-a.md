---
title: State isolation is mandatory when running against a box that has a real `~/.openclaw`
category: Gateway smoke / real-loader verification
source: migrated from AGENTS.md
---
- **State isolation is mandatory when running against a box that has a real `~/.openclaw`.** On first run of a NEW profile, openclaw migrates legacy state (e.g. `exec-approvals.json`) out of the default profile into the new one, mutating `~/.openclaw`. The smoke sets a throwaway `HOME` + `OPENCLAW_STATE_DIR` + `OPENCLAW_CONFIG_PATH` so it can never touch a real profile. In ephemeral CI there is no `~/.openclaw`, so this is belt-and-suspenders there, but essential on a dev/prod host.
