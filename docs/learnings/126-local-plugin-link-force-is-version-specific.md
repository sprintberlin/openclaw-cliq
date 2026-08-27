---
title: Local plugin --link installs need --force only on OpenClaw versions that treat non-ClawHub sources as untrusted
files: README.md,CONTRIBUTING.md
apis: openclaw plugins install --link,--force,ClawHub
---

`openclaw plugins install --link <path>` is a local-path install, so on OpenClaw `>= 2026.8.1-beta.3` a non-interactive run is cancelled unless `--force` acknowledges that the source is outside ClawHub review and trust metadata. On OpenClaw `2026.7.1-2` the same `--force` still means "overwrite an existing install" and is rejected together with `--link`. Document both commands; do not hide the confirmation behind a wrapper. `--link` keeps the install pointed at the working tree, so every later `git pull` needs a rebuild and a gateway restart, and the "manifest id differs from npm package name" line is expected because the config key is the manifest id.
