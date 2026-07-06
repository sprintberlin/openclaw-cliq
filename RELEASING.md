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
   - publishes the tarball to ClawHub (`clawhub package publish`);
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

## Troubleshooting

- **`package.json version (...) does not match tag (...)`** — bump
  `package.json` on `main` before tagging (step 3), then re-tag.
- **`No CHANGELOG.md section found for version X.Y.Z`** — add the
  `## [X.Y.Z] - YYYY-MM-DD` heading (step 2).
- **`CLAWHUB_TOKEN secret is not set`** — add the repo secret (one-time setup).
- **Tag commit is NOT reachable from origin/main** — the tag must sit on a
  commit already merged to `main`; don't tag a feature branch.
- **Version already exists on ClawHub** — bump to the next patch; ClawHub
  versions are immutable.
