# Releasing

`@sprintcx/openclaw-cliq` publishes to [ClawHub](https://clawhub.ai/sprintcx/plugins/openclaw-cliq)
automatically when a stable version **tag** is pushed. This is the "Option A"
tag-push flow — deliberate, tested releases, one ClawHub version per tag.

## One-time setup

Add a repository secret so CI can authenticate to ClawHub:

- **`CLAWHUB_TOKEN`** — a ClawHub API token for the `@sprintcx` publisher.
  Create it with `clawhub login` (or `clawhub token` to print an existing one),
  then add it under **Settings → Secrets and variables → Actions → New
  repository secret**.

> Once ClawHub exposes trusted-publisher (OIDC) configuration for this package,
> the workflow's OIDC path takes over and the token becomes a no-op — no
> workflow change needed. The `id-token: write` permission is already set.

## Cutting a release

The version bump lands on `main` **before** the tag — the publish workflow
enforces `package.json` == tag and will fail loudly otherwise (it never
auto-bumps, because that would require CI to push to protected `main`).

1. **Make sure `main` is green** (CI passing).
2. **Update the changelog** — in [CHANGELOG.md](CHANGELOG.md), rename the
   `## [Unreleased]` section to `## [X.Y.Z] - YYYY-MM-DD`, and start a fresh
   empty `## [Unreleased]`. Update the compare/link references at the bottom.
3. **Bump the version** in `package.json` to `X.Y.Z`.
4. **Commit** on `main` (or via PR):
   ```bash
   git commit -am "chore(release): v X.Y.Z"
   ```
5. **Tag and push**:
   ```bash
   git tag vX.Y.Z
   git push origin main --tags
   ```
6. The **Publish ClawHub** workflow runs automatically:
   - verifies the tag is on `main`, the version matches, and the CHANGELOG
     section exists;
   - runs `typecheck` · `test` · `build` · `npm pack`;
   - publishes the tarball to ClawHub (`clawhub package publish`), **retrying**
     the transient "pending" response (see
     [Known failure modes](#clawhub-publish-known-failure-modes));
   - creates a GitHub Release with the CHANGELOG section as notes and the
     tarball attached.
7. **Verify**: the [ClawHub listing](https://clawhub.ai/sprintcx/plugins/openclaw-cliq)
   shows the new version, and:
   ```bash
   clawhub package inspect @sprintcx/openclaw-cliq
   ```

> The next release after `0.1.0` is `0.1.1` — `v0.1.0` is already published and
> a version cannot be published twice.

## Dry run (preview without publishing)

Run the **Publish ClawHub** workflow via **Actions → Publish ClawHub → Run
workflow** and enter a version. Manual dispatch is **always** a dry run: it
executes the full verify + `clawhub package publish --dry-run` path but uploads
nothing and creates no release.

## Versioning

We follow [SemVer](https://semver.org/): `PATCH` for fixes, `MINOR` for
backwards-compatible features, `MAJOR` for breaking config/behavior changes.
Only stable `MAJOR.MINOR.PATCH` tags publish — prereleases (`-rc`, `-beta`, …)
are rejected by the workflow.

## ClawHub publish: known failure modes

These are ClawHub/CLI-side quirks (not bugs in this repo). The publish step is
built to tolerate them; this section explains what you'd see and why.

### 1. Transient `packageId / releaseId: invalid value` — **handled by retry**

ClawHub sometimes accepts a publish **asynchronously**. The first call returns

```json
{ "ok": true, "status": "pending", "attemptId": "…" }
```

but the published `clawhub` CLI still expects the older **synchronous** shape
(`{ ok, packageId, releaseId }`) and validates the response against it. On the
`pending` shape that validation fails and the CLI aborts with:

```
Error: API response: packageId: invalid value; releaseId: invalid value
```

**even though the attempt was accepted.** A follow-up publish a few seconds
later returns the synchronous `{ packageId, releaseId }` and the release goes
live. The `pending` attempts that error out do **not** create duplicate
releases (ClawHub dedupes by version), so retrying is safe.

The workflow's publish step therefore:

- retries the publish up to **6 times** (15 s apart), and
- before/after each attempt checks `clawhub package inspect <name>` and treats
  **"this version is already the published latest"** as success — so a re-run of
  a workflow whose publish landed but whose CLI errored will reconcile cleanly
  instead of failing.

This error is **not** caused by the changelog size. We still cap the changelog
sent to ClawHub (~3.5 KB) as a defensive size guard, but that is unrelated to
this failure — do not "fix" a `pending` error by trimming the changelog.

> If ClawHub ships a CLI that understands the async flow (polls `attemptId`),
> the retry loop simply succeeds on attempt 1 and this note becomes moot — no
> workflow change required.

### 2. `spawnSync("npm") … ENOENT` when publishing from a folder — **local/Windows only**

`clawhub package publish <folder>` (or `owner/repo@ref`) shells out to
`npm pack` via `spawnSync("npm", …)` **without `shell: true`**, which fails on
Windows (it looks for a bare `npm`, not `npm.cmd`). This does **not** affect CI
(Linux runners resolve `npm` fine). To publish manually from Windows, build the
tarball yourself and pass the **`.tgz`** as the source (this skips the internal
`npm pack`):

```bash
npm pack                                            # produces sprintcx-openclaw-cliq-X.Y.Z.tgz
clawhub package publish sprintcx-openclaw-cliq-*.tgz \
  --family code-plugin --owner sprintcx --version X.Y.Z \
  --source-repo sprintberlin/openclaw-cliq \
  --source-commit "$(git rev-parse vX.Y.Z^{commit})" --source-ref vX.Y.Z \
  --changelog "…"
# If it errors with the "invalid value" message above, just run it again.
```

Note the **`^{commit}`** in `--source-commit` — see failure mode 4.

### 3. GitHub Release step needs `gh` — **present in CI, maybe not locally**

The workflow uses the `gh` CLI (preinstalled on GitHub runners) to create the
Release. If you ever publish by hand on a machine without `gh`, create the
Release via the REST API instead (`POST /repos/{owner}/{repo}/releases`, then
upload the `.tgz` to the returned `upload_url`).

### 4. Broken README images on ClawHub — **wrong `--source-commit` (annotated-tag object SHA)**

ClawHub turns repo-relative README image paths (`assets/…`) into
`raw.githubusercontent.com/<repo>/<source-commit>/assets/…` URLs using the
release's **`--source-commit`**. Our tags are **annotated**, so
`git rev-parse vX.Y.Z` returns the **tag object** SHA, not a commit — and
raw.githubusercontent only serves **commit** SHAs (and refs), so a tag-object
SHA yields a 404 and every relative README image renders broken. Always resolve
the commit with **`git rev-parse vX.Y.Z^{commit}`** for a manual publish. **CI is
unaffected** — it passes `${{ github.sha }}`, which is the commit.

> Defense in depth: this README also uses **absolute** image URLs (CDN logo,
> tag-pinned `raw.githubusercontent.com/.../vX.Y.Z/assets/…` screenshots) so the
> images survive even if a release records the wrong source-commit. Keep new
> README images absolute for the same reason. Also note ClawHub renders README
> tables with a very narrow, fixed first column — prefer bullet lists over
> two-column label/description tables so labels don't char-wrap.

## Troubleshooting

- **`API response: packageId: invalid value; releaseId: invalid value`** —
  transient ClawHub async-publish response; CI retries automatically. Publishing
  by hand? Just run the publish command again (see
  [failure mode 1](#1-transient-packageid--releaseid-invalid-value--handled-by-retry)).
- **`spawnSync npm ENOENT`** (local publish) — Windows-only CLI quirk; pass a
  pre-built `.tgz` as the source (see
  [failure mode 2](#2-spawnsyncnpm--enoent-when-publishing-from-a-folder--localwindows-only)).
- **Broken README images on the ClawHub page** — a manual publish recorded an
  annotated-tag object SHA as `--source-commit`; use `git rev-parse vX.Y.Z^{commit}`
  (see [failure mode 4](#4-broken-readme-images-on-clawhub--wrong---source-commit-annotated-tag-object-sha)).
  Prefer absolute image URLs to avoid the dependency entirely.
- **`package.json version (...) does not match tag (...)`** — bump
  `package.json` on `main` before tagging (step 3), then re-tag.
- **`No CHANGELOG.md section found for version X.Y.Z`** — add the
  `## [X.Y.Z] - YYYY-MM-DD` heading (step 2).
- **`CLAWHUB_TOKEN secret is not set`** — add the repo secret (one-time setup).
- **Tag commit is NOT reachable from origin/main** — the tag must sit on a
  commit already merged to `main`; don't tag a feature branch.
- **Version already exists on ClawHub** — bump to the next patch; ClawHub
  versions are immutable.
