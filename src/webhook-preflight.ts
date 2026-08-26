import { CLIQ_PROBE_HANDLER, buildCliqProbeBody } from "./webhook-probe.js";
import { WEBHOOK_SECRET_HEADER } from "./webhook-security.js";
import { randomUUID } from "node:crypto";

/**
 * Public HTTPS webhook preflight for the Cliq inbound endpoint (issue #96).
 *
 * This module owns DNS/TLS/HTTP/reverse-proxy validation for the public
 * `/cliq/webhook` route. `openclaw setup` uses it to refuse to mark inbound
 * Cliq ready when the endpoint is unreachable or unauthenticated, and the
 * staged doctor (#97) consumes the same report as one diagnostic stage rather
 * than reimplementing the network/auth logic.
 *
 * The value of the preflight is in *distinguishing* failures. "It doesn't
 * work" is useless to an operator; "your DNS record is missing" and "a proxy
 * in front of the route is 301-redirecting the request" lead to different
 * fixes. Every stage therefore reports which boundary failed, and the report
 * always contains every stage (later ones `skipped`) so the JSON shape is
 * stable for machine consumers.
 *
 * Secrets never appear in the report: response bodies are redacted before
 * they are embedded in a stage detail.
 */

/** Per-stage outcome. */
export type CliqPreflightStatus = "pass" | "fail" | "warn" | "skipped";

/** The stages, in execution order. */
export type CliqPreflightStageId =
  | "url"
  | "reachability"
  | "method"
  | "secret"
  | "probe";

export interface CliqPreflightStage {
  id: CliqPreflightStageId;
  label: string;
  status: CliqPreflightStatus;
  detail: string;
}

export interface CliqPreflightReport {
  ok: boolean;
  url: string;
  /** Correlation nonce sent with the authenticated probe. */
  nonce: string;
  /**
   * Whether the probe caused an agent turn. Always `false` for a healthy
   * endpoint — the probe terminates before dispatch by design.
   */
  dispatched: boolean;
  stages: CliqPreflightStage[];
}

/** Minimal response shape the preflight needs from a fetch implementation. */
export interface CliqPreflightResponse {
  status: number;
  text: () => Promise<string>;
  headers?: Record<string, string>;
}

/** Minimal fetch surface, injectable so tests never touch the network. */
export type CliqPreflightFetch = (
  url: string,
  init?: {
    method?: string;
    headers?: Record<string, string>;
    body?: string;
    redirect?: "follow" | "manual";
  },
) => Promise<CliqPreflightResponse>;

/** The route the plugin registers. */
export const CLIQ_WEBHOOK_PATH = "/cliq/webhook";

const DNS_ERROR_CODES = new Set(["ENOTFOUND", "EAI_AGAIN"]);
const TLS_ERROR_CODES = new Set([
  "CERT_HAS_EXPIRED",
  "ERR_TLS_CERT_ALTNAME_INVALID",
  "UNABLE_TO_VERIFY_LEAF_SIGNATURE",
  "DEPTH_ZERO_SELF_SIGNED_CERT",
  "SELF_SIGNED_CERT_IN_CHAIN",
  "ERR_TLS_HANDSHAKE_TIMEOUT",
  "CERT_NOT_YET_VALID",
]);
const PROXY_ERROR_CODES = new Set([
  "ECONNREFUSED",
  "ECONNRESET",
  "ETIMEDOUT",
  "EHOSTUNREACH",
  "ENETUNREACH",
  "EPIPE",
]);

export type CliqPreflightErrorKind = "dns" | "tls" | "proxy" | "network";

function readErrorCode(err: unknown, depth = 0): string | null {
  if (!err || typeof err !== "object" || depth > 4) return null;
  const code = (err as { code?: unknown }).code;
  if (typeof code === "string") return code;
  return readErrorCode((err as { cause?: unknown }).cause, depth + 1);
}

/**
 * Classify a thrown network error into the boundary that failed. `undici`
 * (Node's fetch) wraps the underlying system error in `cause`, so the code is
 * resolved recursively.
 */
export function classifyPreflightNetworkError(err: unknown): CliqPreflightErrorKind {
  const code = readErrorCode(err);
  if (code) {
    if (DNS_ERROR_CODES.has(code)) return "dns";
    if (TLS_ERROR_CODES.has(code)) return "tls";
    if (PROXY_ERROR_CODES.has(code)) return "proxy";
    if (code.startsWith("ERR_TLS") || code.includes("CERT")) return "tls";
  }
  return "network";
}

export type ValidateWebhookUrlResult =
  | { ok: true; hostname: string }
  | { ok: false; reason: string };

/**
 * Validate the webhook URL before any network call: it must parse, must be
 * HTTPS (Zoho refuses plaintext delivery), and must point at the route the
 * plugin actually registers.
 */
export function validateWebhookUrl(raw: string): ValidateWebhookUrlResult {
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    return { ok: false, reason: `not a valid URL: ${raw}` };
  }
  if (parsed.protocol === "http:") {
    return {
      ok: false,
      reason: "must use https — Zoho Cliq refuses to deliver to a plaintext http endpoint",
    };
  }
  if (parsed.protocol !== "https:") {
    return { ok: false, reason: `unsupported protocol ${parsed.protocol} — must be https` };
  }
  if (parsed.pathname.replace(/\/+$/, "") !== CLIQ_WEBHOOK_PATH) {
    return {
      ok: false,
      reason: `path is "${parsed.pathname}" but the plugin registers "${CLIQ_WEBHOOK_PATH}"`,
    };
  }
  return { ok: true, hostname: parsed.hostname };
}

/** Replace the secret with a placeholder anywhere it appears. */
function redact(text: string, secret: string | undefined): string {
  if (!secret) return text;
  return text.split(secret).join("<redacted>");
}

function snippet(text: string, secret: string | undefined, max = 120): string {
  const clean = redact(text, secret).replace(/\s+/g, " ").trim();
  return clean.length > max ? `${clean.slice(0, max)}…` : clean;
}

function looksLikeHtml(body: string, headers: Record<string, string> | undefined): boolean {
  const contentType = headers?.["content-type"] ?? headers?.["Content-Type"] ?? "";
  if (contentType.toLowerCase().includes("text/html")) return true;
  return /^\s*<(!doctype|html)/i.test(body);
}

/**
 * Detect the OpenClaw gateway's own web UI. The gateway registers
 * `/cliq/webhook` only when the `cliq` channel is configured; without it the
 * gateway serves its web UI for the path instead. That is a fundamentally
 * different diagnosis from an upstream challenge page: the tunnel/proxy is
 * working and the request DID reach the origin — the plugin just is not
 * serving the route.
 */
function looksLikeOpenClawWebUi(body: string): boolean {
  return /data-openclaw-terminal-enabled|openclaw/i.test(body.slice(0, 2000));
}

interface StageRecorder {
  stages: CliqPreflightStage[];
  record: (
    id: CliqPreflightStageId,
    label: string,
    status: CliqPreflightStatus,
    detail: string,
  ) => void;
}

function createRecorder(): StageRecorder {
  const stages: CliqPreflightStage[] = [];
  return {
    stages,
    record: (id, label, status, detail) => {
      stages.push({ id, label, status, detail });
    },
  };
}

const STAGE_LABELS: Record<CliqPreflightStageId, string> = {
  url: "URL syntax and HTTPS",
  reachability: "Public DNS, TLS, and transport",
  method: "Route reachability and method handling",
  secret: "Webhook secret enforcement",
  probe: "Authenticated non-dispatching probe",
};

/** Fill in every not-yet-reached stage so the report shape stays stable. */
function skipRemaining(recorder: StageRecorder, reason: string): void {
  const done = new Set(recorder.stages.map((s) => s.id));
  for (const id of ["url", "reachability", "method", "secret", "probe"] as CliqPreflightStageId[]) {
    if (!done.has(id)) recorder.record(id, STAGE_LABELS[id], "skipped", reason);
  }
}

export interface RunCliqWebhookPreflightOptions {
  /** Full public webhook URL, e.g. `https://host.example.com/cliq/webhook`. */
  url: string;
  /** The configured `webhookSecret`. Without it the probe stage is skipped. */
  secret: string | undefined;
  /** Injectable fetch; defaults to global `fetch`. */
  fetchImpl?: CliqPreflightFetch;
  /** Per-request timeout in milliseconds. */
  timeoutMs?: number;
}

function defaultFetch(timeoutMs: number): CliqPreflightFetch {
  return async (url, init) => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetch(url, {
        method: init?.method,
        headers: init?.headers,
        body: init?.body,
        redirect: init?.redirect ?? "manual",
        signal: controller.signal,
      });
      const headers: Record<string, string> = {};
      res.headers.forEach((value, key) => {
        headers[key.toLowerCase()] = value;
      });
      return { status: res.status, text: () => res.text(), headers };
    } finally {
      clearTimeout(timer);
    }
  };
}

/**
 * Run the full preflight against a public webhook URL.
 *
 * Stages, in order:
 *  1. `url` — syntax, HTTPS, and the expected route path (no network).
 *  2. `reachability` — a `GET` proves DNS, TLS, and transport; failures are
 *     classified into dns / tls / proxy / network.
 *  3. `method` — the route must answer `405` to `GET` (a live plugin route).
 *     A redirect or an HTML body means something sits in front of the route.
 *  4. `secret` — an unauthenticated and a wrong-secret POST must both be
 *     rejected. An endpoint that accepts either is an open door.
 *  5. `probe` — an authenticated probe reaches the plugin and returns without
 *     dispatching an agent turn.
 */
export async function runCliqWebhookPreflight(
  options: RunCliqWebhookPreflightOptions,
): Promise<CliqPreflightReport> {
  const timeoutMs = options.timeoutMs ?? 15_000;
  const fetchImpl = options.fetchImpl ?? defaultFetch(timeoutMs);
  const secret = options.secret;
  const nonce = randomUUID();
  const recorder = createRecorder();
  const fail = (detail: string): CliqPreflightReport => {
    skipRemaining(recorder, detail ? "not reached: an earlier stage failed" : "not reached");
    return { ok: false, url: options.url, nonce, dispatched: false, stages: recorder.stages };
  };

  // ---- Stage 1: URL -------------------------------------------------------
  const urlCheck = validateWebhookUrl(options.url);
  if (!urlCheck.ok) {
    recorder.record("url", STAGE_LABELS.url, "fail", urlCheck.reason);
    return fail(urlCheck.reason);
  }
  recorder.record(
    "url",
    STAGE_LABELS.url,
    "pass",
    `https and ${CLIQ_WEBHOOK_PATH} on ${urlCheck.hostname}`,
  );

  // ---- Stage 2 + 3: reachability and method -------------------------------
  let getRes: CliqPreflightResponse;
  try {
    getRes = await fetchImpl(options.url, { method: "GET", redirect: "manual" });
  } catch (err) {
    const kind = classifyPreflightNetworkError(err);
    const detail =
      kind === "dns"
        ? `DNS did not resolve ${urlCheck.hostname} — the public hostname has no record yet`
        : kind === "tls"
          ? `TLS failed for ${urlCheck.hostname} — certificate hostname, validity, or chain is wrong`
          : kind === "proxy"
            ? `could not connect to ${urlCheck.hostname} — the reverse proxy or tunnel is not accepting connections`
            : `network failure contacting ${urlCheck.hostname}: ${String(err)}`;
    recorder.record("reachability", STAGE_LABELS.reachability, "fail", detail);
    return fail(detail);
  }
  recorder.record(
    "reachability",
    STAGE_LABELS.reachability,
    "pass",
    `DNS, TLS, and transport to ${urlCheck.hostname} are healthy`,
  );

  const getBody = await getRes.text();
  if (getRes.status >= 300 && getRes.status < 400) {
    const location = getRes.headers?.["location"] ?? "(no Location header)";
    const detail = `redirect: the endpoint answered ${getRes.status} to ${location} instead of reaching the plugin route. A catch-all redirect rule in front of the route intercepts Zoho's delivery.`;
    recorder.record("method", STAGE_LABELS.method, "fail", detail);
    return fail(detail);
  }
  if (getRes.status === 404) {
    const detail = `route not found: the endpoint answered 404. The plugin registers ${CLIQ_WEBHOOK_PATH} only when the cliq channel is configured, and the reverse proxy must forward that exact path.`;
    recorder.record("method", STAGE_LABELS.method, "fail", detail);
    return fail(detail);
  }
  if (looksLikeHtml(getBody, getRes.headers)) {
    const detail = looksLikeOpenClawWebUi(getBody)
      ? `the request reached the OpenClaw gateway, but the gateway web UI answered instead of ${CLIQ_WEBHOOK_PATH}. The tunnel/reverse proxy is healthy; the Cliq plugin route is not registered — install/enable the plugin and configure channels.cliq.`
      : `an HTML page answered instead of the plugin route (login page, challenge, or captcha). Zoho's Deluge handler cannot solve an interactive challenge — exempt this hostname.`;
    recorder.record("method", STAGE_LABELS.method, "fail", detail);
    return fail(detail);
  }
  if (getRes.status !== 405) {
    const detail = `expected 405 Method Not Allowed on GET (the live plugin route), got ${getRes.status}: ${snippet(getBody, secret)}`;
    recorder.record("method", STAGE_LABELS.method, "fail", detail);
    return fail(detail);
  }
  recorder.record(
    "method",
    STAGE_LABELS.method,
    "pass",
    "GET is rejected with 405 — the plugin route is live and does not accept GET as delivery",
  );

  // ---- Stage 4: secret enforcement ---------------------------------------
  const probeBody = JSON.stringify(buildCliqProbeBody(nonce));
  const jsonHeaders = { "content-type": "application/json" };

  let unauthed: CliqPreflightResponse;
  try {
    unauthed = await fetchImpl(options.url, {
      method: "POST",
      headers: jsonHeaders,
      body: probeBody,
      redirect: "manual",
    });
  } catch (err) {
    const detail = `unauthenticated probe failed to complete: ${String(err)}`;
    recorder.record("secret", STAGE_LABELS.secret, "fail", detail);
    return fail(detail);
  }
  if (unauthed.status === 503) {
    const body = await unauthed.text();
    const detail = `the gateway answered 503 — webhookSecret is not configured on the plugin, so inbound delivery is disabled and fails closed: ${snippet(body, secret)}`;
    recorder.record("secret", STAGE_LABELS.secret, "fail", detail);
    return fail(detail);
  }
  if (unauthed.status !== 401 && unauthed.status !== 429) {
    const body = await unauthed.text();
    const detail = `the endpoint accepted a POST without a secret (status ${unauthed.status}) — an unauthenticated caller can reach the webhook: ${snippet(body, secret)}`;
    recorder.record("secret", STAGE_LABELS.secret, "fail", detail);
    return fail(detail);
  }

  let wrongSecret: CliqPreflightResponse;
  try {
    wrongSecret = await fetchImpl(options.url, {
      method: "POST",
      headers: { ...jsonHeaders, [WEBHOOK_SECRET_HEADER]: `not-${nonce}` },
      body: probeBody,
      redirect: "manual",
    });
  } catch (err) {
    const detail = `wrong-secret probe failed to complete: ${String(err)}`;
    recorder.record("secret", STAGE_LABELS.secret, "fail", detail);
    return fail(detail);
  }
  if (wrongSecret.status !== 401 && wrongSecret.status !== 429) {
    const body = await wrongSecret.text();
    const detail = `the endpoint accepted a wrong secret (status ${wrongSecret.status}) — the shared-secret check is not enforced: ${snippet(body, secret)}`;
    recorder.record("secret", STAGE_LABELS.secret, "fail", detail);
    return fail(detail);
  }
  recorder.record(
    "secret",
    STAGE_LABELS.secret,
    "pass",
    "missing and wrong secrets are both rejected with 401",
  );

  // ---- Stage 5: authenticated non-dispatching probe -----------------------
  if (!secret) {
    const detail =
      "no webhookSecret available to authenticate with — configure channels.cliq.webhookSecret to complete the preflight";
    recorder.record("probe", STAGE_LABELS.probe, "skipped", detail);
    return { ok: false, url: options.url, nonce, dispatched: false, stages: recorder.stages };
  }

  let authed: CliqPreflightResponse;
  try {
    authed = await fetchImpl(options.url, {
      method: "POST",
      headers: { ...jsonHeaders, [WEBHOOK_SECRET_HEADER]: secret },
      body: probeBody,
      redirect: "manual",
    });
  } catch (err) {
    const detail = `authenticated probe failed to complete: ${String(err)}`;
    recorder.record("probe", STAGE_LABELS.probe, "fail", detail);
    return fail(detail);
  }
  const authedBody = await authed.text();
  if (authed.status !== 200) {
    const detail = `the authenticated probe was rejected with ${authed.status}. The gateway may be running an older version of the plugin that does not recognize the "${CLIQ_PROBE_HANDLER}" probe payload: ${snippet(authedBody, secret)}`;
    recorder.record("probe", STAGE_LABELS.probe, "fail", detail);
    return fail(detail);
  }

  let dispatched = false;
  let echoed = "";
  try {
    const parsed = JSON.parse(authedBody) as { probe?: unknown; dispatched?: unknown };
    echoed = typeof parsed.probe === "string" ? parsed.probe : "";
    dispatched = parsed.dispatched === true;
  } catch {
    // A 200 with a non-JSON body still proves reachability + auth, but not
    // the no-dispatch contract.
    const detail = `the authenticated probe returned 200 but the body was not the expected probe response: ${snippet(authedBody, secret)}`;
    recorder.record("probe", STAGE_LABELS.probe, "warn", detail);
    return { ok: false, url: options.url, nonce, dispatched: false, stages: recorder.stages };
  }

  if (dispatched) {
    const detail = "the probe reported that it dispatched an agent turn — the no-dispatch guarantee is broken";
    recorder.record("probe", STAGE_LABELS.probe, "fail", detail);
    return fail(detail);
  }
  if (echoed && echoed !== nonce) {
    const detail = `the probe echoed a different nonce (${snippet(echoed, secret, 40)}) — the response did not come from this request`;
    recorder.record("probe", STAGE_LABELS.probe, "fail", detail);
    return fail(detail);
  }

  recorder.record(
    "probe",
    STAGE_LABELS.probe,
    "pass",
    "the authenticated probe reached the plugin and returned without dispatching an agent turn (no agent turn, session entry, or Cliq message was created)",
  );

  return { ok: true, url: options.url, nonce, dispatched: false, stages: recorder.stages };
}

/** Render a report as human-readable lines for CLI output. */
export function formatCliqPreflightReport(report: CliqPreflightReport): string[] {
  const icon: Record<CliqPreflightStatus, string> = {
    pass: "✓",
    fail: "✗",
    warn: "!",
    skipped: "-",
  };
  const lines = [`Cliq webhook preflight: ${report.url}`];
  for (const stage of report.stages) {
    lines.push(`  ${icon[stage.status]} ${stage.label}: ${stage.detail}`);
  }
  lines.push(report.ok ? "Result: inbound Cliq is reachable and authenticated." : "Result: inbound Cliq is NOT ready.");
  return lines;
}
