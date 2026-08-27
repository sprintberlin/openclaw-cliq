import { CLIQ_WEBHOOK_PATH } from "./webhook-preflight.js";

export const DEFAULT_GATEWAY_PORT = 18789;

export type CliqRouteCheckStatus = "registered" | "absent" | "unknown";

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
  text: () => Promise<string>;
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
      return { status: res.status, text: () => res.text(), headers };
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
    return {
      ok: true,
      status: "registered",
      url,
      httpStatus: 405,
      detail: `${CLIQ_WEBHOOK_PATH} is registered: GET was rejected with 405 by the plugin's own handler.`,
      inspectNote: INSPECT_NOTE,
    };
  }
  if (res.status === 404) {
    return {
      ok: false,
      status: "absent",
      url,
      httpStatus: 404,
      detail: `${CLIQ_WEBHOOK_PATH} is NOT registered: the gateway answered 404. Install and enable the plugin, and configure channels.cliq — a channel plugin registers its route only once its channel is configured.`,
      inspectNote: INSPECT_NOTE,
    };
  }

  const body = await res.text().catch(() => "");
  const snippet = body.replace(/\s+/g, " ").trim().slice(0, 120);
  return {
    status: "unknown",
    ok: false,
    url,
    httpStatus: res.status,
    detail: `inconclusive: expected 405 (registered) or 404 (absent) on GET, got ${res.status}${
      snippet ? `: ${snippet}` : ""
    }. Something other than the plugin route answered — check what is listening on this address.`,
    inspectNote: INSPECT_NOTE,
  };
}

export function formatCliqRouteCheckReport(report: CliqRouteCheckReport): string[] {
  const icon = report.status === "registered" ? "PASS" : report.status === "absent" ? "FAIL" : "WARN";
  return [
    `Cliq webhook route check: ${report.url}`,
    `  ${icon}: ${report.detail}`,
    `  ${report.inspectNote}`,
  ];
}
