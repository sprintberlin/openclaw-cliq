---
title: The static doctor preview can only warn — FAIL enforcement lives in the staged runner
---

- **Static doctor preview can only warn.** The SDK's doctor framework forwards
  a fixed key set from the channel doctor adapter (`028`); `collectPreviewWarnings`
  returns `string[]`, and there is no fail/error surface on it. A finding that
  must fail the run therefore needs two homes: a warning-shaped message in
  `collectCliqOptimalConfigFindings` (shared with the static preview so
  `openclaw doctor` names the same fix) and a severity-carrying enforcement in
  the staged `cliq doctor` config stage (`collectCliqConfigFindings` in
  `src/doctor-runner.ts`), which filters the static duplicates out of its
  warning list and records blocking findings as stage failures.
- **The staged config stage cannot see the running gateway.** `openclaw cliq
  doctor` runs in the CLI process, so the live `runtime.state` durable surface
  is unobservable; the installed package version (resolved through the
  `openclaw/plugin-sdk/setup` subpath, exactly like setup's compat check — a
  direct `require.resolve("openclaw/package.json")` fails because the package's
  `exports` map does not expose `./package.json`) is the available signal for
  whether `openChannelIngressQueue` exists. Never compare versions with `>`
  on raw strings across major formats — a lexicographic compare is safe only
  for the zero-padded `YYYY.M.D` calendar versions OpenClaw publishes.
