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

function readSafeCode(node: object): string | undefined {
  const code = (node as { code?: unknown }).code;
  return typeof code === "string" && SAFE_CODE.test(code) ? code : undefined;
}

function readSafeSyscall(node: object): string | undefined {
  const syscall = (node as { syscall?: unknown }).syscall;
  return typeof syscall === "string" && SAFE_SYSCALLS.has(syscall) ? syscall : undefined;
}


export function formatCliqErrorForLog(err: unknown): string {
  const root = err !== null && typeof err === "object" ? (err as object) : undefined;
  const name = root && typeof (root as { name?: unknown }).name === "string"
    ? (root as { name: string }).name
    : undefined;
  const safeName = name && SAFE_ERROR_NAMES.has(name) ? name : "Error";
  const message = root && typeof (root as { message?: unknown }).message === "string"
    ? (root as { message: string }).message
    : "";
  const safeMessage = SAFE_ERROR_MESSAGES.has(message) ? message : "";
  let code: string | undefined;
  let syscall: string | undefined;
  const seen = new Set<object>();
  const queue: unknown[] = root ? [root] : [];
  let walked = 0;
  while (queue.length > 0 && walked < 6 && (!code || !syscall)) {
    const current = queue.shift();
    walked++;
    if (current === null || typeof current !== "object" || seen.has(current)) continue;
    seen.add(current);
    code ??= readSafeCode(current);
    syscall ??= readSafeSyscall(current);
    const node = current as { cause?: unknown; errors?: unknown };
    if (node.cause !== undefined) queue.push(node.cause);
    if (Array.isArray(node.errors)) queue.push(...node.errors.slice(0, 4));
  }
  const parts = [`${safeName}${safeMessage ? `: ${safeMessage}` : ""}`];
  if (code) parts.push(`code=${code}`);
  if (syscall) parts.push(`syscall=${syscall}`);
  return parts.join(" ");
}

export function formatCliqErrorCauseForLog(err: unknown): string {
  const rendered = formatCliqErrorForLog(err);
  const fields = rendered.match(/\b(?:code|syscall)=[A-Za-z0-9_]+/g);
  return fields ? fields.join(" ") : "";
}
