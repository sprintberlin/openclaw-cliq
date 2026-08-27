---
title: Staged channel diagnostics belong on a plugin CLI
files: src/doctor.ts, src/doctor-runner.ts, src/doctor-command.ts, index.ts
apis: ChannelDoctorAdapter, registerCli, openclaw cliq doctor
---

`ChannelDoctorAdapter` has a fixed SDK-owned key set for static repair and warning hooks, so it cannot expose a nine-stage report, custom exit codes, consent flags, or nonce correlation. Keep the existing adapter as the static config subsystem and put staged orchestration on a plugin CLI that calls the adapter helpers plus the reusable OAuth, preflight, inspection, and directory subsystems.

A skipped optional send stage is healthy, but a skipped verification stage such as bot/handler inspection is degraded because the doctor cannot claim that boundary is healthy. Never infer bot visibility, subscription state, or the Zoho-held webhook secret when the inspection API is unavailable.
