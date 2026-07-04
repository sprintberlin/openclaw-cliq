#!/usr/bin/env bash
#
# Stage-3 gateway smoke: verify the BUILT plugin actually loads in a REAL
# OpenClaw gateway runtime -- not against a hand-rolled mock. This is the source
# of truth for "does it load / does the channel register", replacing the guess
# work of reading the SDK .d.ts files.
#
# What it does (headless, no daemon, no Zoho, no secrets):
#   1. Builds the plugin (dist/).
#   2. Links it into a THROWAWAY, fully isolated openclaw profile.
#   3. Loads the plugin runtime via `plugins inspect --runtime` and asserts the
#      plugin status is "loaded" and it registers a `channel` capability.
#   4. Runs `plugins doctor` and fails if it flags the cliq plugin.
#
# Verified against openclaw@2026.6.11. Run via: npm run smoke:gateway
#
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

# --- Resolve the openclaw CLI (installed as a devDependency via npm ci) --------
if [ -x "$ROOT/node_modules/.bin/openclaw" ]; then
  OC=("$ROOT/node_modules/.bin/openclaw")
elif [ -f "$ROOT/node_modules/openclaw/openclaw.mjs" ]; then
  OC=(node "$ROOT/node_modules/openclaw/openclaw.mjs")
elif command -v openclaw >/dev/null 2>&1; then
  OC=(openclaw)
else
  echo "smoke-gateway: openclaw CLI not found. Add 'openclaw' to devDependencies (npm ci) or put it on PATH." >&2
  exit 1
fi

# --- Hermetic state ------------------------------------------------------------
# A throwaway HOME + state dir so we never touch (or trigger a legacy-state
# migration out of) a real ~/.openclaw profile. openclaw migrates legacy state
# into a new profile on first run, so isolation must be total.
SMOKE_HOME="$(mktemp -d)"
export HOME="$SMOKE_HOME"
export OPENCLAW_STATE_DIR="$SMOKE_HOME/state"
export OPENCLAW_CONFIG_PATH="$SMOKE_HOME/state/openclaw.json"
PROFILE="ci-smoke"
cleanup() { rm -rf "$SMOKE_HOME"; }
trap cleanup EXIT

run_oc() { "${OC[@]}" --profile "$PROFILE" --log-level warn "$@" < /dev/null; }

echo "==> [1/4] Building plugin (dist/)"
npm run build --silent

echo "==> [2/4] Linking plugin into isolated profile '$PROFILE'"
run_oc plugins install . --link

echo "==> [3/4] Loading plugin runtime and asserting it registered"
INSPECT_FILE="$SMOKE_HOME/inspect.json"
run_oc plugins inspect cliq --json --runtime > "$INSPECT_FILE"
head -c 500 "$INSPECT_FILE"; echo
node -e '
  const d = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"));
  const plugin = d.plugin || {};
  const caps = Array.isArray(d.capabilities) ? d.capabilities : [];
  const channelCap = caps.some(c => c && c.kind === "channel"
    && Array.isArray(c.ids) && c.ids.includes("cliq"));
  const diagnostics = Array.isArray(d.diagnostics) ? d.diagnostics : [];
  if (plugin.status !== "loaded") {
    console.error(`FAIL: plugin status is "${plugin.status}", expected "loaded"`);
    process.exit(1);
  }
  if (!channelCap) {
    console.error("FAIL: plugin loaded but did not register the cliq channel capability");
    console.error("capabilities: " + JSON.stringify(caps));
    process.exit(1);
  }
  if (diagnostics.length) {
    console.error("FAIL: plugin reported load diagnostics: " + JSON.stringify(diagnostics));
    process.exit(1);
  }
  console.log(`OK: plugin loaded, registered cliq channel capability, no diagnostics (status=${plugin.status})`);
' "$INSPECT_FILE"

echo "==> [4/4] plugins doctor"
DOCTOR_OUT="$(run_oc plugins doctor)"
echo "$DOCTOR_OUT"
if echo "$DOCTOR_OUT" | grep -qi "cliq"; then
  echo "FAIL: plugins doctor flagged the cliq plugin (see output above)" >&2
  exit 1
fi

echo ""
echo "SMOKE PASSED: the built plugin loads in a real OpenClaw gateway and registers the cliq channel."
