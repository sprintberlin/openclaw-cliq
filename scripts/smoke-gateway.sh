#!/usr/bin/env bash
#
# Gateway smoke for the openclaw-cliq channel plugin. Two stages:
#
#   Stage 3 (load + capability registration):
#     1. Builds the plugin (dist/).
#     2. Links it into a THROWAWAY, fully isolated openclaw profile.
#     3. Loads the plugin runtime via `plugins inspect --runtime` and asserts
#        the plugin status is "loaded" and it registers a `channel` capability.
#     4. Runs `plugins doctor` and fails if it flags the cliq plugin.
#
#   Stage 4 (real inbound webhook dispatch through the agent pipeline):
#     5. Writes a channels.cliq config (fake credentials + webhook secret +
#        open DM policy) so the gateway loads the plugin in FULL registration
#        mode and registers the `/cliq/webhook` HTTP route.
#     6. Starts a foreground gateway on a free loopback port (--auth none).
#     7. POSTs canonical Deluge payloads and asserts:
#          - valid DM           -> 200 {"status":"received"}
#          - valid group+mention-> 200 {"status":"received"}
#          - wrong secret       -> 401
#          - malformed body     -> 400
#     8. Asserts the gateway log shows the inbound was routed to an agent
#        session (`lane=session:agent:main:cliq:`) -- i.e. the real pipeline
#        dispatched the turn, not just the HTTP route accepting the bytes.
#        The agent turn + outbound Cliq OAuth fail (no model / no real Zoho
#        credentials) -- those failures are expected and are themselves the
#        evidence the dispatch path ran end-to-end.
#
#   Stage 4b (full agent round-trip with a stub model + mocked outbound):
#     9.  Starts a local mock HTTP server standing in for accounts.zoho.eu
#         (OAuth), cliq.zoho.eu (bot-message send), and an OpenAI-compatible
#         stub chat model. The mock records bot-message sends to a log file.
#     10. Reconfigures channels.cliq with apiBase/oauthBase pointing at the
#         mock, and registers a stub model provider + agents.defaults.model
#         so the agent turn produces a deterministic echo reply. Restarts the
#         gateway with the new config.
#     11. POSTs a Deluge DM payload, waits for the agent reply to be
#         delivered, and asserts the mock's bot-send log recorded a send
#         whose text contains the stub model's reply marker -- i.e. the reply
#         actually landed end-to-end (inbound -> agent -> outbound -> Cliq
#         send), not just that the inbound was dispatched.
#     12. Tears down the mock + gateway.
#
# Headless: no daemon, no Zoho, no real secrets, no real model. Run via:
#   npm run smoke:gateway
#
# Verified against openclaw@2026.6.11.
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
GATEWAY_PID=""
MOCK_PID=""
cleanup() {
  if [ -n "$MOCK_PID" ]; then kill "$MOCK_PID" 2>/dev/null || true; wait "$MOCK_PID" 2>/dev/null || true; fi
  if [ -n "$GATEWAY_PID" ]; then kill "$GATEWAY_PID" 2>/dev/null || true; wait "$GATEWAY_PID" 2>/dev/null || true; fi
  rm -rf "$SMOKE_HOME"
}
trap cleanup EXIT

run_oc() { "${OC[@]}" --profile "$PROFILE" --log-level warn "$@" < /dev/null; }

echo "==> [1/12] Building plugin (dist/)"
npm run build --silent

echo "==> [2/12] Linking plugin into isolated profile '$PROFILE'"
run_oc plugins install . --link

echo "==> [3/12] Loading plugin runtime and asserting it registered"
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

echo "==> [4/12] plugins doctor"
DOCTOR_OUT="$(run_oc plugins doctor)"
echo "$DOCTOR_OUT"
if echo "$DOCTOR_OUT" | grep -qi "cliq"; then
  echo "FAIL: plugins doctor flagged the cliq plugin (see output above)" >&2
  exit 1
fi

# ---------------------------------------------------------------------------
# Stage 4: real inbound webhook dispatch through the agent pipeline.
#
# The HTTP route is only registered (and the plugin loaded in FULL registration
# mode) when the channel is configured, so we merge a channels.cliq block into
# the profile config the install just wrote, then start a foreground gateway.
# Fake credentials are fine -- the inbound accept path (parse / self-check /
# mention / admission / dedupe) is synchronous and credential-independent; the
# async dispatch reaches the agent lane (proven by the log) and then fails at
# the outbound OAuth hop, which is exactly the evidence we assert on.
# ---------------------------------------------------------------------------
echo "==> [5/12] Writing channels.cliq config for full-mode gateway load"
node -e '
  const fs = require("fs");
  const p = process.env.OPENCLAW_CONFIG_PATH;
  const c = JSON.parse(fs.readFileSync(p, "utf8"));
  c.channels = c.channels || {};
  c.channels.cliq = {
    clientId: "smoke-client-id",
    clientSecret: "smoke-client-secret",
    botId: "openclaw-bot",
    botName: "openclaw-bot",
    webhookSecret: "smoke-webhook-secret",
    dmPolicy: "open",
    allowFrom: ["*"]
  };
  fs.writeFileSync(p, JSON.stringify(c, null, 2));
'
run_oc config validate

# Pick a free loopback port for the gateway HTTP/WS server.
PORT="$(node -e 'const s=require("net").createServer();s.listen(0,"127.0.0.1",()=>{console.log(s.address().port);s.close()})')"
echo "==> [6/12] Starting foreground gateway on 127.0.0.1:$PORT"
GW_LOG="$SMOKE_HOME/gateway.log"
"${OC[@]}" --profile "$PROFILE" --log-level info gateway run \
  --port "$PORT" --auth none --allow-unconfigured \
  < /dev/null > "$GW_LOG" 2>&1 &
GATEWAY_PID=$!

# Poll for readiness: GET the webhook until it responds 405 (Method Not
# Allowed -- the route is wired and the channel is configured, so the handler
# reached the method check). A 404 means the route is not registered yet
# (plugin still loading or channel not configured). Cap at ~30s. GET is used
# (not POST) so no dedupe slot is consumed before the real probes.
WEBHOOK_URL="http://127.0.0.1:$PORT/cliq/webhook"
DM_PAYLOAD='{"message":{"text":"hello","id":"dm-1"},"user":{"id":"user-alice","name":"Alice"}}'
ready=0
for _ in $(seq 1 60); do
  if ! kill -0 "$GATEWAY_PID" 2>/dev/null; then
    echo "FAIL: gateway exited before becoming ready. Log:" >&2
    cat "$GW_LOG" >&2
    exit 1
  fi
  code="$(curl -s -o /dev/null -w "%{http_code}" --max-time 3 -X GET "$WEBHOOK_URL" 2>/dev/null || true)"
  if [ "$code" = "405" ]; then ready=1; break; fi
  sleep 0.5
done
if [ "$ready" -ne 1 ]; then
  echo "FAIL: gateway did not become ready within 30s. Log:" >&2
  cat "$GW_LOG" >&2
  exit 1
fi
echo "OK: gateway ready (route responded)"

echo "==> [7/12] Probing /cliq/webhook with canonical Deluge payloads"

assert_status() {
  local label="$1" expected="$2" actual="$3"
  if [ "$actual" != "$expected" ]; then
    echo "FAIL: $label -> HTTP $actual, expected $expected" >&2
    cat "$GW_LOG" >&2
    exit 1
  fi
  echo "OK: $label -> HTTP $actual"
}

# (a) Valid DM -> 200 + {"status":"received"} (default ackPolicy awaits the
# dispatch resolving, so a 200 means the inbound pipeline completed).
resp="$(curl -s -w "\n%{http_code}" --max-time 30 -X POST "$WEBHOOK_URL" \
  -H "x-cliq-webhook-secret: smoke-webhook-secret" \
  -H "content-type: application/json" \
  --data "$DM_PAYLOAD")"
body="$(printf "%s" "$resp" | sed '$d')"
code="$(printf "%s" "$resp" | tail -n1)"
assert_status "valid DM" 200 "$code"
if [ "$body" != '{"status":"received"}' ]; then
  echo "FAIL: valid DM body was \"$body\", expected {\"status\":\"received\"}" >&2
  exit 1
fi
echo "OK: valid DM body = $body"

# (b) Valid group + bot mention -> 200 + received.
GROUP_PAYLOAD='{"message":{"text":"@openclaw-bot hi","id":"grp-1"},"user":{"id":"user-bob","name":"Bob"},"chat":{"id":"CT_group-B","type":"channel"},"channel":{"unique_name":"general"},"mentions":[{"id":"openclaw-bot","type":"bot"}],"handler":"mention"}'
resp="$(curl -s -w "\n%{http_code}" --max-time 30 -X POST "$WEBHOOK_URL" \
  -H "x-cliq-webhook-secret: smoke-webhook-secret" \
  -H "content-type: application/json" \
  --data "$GROUP_PAYLOAD")"
body="$(printf "%s" "$resp" | sed '$d')"
code="$(printf "%s" "$resp" | tail -n1)"
assert_status "valid group+mention" 200 "$code"
if [ "$body" != '{"status":"received"}' ]; then
  echo "FAIL: valid group body was \"$body\", expected {\"status\":\"received\"}" >&2
  exit 1
fi
echo "OK: valid group+mention body = $body"

# (c) Wrong webhook secret -> 401.
code="$(curl -s -o /dev/null -w "%{http_code}" --max-time 10 -X POST "$WEBHOOK_URL" \
  -H "x-cliq-webhook-secret: WRONG" \
  -H "content-type: application/json" \
  --data "$DM_PAYLOAD")"
assert_status "wrong secret" 401 "$code"

# (d) Malformed (non-JSON) body -> 400.
code="$(curl -s -o /dev/null -w "%{http_code}" --max-time 10 -X POST "$WEBHOOK_URL" \
  -H "x-cliq-webhook-secret: smoke-webhook-secret" \
  -H "content-type: application/json" \
  --data 'not-json-at-all')"
assert_status "malformed body" 400 "$code"

echo "==> [8/12] Asserting the inbound was dispatched to an agent session"
# The agent turn + outbound OAuth fail (no model / no real Zoho credentials),
# but the inbound MUST have been routed to an agent lane. The gateway logs a
# diagnostic with `lane=session:agent:main:cliq:` for the dispatched turn.
# Give the async dispatch a moment to land in the log.
for _ in $(seq 1 20); do
  if grep -q "lane=session:agent:main:cliq:" "$GW_LOG" 2>/dev/null; then break; fi
  sleep 0.5
done
if ! grep -q "lane=session:agent:main:cliq:" "$GW_LOG" 2>/dev/null; then
  echo "FAIL: no agent-lane dispatch line in gateway log (inbound was not routed to an agent)." >&2
  echo "--- gateway log ---" >&2
  cat "$GW_LOG" >&2
  exit 1
fi
echo "OK: inbound dispatched to an agent session (lane=session:agent:main:cliq:...)"
# Corroborate the outbound hop ran too (the deliver path attempted OAuth).
if grep -q "\[cliq\] oauth:" "$GW_LOG" 2>/dev/null; then
  echo "OK: outbound dispatch attempted (oauth path exercised)"
fi

# ---------------------------------------------------------------------------
# Stage 4b: full agent round-trip with a stub model + mocked outbound.
#
# Stage 4 proves the inbound was dispatched to an agent lane and the outbound
# OAuth hop was attempted (and failed at accounts.zoho.eu because the fake
# credentials are not real). Stage 4b goes further: it points the Cliq OAuth +
# REST endpoints at a LOCAL mock, registers a stub OpenAI-compatible model
# that echoes the user message, and asserts the agent reply actually lands at
# the mock's bot-message send endpoint. This is the end-to-end round-trip:
#   inbound webhook -> agent turn (stub model) -> outbound OAuth (mock) ->
#   Cliq bot-message send (mock records it).
# A passing Stage 4b means the entire inbound->reply pipeline works against
# realistic (mocked) upstreams, not just that the inbound was accepted.
# ---------------------------------------------------------------------------

# Stop the Stage-4 gateway -- Stage 4b reconfigures the profile and restarts.
if [ -n "$GATEWAY_PID" ]; then
  kill "$GATEWAY_PID" 2>/dev/null || true
  wait "$GATEWAY_PID" 2>/dev/null || true
  GATEWAY_PID=""
fi

echo "==> [9/12] Starting the Stage-4b mock (OAuth + Cliq send + stub model)"
MOCK_PORT="$(node -e 'const s=require("net").createServer();s.listen(0,"127.0.0.1",()=>{console.log(s.address().port);s.close()})')"
MOCK_LOG="$SMOKE_HOME/mock.log"
SENDS_LOG="$SMOKE_HOME/sends.jsonl"
node "$ROOT/scripts/stage4b-mock.mjs" "$MOCK_PORT" "$SENDS_LOG" < /dev/null > "$MOCK_LOG" 2>&1 &
MOCK_PID=$!
# Poll the mock for readiness (a GET hits the 404 path, proving it's up).
mock_ready=0
for _ in $(seq 1 40); do
  if ! kill -0 "$MOCK_PID" 2>/dev/null; then
    echo "FAIL: mock exited before becoming ready. Log:" >&2
    cat "$MOCK_LOG" >&2
    exit 1
  fi
  code="$(curl -s -o /dev/null -w "%{http_code}" --max-time 2 -X GET "http://127.0.0.1:$MOCK_PORT/" 2>/dev/null || true)"
  if [ "$code" = "404" ]; then mock_ready=1; break; fi
  sleep 0.25
done
if [ "$mock_ready" -ne 1 ]; then
  echo "FAIL: mock did not become ready. Log:" >&2
  cat "$MOCK_LOG" >&2
  exit 1
fi
echo "OK: mock ready on 127.0.0.1:$MOCK_PORT"

echo "==> [10/12] Reconfiguring channels.cliq + stub model and restarting gateway"
MOCK_BASE="http://127.0.0.1:$MOCK_PORT"
export MOCK_BASE
node -e '
  const fs = require("fs");
  const p = process.env.OPENCLAW_CONFIG_PATH;
  const c = JSON.parse(fs.readFileSync(p, "utf8"));
  c.channels = c.channels || {};
  c.channels.cliq = {
    clientId: "smoke-client-id",
    clientSecret: "smoke-client-secret",
    botId: "openclaw-bot",
    botName: "openclaw-bot",
    webhookSecret: "smoke-webhook-secret",
    dmPolicy: "open",
    allowFrom: ["*"],
    apiBase: process.env.MOCK_BASE,
    oauthBase: process.env.MOCK_BASE
  };
  c.models = c.models || {};
  c.models.providers = c.models.providers || {};
  c.models.providers.stub = {
    baseUrl: process.env.MOCK_BASE + "/v1",
    apiKey: "stub-key",
    models: [
      { id: "echo", name: "Echo Stub", api: "openai-completions" }
    ]
  };
  c.agents = c.agents || {};
  c.agents.defaults = c.agents.defaults || {};
  c.agents.defaults.model = "stub/echo";
  fs.writeFileSync(p, JSON.stringify(c, null, 2));
'
run_oc config validate

GW_LOG="$SMOKE_HOME/gateway-4b.log"
"${OC[@]}" --profile "$PROFILE" --log-level info gateway run \
  --port "$PORT" --auth none --allow-unconfigured \
  < /dev/null > "$GW_LOG" 2>&1 &
GATEWAY_PID=$!

# Poll for readiness again (the config changed, so the gateway must reload).
ready=0
for _ in $(seq 1 60); do
  if ! kill -0 "$GATEWAY_PID" 2>/dev/null; then
    echo "FAIL: gateway-4b exited before becoming ready. Log:" >&2
    cat "$GW_LOG" >&2
    exit 1
  fi
  code="$(curl -s -o /dev/null -w "%{http_code}" --max-time 3 -X GET "$WEBHOOK_URL" 2>/dev/null || true)"
  if [ "$code" = "405" ]; then ready=1; break; fi
  sleep 0.5
done
if [ "$ready" -ne 1 ]; then
  echo "FAIL: gateway-4b did not become ready within 30s. Log:" >&2
  cat "$GW_LOG" >&2
  exit 1
fi
echo "OK: gateway-4b ready (route responded)"

echo "==> [11/12] POSTing a DM and asserting the agent reply lands at the mock"
# A unique inbound text so we can match the round-trip in the mock's send log.
ROUNDTRIP_MARKER="stage4b-roundtrip-$$"
DM_PAYLOAD_4B='{"message":{"text":"'"$ROUNDTRIP_MARKER"'","id":"dm-4b"},"user":{"id":"user-alice","name":"Alice"}}'
resp="$(curl -s -w "\n%{http_code}" --max-time 60 -X POST "$WEBHOOK_URL" \
  -H "x-cliq-webhook-secret: smoke-webhook-secret" \
  -H "content-type: application/json" \
  --data "$DM_PAYLOAD_4B")"
code="$(printf "%s" "$resp" | tail -n1)"
if [ "$code" != "200" ]; then
  echo "FAIL: stage-4b DM POST -> HTTP $code, expected 200" >&2
  echo "--- gateway-4b log ---" >&2
  cat "$GW_LOG" >&2
  echo "--- mock log ---" >&2
  cat "$MOCK_LOG" >&2
  exit 1
fi
echo "OK: stage-4b DM POST accepted (HTTP 200)"

# The agent turn + outbound send are async relative to the HTTP 200 (the
# default ackPolicy awaits dispatch, but the outbound delivery happens after
# the agent reply resolves). Poll the mock's sends log for a send whose text
# contains the stub model's "stub-reply:" marker AND the round-trip marker
# (the stub echoes the user text, so the reply contains both).
delivered=0
for _ in $(seq 1 80); do
  if [ -f "$SENDS_LOG" ] && grep -q "stub-reply:" "$SENDS_LOG" 2>/dev/null; then
    if grep -q "$ROUNDTRIP_MARKER" "$SENDS_LOG" 2>/dev/null; then
      delivered=1
      break
    fi
  fi
  sleep 0.5
done
if [ "$delivered" -ne 1 ]; then
  echo "FAIL: agent reply was not delivered to the mock bot-send endpoint." >&2
  echo "--- mock log ---" >&2
  cat "$MOCK_LOG" >&2
  echo "--- mock sends log ---" >&2
  cat "$SENDS_LOG" 2>/dev/null >&2
  echo "--- gateway-4b log (tail) ---" >&2
  tail -n 60 "$GW_LOG" >&2
  exit 1
fi
echo "OK: agent reply delivered end-to-end (mock bot-send recorded the echo)"

echo "==> [12/12] Tearing down mock + gateway"
if [ -n "$MOCK_PID" ]; then kill "$MOCK_PID" 2>/dev/null || true; wait "$MOCK_PID" 2>/dev/null || true; fi
if [ -n "$GATEWAY_PID" ]; then kill "$GATEWAY_PID" 2>/dev/null || true; wait "$GATEWAY_PID" 2>/dev/null || true; fi
GATEWAY_PID=""

echo ""
echo "SMOKE PASSED: plugin loads, registers the cliq channel, a real gateway"
echo "              dispatches an inbound webhook POST through the agent pipeline,"
echo "              and a full inbound->agent->outbound round-trip lands the reply"
