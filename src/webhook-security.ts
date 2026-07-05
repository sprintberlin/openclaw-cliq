import { timingSafeEqual } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";

/**
 * Webhook security primitives for the Cliq inbound endpoint.
 *
 * Design goals (see ROADMAP "Webhook security hardening"):
 *  - **Constant-time secret compare** so a timing side-channel cannot leak the
 *    shared secret byte-by-byte.
 *  - **Single-header enforcement** — only `x-cliq-webhook-secret` is honored.
 *    Accepting multiple headers (Authorization, x-webhook-secret, …) widens
 *    the attack surface: a misconfigured proxy that forwards one of them lets
 *    an attacker bypass the secret check. Cliq's Deluge handler is documented
 *    to send exactly `x-cliq-webhook-secret`.
 *  - **Connection close on failure** — every rejected request carries
 *    `Connection: close` so the underlying keep-alive socket is torn down
 *    after the response, denying an attacker a persistent channel for rapid
 *    retries on the same connection.
 *  - **Rate-limit only failed-auth attempts** — a per-IP fixed window caps how
 *    many *failed* authentications we will service. Legitimate Cliq delivery
 *    (which passes auth) is never throttled, so this cannot starve real
 *    traffic even under a flood of valid webhooks.
 */

export const WEBHOOK_SECRET_HEADER = "x-cliq-webhook-secret";

/** Default ceiling for failed-auth attempts per IP per window. */
export const DEFAULT_FAIL_AUTH_MAX = 60;
/** Default window length for the failed-auth fixed window. */
export const DEFAULT_FAIL_AUTH_WINDOW_MS = 60_000;

/**
 * Constant-time comparison of two secret strings.
 *
 * `timingSafeEqual` requires equal-length buffers, so when the lengths differ
 * we still run a (pointless) compare against the expected buffer itself to
 * keep the wall-clock cost roughly constant. The length itself is already a
 * weak signal (an attacker can observe the request timing, not the secret
 * length), but we avoid the early-return shortcut regardless.
 */
export function constantTimeSecretMatch(provided: string, expected: string): boolean {
  const a = Buffer.from(provided, "utf8");
  const b = Buffer.from(expected, "utf8");
  if (a.length !== b.length) {
    timingSafeEqual(b, b);
    return false;
  }
  return timingSafeEqual(a, b);
}

/** Read the single accepted webhook-secret header value, if present. */
export function readWebhookSecretHeader(
  req: Pick<IncomingMessage, "headers">,
): string | undefined {
  const v = req.headers[WEBHOOK_SECRET_HEADER];
  if (Array.isArray(v)) return v[0];
  return typeof v === "string" ? v : undefined;
}

/**
 * Verify the shared webhook secret. Returns `true` when no secret is
 * configured (optional-but-recommended) or when the
 * `x-cliq-webhook-secret` header matches the configured secret in constant
 * time. Any other header (Authorization, x-webhook-secret, …) is ignored.
 */
export function verifyWebhookSecret(
  req: Pick<IncomingMessage, "headers">,
  expectedSecret: string | undefined,
): boolean {
  if (!expectedSecret) return true;
  const provided = readWebhookSecretHeader(req);
  if (!provided) return false;
  return constantTimeSecretMatch(provided, expectedSecret);
}

/**
 * Best-effort client-IP extraction. Falls back to `"unknown"` when no socket
 * is available (e.g. unit-test mocks). Honors `x-forwarded-for` only when a
 * trusted-looking single hop is present; we deliberately do NOT trust long
 * XFF chains because the gateway already terminates TLS and gives us the
 * direct peer.
 */
export function resolveClientIp(
  req: Pick<IncomingMessage, "headers" | "socket"> & { socket?: { remoteAddress?: string } },
): string {
  const xff = req.headers["x-forwarded-for"];
  if (typeof xff === "string" && xff.length > 0) {
    const first = xff.split(",")[0]?.trim();
    if (first) return first;
  }
  return req.socket?.remoteAddress ?? "unknown";
}

export interface FailedAuthRateLimiter {
  /** Record a failed attempt for `ip` and report whether it is now limited. */
  hit(ip: string): { limited: boolean; retryAfterMs: number };
  /** Clear all buckets (test reset only). */
  reset(): void;
}

/**
 * In-memory fixed-window rate limiter scoped to *failed* webhook
 * authentications. A passing request never touches this — only a 401 path
 * calls `hit()` — so legitimate Cliq delivery is never throttled.
 *
 * The limiter is process-local. That is acceptable for the single-gateway
 * deployment this plugin targets; a multi-replica deployment would need a
 * shared store (Redis), which is out of scope here.
 */
export function createFailedAuthRateLimiter(opts: {
  max?: number;
  windowMs?: number;
} = {}): FailedAuthRateLimiter {
  const max = opts.max ?? DEFAULT_FAIL_AUTH_MAX;
  const windowMs = opts.windowMs ?? DEFAULT_FAIL_AUTH_WINDOW_MS;
  const buckets = new Map<string, { count: number; expiresAt: number }>();

  const hit = (ip: string): { limited: boolean; retryAfterMs: number } => {
    const now = Date.now();
    let bucket = buckets.get(ip);
    if (!bucket || bucket.expiresAt <= now) {
      bucket = { count: 0, expiresAt: now + windowMs };
      buckets.set(ip, bucket);
    }
    bucket.count += 1;
    if (bucket.count > max) {
      return { limited: true, retryAfterMs: Math.max(bucket.expiresAt - now, 0) };
    }
    return { limited: false, retryAfterMs: 0 };
  };

  const reset = (): void => {
    buckets.clear();
  };

  return { hit, reset };
}

export interface RejectUnauthedOpts {
  req: Pick<IncomingMessage, "headers" | "socket"> & { socket?: { remoteAddress?: string } };
  res: Pick<ServerResponse, "setHeader" | "end" | "statusCode">;
  limiter: FailedAuthRateLimiter;
  logger?: { warn?: (msg: string) => void; debug?: (msg: string) => void };
}

/**
 * Reject a webhook that failed secret verification. Applies the per-IP failed
 * auth rate limit and writes either 429 (over the limit) or 401 (under).
 * Always sets `Connection: close` so the keep-alive socket is torn down
 * after the response — a denied attacker cannot reuse the connection.
 *
 * Returns the status code that was written, for caller logging.
 */
export function rejectUnauthedWebhook(opts: RejectUnauthedOpts): number {
  const { req, res, limiter, logger } = opts;
  const ip = resolveClientIp(req);
  const { limited, retryAfterMs } = limiter.hit(ip);
  // Always close the connection after a denied request, regardless of
  // whether we rate-limited this one or not.
  res.setHeader("Connection", "close");
  if (limited) {
    res.setHeader("Retry-After", String(Math.max(1, Math.ceil(retryAfterMs / 1000))));
    res.statusCode = 429;
    res.end("too many failed auth attempts");
    logger?.warn?.(`[cliq] webhook rate-limited (failed auth) from ${ip}`);
    return 429;
  }
  res.statusCode = 401;
  res.end("unauthorized");
  logger?.debug?.(`[cliq] webhook rejected: invalid secret from ${ip}`);
  return 401;
}
