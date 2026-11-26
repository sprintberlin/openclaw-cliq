/**
 * Structured logging surface for the outbound Cliq send path.
 *
 * The gateway exposes a `PluginLogger` (`api.logger`) to plugin registration
 * code, but the outbound `CliqClient` lives behind the channel adapter and has
 * no direct access to `api`. This module bridges that gap with a tiny
 * indirection: the webhook `registerFull` hook calls `setCliqDefaultLogger`
 * once at startup with `api.logger`, and every `CliqClient` created
 * thereafter resolves its logger through `getCliqDefaultLogger()`.
 *
 * When no runtime logger has been injected (e.g. unit tests, or a `CliqClient`
 * constructed directly without the registry), the default falls back to the
 * console so a failed send is never invisible. The fallback is intentional —
 * observability of the outbound hop must not depend on the plugin having been
 * registered through the gateway first.
 *
 * **Secret safety.** None of the call sites that consume this logger may emit
 * the OAuth access token, the `clientSecret`, or the webhook secret. The
 * client logs only: target kind (dm vs channel) + resolved id, text *length*
 * (never the text itself), HTTP status, and the response body (truncated) on
 * error.
 */
export interface CliqLogger {
  debug?(message: string): void;
  info?(message: string): void;
  warn?(message: string): void;
  error?(message: string): void;
}

/** A logger that discards everything. Used as the null default in tests. */
export const NOOP_LOGGER: CliqLogger = {};

/**
 * Console-backed fallback logger. Used until `setCliqDefaultLogger` injects
 * the gateway's `api.logger`. Keeps the `[cliq]` prefix so log lines are
 * greppable alongside the inbound path's own `[cliq]` lines.
 */
const CONSOLE_LOGGER: CliqLogger = {
  debug: (m) => {
    // eslint-disable-next-line no-console
    console.debug(m);
  },
  info: (m) => {
    // eslint-disable-next-line no-console
    console.info(m);
  },
  warn: (m) => {
    // eslint-disable-next-line no-console
    console.warn(m);
  },
  error: (m) => {
    // eslint-disable-next-line no-console
    console.error(m);
  },
};

let defaultLogger: CliqLogger = CONSOLE_LOGGER;

/** Resolve the current default logger (console fallback until injected). */
export function getCliqDefaultLogger(): CliqLogger {
  return defaultLogger;
}

/**
 * Inject the gateway `api.logger` (or any sink) as the default for
 * subsequently created `CliqClient` instances. Passing `null` restores the
 * console fallback (used by test resets).
 */
export function setCliqDefaultLogger(logger: CliqLogger | null): void {
  defaultLogger = logger ?? CONSOLE_LOGGER;
}

/**
 * Truncate a response body for safe logging. Keeps the head of the body (where
 * the diagnostic message usually sits) and caps the total length so a verbose
 * Cliq error envelope cannot flood the gateway log.
 */
export function truncateForLog(body: string, max = 500): string {
  if (body.length <= max) return body;
  return `${body.slice(0, max)}…(${body.length} bytes)`;
}

const SAFE_ERROR_NAMES = new Set([
  "Error",
  "TypeError",
  "AggregateError",
  "SocketError",
  "ConnectTimeoutError",
  "HeadersTimeoutError",
  "BodyTimeoutError",
  "AbortError",
  "TimeoutError",
  "CliqSendError",
]);
const SAFE_CODE = /^[A-Z][A-Z0-9_]{1,63}$/;
const SAFE_SYSCALLS = new Set([
  "connect",
  "read",
  "write",
  "getaddrinfo",
  "getnameinfo",
  "lookup",
  "recv",
  "send",
  "socket",
]);

const SAFE_ERROR_MESSAGES = new Set(["fetch failed", "terminated"]);

const SAFE_SEND_KINDS = new Set(["transient", "fatal", "format_rejected"]);

const KNOWN_OAUTH_ERROR_CODES = new Set([
  "invalid_client",
  "invalid_grant",
  "invalid_code",
  "invalid_scope",
  "oauthtoken_scope_invalid",
]);

const OAUTH_ERROR_PREFIXES = [
  "cliq: OAuth token request failed (",
  "cliq: OAuth refresh token request failed (",
] as const;

const DATA_CENTER_HINT_SEPARATOR =
  " — verify your Zoho data center — set oauthBase + apiBase to match (see README → Data centers)";

function readStringSafely(node: object, key: string): string | undefined {
  try {
    const value = (node as Record<string, unknown>)[key];
    return typeof value === "string" ? value : undefined;
  } catch {
    return undefined;
  }
}

function readSafeStatus(node: object): string | undefined {
  try {
    const status = (node as Record<string, unknown>)["status"];
    if (typeof status !== "number" || !Number.isInteger(status) || status < 100 || status > 599) {
      return undefined;
    }
    return String(status);
  } catch {
    return undefined;
  }
}

function readSafeSendKind(node: object): string | undefined {
  const kind = readStringSafely(node, "kind");
  return kind !== undefined && SAFE_SEND_KINDS.has(kind) ? kind : undefined;
}

function readOAuthDiagnostic(message: string): { code?: string; status?: string } | undefined {
  const prefix = OAUTH_ERROR_PREFIXES.find((candidate) => message.startsWith(candidate));
  if (!prefix) return undefined;
  const body = message.slice(prefix.length);
  const statusMatch = /^([1-5]\d\d)\)/.exec(body);
  if (!statusMatch) return undefined;
  let remainder = body.slice(statusMatch[0].length);
  if (remainder.endsWith(DATA_CENTER_HINT_SEPARATOR)) {
    remainder = remainder.slice(0, -DATA_CENTER_HINT_SEPARATOR.length);
  }
  if (remainder === "") return { status: statusMatch[1] };
  if (!remainder.startsWith(": ")) return undefined;
  const code = remainder.slice(2);
  if (!KNOWN_OAUTH_ERROR_CODES.has(code)) return undefined;
  return { code, status: statusMatch[1] };
}

function readSafeCode(node: object): string | undefined {
  const code = readStringSafely(node, "code");
  return code !== undefined && SAFE_CODE.test(code) ? code : undefined;
}

function readSafeSyscall(node: object): string | undefined {
  const syscall = readStringSafely(node, "syscall");
  return syscall !== undefined && SAFE_SYSCALLS.has(syscall) ? syscall : undefined;
}

interface CliqErrorFacts {
  safeName: string;
  safeMessage: string;
  oauthCode?: string;
  oauthStatus?: string;
  status?: string;
  sendKind?: string;
  code?: string;
  syscall?: string;
}

function collectCliqErrorFacts(err: unknown): CliqErrorFacts {
  const root = err !== null && typeof err === "object" ? (err as object) : undefined;
  const name = root ? readStringSafely(root, "name") : undefined;
  const safeName = name && SAFE_ERROR_NAMES.has(name) ? name : "Error";
  const rawMessage = root ? readStringSafely(root, "message") : undefined;
  const oauth = rawMessage === undefined ? undefined : readOAuthDiagnostic(rawMessage);
  const safeMessage =
    oauth === undefined && rawMessage !== undefined && SAFE_ERROR_MESSAGES.has(rawMessage)
      ? rawMessage
      : "";
  const facts: CliqErrorFacts = {
    safeName,
    safeMessage,
    ...(oauth?.code !== undefined ? { oauthCode: oauth.code } : {}),
    ...(oauth?.status !== undefined ? { oauthStatus: oauth.status } : {}),
  };
  const seen = new Set<object>();
  const queue: unknown[] = root ? [root] : [];
  let walked = 0;
  while (
    queue.length > 0 &&
    walked < 8 &&
    (facts.code === undefined ||
      facts.syscall === undefined ||
      facts.sendKind === undefined ||
      facts.status === undefined)
  ) {
    const current = queue.shift();
    walked++;
    if (current === null || typeof current !== "object" || seen.has(current)) continue;
    seen.add(current);
    facts.code ??= readSafeCode(current);
    facts.syscall ??= readSafeSyscall(current);
    facts.sendKind ??= readSafeSendKind(current);
    facts.status ??= readSafeStatus(current);
    let cause: unknown;
    let errors: unknown;
    try {
      cause = (current as { cause?: unknown }).cause;
    } catch {
      cause = undefined;
    }
    try {
      errors = (current as { errors?: unknown }).errors;
    } catch {
      errors = undefined;
    }
    if (cause !== undefined) queue.push(cause);
    if (Array.isArray(errors)) queue.push(...errors.slice(0, 4));
  }
  return facts;
}

export function formatCliqErrorForLog(err: unknown): string {
  const facts = collectCliqErrorFacts(err);
  const parts = [`${facts.safeName}${facts.safeMessage ? `: ${facts.safeMessage}` : ""}`];
  if (facts.code) parts.push(`code=${facts.code}`);
  if (facts.syscall) parts.push(`syscall=${facts.syscall}`);
  return parts.join(" ");
}

export function formatCliqDeliveryErrorForLog(err: unknown): string {
  const facts = collectCliqErrorFacts(err);
  const parts = [`${facts.safeName}${facts.safeMessage ? `: ${facts.safeMessage}` : ""}`];
  const status = facts.status ?? facts.oauthStatus;
  const code = facts.code ?? facts.oauthCode;
  if (status !== undefined) parts.push(`status=${status}`);
  if (facts.sendKind !== undefined) parts.push(`kind=${facts.sendKind}`);
  if (code !== undefined) parts.push(`code=${code}`);
  if (facts.syscall) parts.push(`syscall=${facts.syscall}`);
  return parts.join(" ");
}

export function formatCliqErrorCauseForLog(err: unknown): string {
  const rendered = formatCliqErrorForLog(err);
  const fields = rendered.match(/\b(?:code|syscall)=[A-Za-z0-9_]+/g);
  return fields ? fields.join(" ") : "";
}
