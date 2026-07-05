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
