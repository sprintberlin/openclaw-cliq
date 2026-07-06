# Contributing to openclaw-cliq

Thanks for your interest in the Zoho Cliq channel plugin for OpenClaw! This
guide covers local development, conventions, and how changes ship.

## Ways to contribute

- **Report a bug** — open a [Bug report](https://github.com/sprintberlin/openclaw-cliq/issues/new?template=bug_report.yml).
- **Request a feature** — open a [Feature request](https://github.com/sprintberlin/openclaw-cliq/issues/new?template=feature_request.yml).
- **Ask a question** — use [Discussions / Q&A](https://github.com/sprintberlin/openclaw-cliq/discussions) rather than the issue tracker.
- **Send a pull request** — see below.

> **Note on the coding agent.** This plugin is developed iteratively by an
> autonomous coding agent (OpenCode via GitHub Actions). That workflow only runs
> for issues opened by repo maintainers (owner / member / collaborator) — a
> public issue will **not** trigger it. Human PRs are always welcome and reviewed
> normally.

## Local development

Requirements: **Node 22+** and npm (the repo ships a `package-lock.json`).

```bash
git clone https://github.com/sprintberlin/openclaw-cliq.git
cd openclaw-cliq
npm install

npm run typecheck   # tsc --noEmit
npm test            # vitest run
npm run build       # tsc -p tsconfig.build.json → dist/
```

Every source file in `src/` has a colocated `*.test.ts`. Add or update tests for
any behavior change — CI runs `typecheck` + `test` + `build` on every push and
PR, and the publish workflow re-runs all three on the tagged commit before it
publishes.

### Where things live

- `index.ts` — plugin entry: webhook route + the inbound reliability pipeline.
- `src/` — one module per concern (`client.ts`, `channel.ts`, `inbound.ts`,
  `message-actions.ts`, `live-edit.ts`, `setup-wizard.ts`, …), each with a test.
- `openclaw.plugin.json` — plugin manifest + config schema.
- `AGENTS.md` — deep project context and reliability invariants.
- `ROADMAP.md` — the single living worklist (open work only, future tense).

## Pull requests

1. Branch from `main`.
2. Keep the change focused; update tests and docs alongside code.
3. Use [Conventional Commits](https://www.conventionalcommits.org/) for commit
   messages and the PR title, e.g.:
   - `feat(channel): add per-sender tool policy override`
   - `fix(inbound): tolerate string message payloads`
   - `docs(readme): clarify refresh-token setup`
   - `test(live-edit): cover streaming preview throttle`
   This keeps history readable and lets us adopt automated release notes later.
4. If the change is user-facing, add an entry under `## [Unreleased]` in
   [CHANGELOG.md](CHANGELOG.md).
5. Ensure `npm run typecheck && npm test && npm run build` all pass.
6. Fill in the PR template checklist and open the PR against `main`.

## Releasing

Releases are cut by maintainers and publish to ClawHub automatically on a tag
push. The full step-by-step (and the required `CLAWHUB_TOKEN` secret) is in
[RELEASING.md](RELEASING.md).

## Reporting security issues

Please **do not** file public issues for vulnerabilities. See
[SECURITY.md](SECURITY.md) for private reporting.

## License

By contributing you agree that your contributions are licensed under the
[MIT License](LICENSE).
