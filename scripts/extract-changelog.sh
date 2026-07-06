#!/usr/bin/env bash
# Extract the release-notes body for a single version from CHANGELOG.md.
#
# Usage: scripts/extract-changelog.sh <version>
#   e.g. scripts/extract-changelog.sh 0.1.1
#
# Prints the lines under the `## [<version>] - <date>` heading up to (but not
# including) the next `## ` heading. Exits non-zero if the section is missing —
# the publish workflow uses that to fail loudly when a release forgets its
# CHANGELOG entry. CHANGELOG.md follows the Keep a Changelog format.
set -euo pipefail

VERSION="${1:-}"
if [ -z "$VERSION" ]; then
  echo "usage: $0 <version>" >&2
  exit 2
fi

CHANGELOG="${CHANGELOG_PATH:-CHANGELOG.md}"
if [ ! -f "$CHANGELOG" ]; then
  echo "::error::$CHANGELOG not found" >&2
  exit 1
fi

# awk state machine: start printing after the matching `## [version]` heading,
# stop at the next top-level `## ` heading. The version is matched literally
# (dots escaped) and only inside `[...]` so 0.1.1 never matches 0.1.10.
BODY="$(awk -v ver="$VERSION" '
  BEGIN { esc = ver; gsub(/\./, "\\.", esc); pat = "^## \\[" esc "\\]"; found = 0 }
  $0 ~ pat { found = 1; next }
  found && /^## / { exit }
  found { print }
' "$CHANGELOG")"

# Trim leading/trailing blank lines.
BODY="$(printf '%s\n' "$BODY" | sed -e '/./,$!d' | sed -e ':a' -e '/^\n*$/{$d;N;ba}')"

if [ -z "$BODY" ]; then
  echo "::error::No CHANGELOG.md section found for version $VERSION (expected a '## [$VERSION] - <date>' heading)." >&2
  exit 1
fi

printf '%s\n' "$BODY"
