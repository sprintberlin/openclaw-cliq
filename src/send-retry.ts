/**
 * Outbound error classification + retry for Zoho Cliq API sends.
 *
 * The Cliq bot-message endpoint occasionally fails transiently (429 rate-limit,
 * 5xx) and permanently (401/403/404 = misconfigured auth / missing bot). A 400
 * whose body looks like a *content/format* rejection (rather than a structural
 * one) is treated as `format_rejected` so the caller can fall back from rich
 * (markdown-formatted) text to plain text and retry once.
 *
 * The retry loop honors `Retry-After` (seconds or HTTP-date) when present on a
 * 429/503, otherwise exponential backoff with jitter.
 *
 * Design goals:
 *  - Never swallow a fatal error — surface it with the response body.
 *  - Never retry a non-idempotent success.
 *  - Keep the surface small + pure so it is exhaustively unit-testable without
 *    touching the network.
 */

export type CliqSendErrorKind =
  | "transient"
  | "fatal"
  | "format_rejected";

export interface ClassifyInput {
  status: number;
  body: string;
  headers?: { get: (name: string) => string | null } | Headers | null;
}

export interface CliqSendErrorContext {
  status: number;
  body: string;
  retryAfterMs?: number;
}

export class CliqSendError extends Error {
  readonly kind: CliqSendErrorKind;
  readonly status: number;
  readonly body: string;
  readonly retryAfterMs?: number;

  constructor(
    kind: CliqSendErrorKind,
    status: number,
    body: string,
    retryAfterMs?: number,
  ) {
    const retryHint = retryAfterMs !== undefined ? ` (retry-after ${retryAfterMs}ms)` : "";
    super(`cliq: send failed [${kind}] status=${status}${retryHint}: ${body}`);
    this.name = "CliqSendError";
    this.kind = kind;
    this.status = status;
    this.body = body;
    this.retryAfterMs = retryAfterMs;
  }
}

/**
 * Patterns that indicate a Cliq 400 is a *content/format* rejection (so the
 * caller should retry with plain text) rather than a structural one (which we
 * cannot recover from by simplifying text). Cliq's error envelope is not
 * formally documented, so we match loosely on body text.
 */
const FORMAT_REJECT_PATTERNS: readonly RegExp[] = [
  /invalid\s+(message|text|format|content)/i,
  /not\s+allowed\s+(in\s+)?(message|text)/i,
  /unsupported\s+(markdown|format|character)/i,
  /bad\s+(request|format)/i,
  /format/i,
  /markdown/i,
  /character/i,
  /content\s+(is\s+)?(not|invalid|rejected)/i,
  /sanitiz/i,
];

/**
 * Patterns that indicate a 400 is structural (a payload we cannot fix by
 * flattening text). These take precedence over the format patterns.
 */
const STRUCTURAL_REJECT_PATTERNS: readonly RegExp[] = [
  /\b(bot|user|userid|userids|chatid|chat|channel)\b.*\bnot\s+(found|exist)/i,
  /invalid\s+(chatid|userid|userids|bot|channel)/i,
  /missing.*(field|param|parameter|chatid|userid|userids)/i,
  /\brequired\b.*\b(missing|not\s+provided)\b/i,
];

/**
 * Classify a Zoho Cliq send-API HTTP response into one of three error kinds.
 * Returns `null` for a successful (2xx) response — callers should not pass a
 * success status here.
 *
 * Mapping (matches the ROADMAP contract):
 *  - 2xx                       → null (no error)
 *  - 401 / 403 / 404           → "fatal"
 *  - 429 / 5xx                 → "transient"
 *  - 400 + structural pattern  → "fatal"
 *  - 400 + format pattern      → "format_rejected"
 *  - 400 (unmatched)           → "format_rejected" (conservative: try plain)
 *  - other 4xx                 → "fatal"
 */
export function classifyCliqSendResponse(input: ClassifyInput): CliqSendErrorKind | null {
  const { status, body } = input;
  if (status >= 200 && status < 300) return null;
  if (status === 401 || status === 403 || status === 404) return "fatal";
  if (status === 429 || (status >= 500 && status < 600)) return "transient";
  if (status === 400) {
    for (const re of STRUCTURAL_REJECT_PATTERNS) {
      if (re.test(body)) return "fatal";
    }
    for (const re of FORMAT_REJECT_PATTERNS) {
      if (re.test(body)) return "format_rejected";
    }
    // Unmatched 400 — try plain once before giving up.
    return "format_rejected";
  }
  return "fatal";
}

/**
 * Parse a `Retry-After` header value into milliseconds. Supports:
 *  - a non-negative integer number of seconds (the common case for Cliq),
 *  - an HTTP-date per RFC 7231 (best-effort; falls back to undefined).
 */
export function parseRetryAfterMs(
  raw: string | null | undefined,
  now: number = Date.now(),
): number | undefined {
  if (!raw) return undefined;
  const trimmed = raw.trim();
  if (!trimmed) return undefined;
  // Integer seconds (possibly with surrounding whitespace / leading +).
  if (/^[+]?(\d+)(\.\d+)?$/.test(trimmed)) {
    const seconds = Number(trimmed);
    if (!Number.isFinite(seconds) || seconds < 0) return undefined;
    return Math.min(Math.ceil(seconds * 1000), 60_000);
  }
  // HTTP-date.
  const t = Date.parse(trimmed);
  if (!Number.isNaN(t)) {
    const ms = t - now;
    return ms > 0 ? Math.min(ms, 60_000) : 0;
  }
  return undefined;
}

export interface RetryOptions {
  maxAttempts?: number;
  baseDelayMs?: number;
  maxDelayMs?: number;
  sleep?: (ms: number) => Promise<void>;
  /** Override jitter source for tests; returns a float in [0,1). */
  random?: () => number;
}

export const DEFAULT_RETRY: Required<RetryOptions> = {
  maxAttempts: 3,
  baseDelayMs: 500,
  maxDelayMs: 8_000,
  sleep: (ms) => new Promise<void>((resolve) => setTimeout(resolve, ms)),
  random: Math.random,
};

/** Compute the next backoff delay (in ms) for the given attempt index. */
export function computeBackoffMs(
  attempt: number, // 0-based attempt that just failed
  opts: Required<RetryOptions>,
  retryAfterMs?: number,
): number {
  // Honor the server's `Retry-After` directive verbatim — it already came
  // through `parseRetryAfterMs`, which caps at 60s. Do NOT further cap it at
  // `maxDelayMs` (that only governs the exponential backoff path); if the
  // server says wait 30s, we wait 30s even when our jitter cap is lower.
  if (retryAfterMs !== undefined) return Math.max(0, retryAfterMs);
  const exp = opts.baseDelayMs * Math.pow(2, attempt);
  const capped = Math.min(exp, opts.maxDelayMs);
  // Full jitter.
  const jitter = opts.random();
  return Math.max(0, Math.floor(capped * jitter));
}

/**
 * Run an idempotent send through the retry loop.
 *
 * `attempt` returns the parsed HTTP response (status + body + headers) of a
 * single send. The loop classifies it:
 *  - `null` (success) → return immediately.
 *  - `fatal` → throw `CliqSendError` immediately (no retry).
 *  - `format_rejected` → throw `CliqSendError` immediately so the caller can
 *    fall back to plain text (it is NOT retried here).
 *  - `transient` → sleep per backoff, then retry, up to `maxAttempts` total.
 *
 * @throws CliqSendError on any non-success outcome.
 */
export async function withSendRetry(
  attempt: () => Promise<{ status: number; body: string; headers?: { get: (name: string) => string | null } | Headers | null }>,
  opts: RetryOptions = {},
): Promise<{ status: number; body: string }> {
  const o: Required<RetryOptions> = { ...DEFAULT_RETRY, ...opts };
  let lastError: CliqSendError | null = null;
  for (let i = 0; i < o.maxAttempts; i++) {
    const res = await attempt();
    const kind = classifyCliqSendResponse(res);
    if (kind === null) {
      return { status: res.status, body: res.body };
    }
    const headers = res.headers;
    const retryAfterRaw =
      headers instanceof Headers
        ? headers.get("retry-after")
        : headers?.get?.("retry-after") ?? null;
    const retryAfterMs = parseRetryAfterMs(retryAfterRaw);
    lastError = new CliqSendError(kind, res.status, res.body, retryAfterMs);
    if (kind !== "transient") {
      throw lastError;
    }
    if (i < o.maxAttempts - 1) {
      const delay = computeBackoffMs(i, o, retryAfterMs);
      if (delay > 0) await o.sleep(delay);
    }
  }
  throw lastError ?? new CliqSendError("transient", 0, "exhausted retries");
}
