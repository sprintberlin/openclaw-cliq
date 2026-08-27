import { CLIQ_WEBHOOK_PATH } from "./webhook-preflight.js";

export const DEFAULT_GATEWAY_PORT = 18789;
export const CLIQ_ROUTE_HEADER = "x-openclaw-cliq-route";
export const CLIQ_ROUTE_HEADER_VALUE = "webhook";

/**
 * `registered` is only claimed on a signed 405. Everything else — including a
 * 404, which a proxy can generate without ever reaching the gateway — is
 * `unknown`: this check reports what it can prove, never what it infers.
 */
export type CliqRouteCheckStatus = "registered" | "unknown";

export interface CliqRouteCheckReport {
  ok: boolean;
  status: CliqRouteCheckStatus;
  url: string;
  httpStatus: number | null;
  detail: string;
  inspectNote: string;
}

export interface CliqRouteCheckResponse {
  status: number;
  headers?: Record<string, string>;
}

export type CliqRouteCheckFetch = (
  url: string,
  init?: { method?: string; redirect?: "follow" | "manual" },
) => Promise<CliqRouteCheckResponse>;

export const INSPECT_NOTE =
  'Note: `openclaw plugins inspect cliq --runtime --json` reports "httpRoutes": 0 even when the route is registered. That command loads the plugin without activating it, so the registerFull step that registers /cliq/webhook never runs for it. This check queries the running gateway instead, so it reflects reality.';

export function buildLocalWebhookUrl(options: {
  port?: number;
  host?: string;
} = {}): string {
  const host = options.host ?? "127.0.0.1";
  const port = options.port ?? DEFAULT_GATEWAY_PORT;
  return `http://${host}:${port}${CLIQ_WEBHOOK_PATH}`;
}

function validateRouteCheckUrl(raw: string): { ok: true } | { ok: false; reason: string } {
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    return { ok: false, reason: `not a valid URL: ${raw}` };
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return { ok: false, reason: `unsupported protocol ${parsed.protocol} — must be http or https` };
  }
  if (parsed.pathname.replace(/\/+$/, "") !== CLIQ_WEBHOOK_PATH) {
    return {
      ok: false,
      reason: `path is "${parsed.pathname}" but the plugin registers "${CLIQ_WEBHOOK_PATH}"`,
    };
  }
  return { ok: true };
}

function defaultFetch(timeoutMs: number): CliqRouteCheckFetch {
  return async (url, init) => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    // Never let a pending deadline keep the process alive: the timer is only
    // a ceiling, not work of its own.
    timer.unref?.();
    try {
      const res = await fetch(url, {
        method: init?.method,
        redirect: init?.redirect ?? "manual",
        signal: controller.signal,
      });
      const headers: Record<string, string> = {};
      res.headers.forEach((value, key) => {
        headers[key.toLowerCase()] = value;
      });
      // The verdict is derived from the status and the route-signature
      // header only. The body is never read, so a server that sends headers
      // and then stalls (or streams an unbounded body) cannot hang or
      // balloon this check.
      await res.body?.cancel().catch(() => {});
      return { status: res.status, headers };
    } finally {
      clearTimeout(timer);
    }
  };
}

export interface CheckCliqWebhookRouteOptions {
  url?: string;
  port?: number;
  fetchImpl?: CliqRouteCheckFetch;
  timeoutMs?: number;
}

export async function checkCliqWebhookRoute(
  options: CheckCliqWebhookRouteOptions = {},
): Promise<CliqRouteCheckReport> {
  const timeoutMs = options.timeoutMs ?? 5_000;
  const url = options.url ?? buildLocalWebhookUrl({ port: options.port });
  const fetchImpl = options.fetchImpl ?? defaultFetch(timeoutMs);

  const urlCheck = validateRouteCheckUrl(url);
  if (!urlCheck.ok) {
    return {
      ok: false,
      status: "unknown",
      url,
      httpStatus: null,
      detail: `cannot check this URL: ${urlCheck.reason}`,
      inspectNote: INSPECT_NOTE,
    };
  }

  let res: CliqRouteCheckResponse;
  try {
    res = await fetchImpl(url, { method: "GET", redirect: "manual" });
  } catch (err) {
    return {
      ok: false,
      status: "unknown",
      url,
      httpStatus: null,
      detail: `could not reach the gateway at ${url}: ${String(err)}. Start the gateway (or pass the right --port) and run this again — an unreachable gateway says nothing about route registration.`,
      inspectNote: INSPECT_NOTE,
    };
  }

  if (res.status === 405) {
    const headers = res.headers ?? {};
    // Header names are case-insensitive; a custom fetchImpl may preserve the
    // wire casing, so normalize before looking the signature up.
    const routeHeader = Object.entries(headers).find(
      ([key]) => key.toLowerCase() === CLIQ_ROUTE_HEADER,
    )?.[1];
    if (routeHeader !== CLIQ_ROUTE_HEADER_VALUE) {
      return {
        ok: false,
        status: "unknown",
        url,
        httpStatus: 405,
        detail: `inconclusive: GET was rejected with 405, but the response did not carry the Cliq route signature ${CLIQ_ROUTE_HEADER}: ${CLIQ_ROUTE_HEADER_VALUE}. Another service may be answering.`,
        inspectNote: INSPECT_NOTE,
      };
    }
    return {
      ok: true,
      status: "registered",
      url,
      httpStatus: 405,
      detail: `${CLIQ_WEBHOOK_PATH} is registered: GET was rejected with 405 and the response carried the plugin's route signature.`,
      inspectNote: INSPECT_NOTE,
    };
  }
  if (res.status === 404) {
    return {
      ok: false,
      status: "unknown",
      url,
      httpStatus: 404,
      detail:
        "inconclusive: the address answered 404. The Cliq route did not answer, but a proxy or another service may have generated this response; query the gateway address directly to distinguish an absent route.",
      inspectNote: INSPECT_NOTE,
    };
  }

  return {
    status: "unknown",
    ok: false,
    url,
    httpStatus: res.status,
    detail: `inconclusive: expected 405 with the Cliq route signature, got ${res.status}. Something other than the plugin route answered — check what is listening on this address.`,
    inspectNote: INSPECT_NOTE,
  };
}

export function formatCliqRouteCheckReport(report: CliqRouteCheckReport): string[] {
  const icon = report.status === "registered" ? "PASS" : "WARN";
  return [
    `Cliq webhook route check: ${report.url}`,
    `  ${icon}: ${report.detail}`,
    `  ${report.inspectNote}`,
  ];
}
