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

import { appendCliqDataCenterHint } from "./region.js";
import { parseCliqErrorBody } from "./cliq-error.js";

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
  /**
   * The human-readable message extracted from the response body: the
   * `message` field of a v3 `{"message":"…"}` envelope, or the raw body for
   * v2 / non-JSON responses. Exposed so callers / logs can surface the Cliq
   * error text without re-parsing the raw body.
   */
  readonly errorMessage: string;
  readonly retryAfterMs?: number;

  constructor(
    kind: CliqSendErrorKind,
    status: number,
    body: string,
    retryAfterMs?: number,
  ) {
    const retryHint = retryAfterMs !== undefined ? ` (retry-after ${retryAfterMs}ms)` : "";
    // Append the data-center hint to fatal auth failures (401/403/4xx auth
    // errors) so a non-EU account hitting the EU endpoints surfaces a
    // pointer to the most likely cause alongside the opaque Zoho body.
    const dcHint = kind === "fatal" ? appendCliqDataCenterHint(body) : "";
    super(`cliq: send failed [${kind}] status=${status}${retryHint}: ${body}${dcHint}`);
    this.name = "CliqSendError";
    this.kind = kind;
    this.status = status;
    this.body = body;
    this.errorMessage = parseCliqErrorBody(body).message;
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
    // v3 wraps the error text in a `{"message":"…"}` envelope; match the
    // structural / format patterns against BOTH the raw body and the
    // extracted message so a v3 400 like `{"message":"invalid userids"}`
    // is classified as fatal (structural) rather than falling through to
    // format_rejected.
    const parsed = parseCliqErrorBody(body);
    const haystacks = parsed.isV3Envelope ? [parsed.message, body] : [body];
    for (const re of STRUCTURAL_REJECT_PATTERNS) {
      if (haystacks.some((h) => re.test(h))) return "fatal";
    }
    for (const re of FORMAT_REJECT_PATTERNS) {
      if (haystacks.some((h) => re.test(h))) return "format_rejected";
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

export interface SendRetryOptions extends RetryOptions {
  network?: SendRetryNetworkOptions;
}

export type RetryBackoffOptions = Required<RetryOptions>;

export const DEFAULT_RETRY: RetryBackoffOptions = {
  maxAttempts: 3,
  baseDelayMs: 500,
  maxDelayMs: 8_000,
  sleep: (ms) => new Promise<void>((resolve) => setTimeout(resolve, ms)),
  random: Math.random,
};

/** Compute the next backoff delay (in ms) for the given attempt index. */
export function computeBackoffMs(
  attempt: number, // 0-based attempt that just failed
  opts: RetryBackoffOptions,
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

export type SendRetryOperation = "send" | "edit" | "oauth";

export type SendRetryOutcome = "retry" | "exhausted" | "not_retryable";

export interface SendRetryAttemptEvent {
  operation: SendRetryOperation;
  attempt: number;
  maxAttempts: number;
  outcome: SendRetryOutcome;
  errorName?: string;
  causeCode?: string;
  causeSyscall?: string;
  unrecognizedCause?: boolean;
  delayMs?: number;
  ambiguousDelivery: boolean;
  duplicateRisk: boolean;
}

export interface SendRetryNetworkOptions {
  operation: SendRetryOperation;
  idempotent?: boolean;
  maxAttempts?: number;
  beforeAttempt?: () => void;
  onAttempt?: (event: SendRetryAttemptEvent) => void;
}

export interface TransportErrorInfo {
  retryable: boolean;
  mayHaveReached: boolean;
  errorName?: string;
  code?: string;
  syscall?: string;
  unrecognizedCause?: boolean;
}

export const MAX_NON_IDEMPOTENT_NETWORK_ATTEMPTS = 2;
export const MAX_IDEMPOTENT_NETWORK_ATTEMPTS = 3;

const SAFE_CODE = /^[A-Z][A-Z0-9_]{1,63}$/;
const SAFE_ERROR_NAMES = new Set(["Error", "TypeError", "AggregateError", "SocketError", "ConnectTimeoutError", "HeadersTimeoutError", "BodyTimeoutError"]);
const SAFE_SYSCALLS = new Set(["connect", "read", "write", "getaddrinfo", "getnameinfo", "lookup", "recv", "send", "socket"]);
const MAX_ERROR_CHAIN_NODES = 8;
const MAX_AGGREGATE_MEMBERS = 4;

const TRANSIENT_NETWORK_CODES: ReadonlySet<string> = new Set([
  "ECONNRESET",
  "ETIMEDOUT",
  "ECONNABORTED",
  "ECONNREFUSED",
  "EPIPE",
  "EAI_AGAIN",
  "EADDRNOTAVAIL",
  "EINTR",
  "ENOBUFS",
  "ENETRESET",
  "ENETUNREACH",
  "ENETDOWN",
  "EHOSTUNREACH",
  "UND_ERR_SOCKET",
  "UND_ERR_CLOSED",
  "UND_ERR_CONNECT_TIMEOUT",
  "UND_ERR_HEADERS_TIMEOUT",
  "UND_ERR_BODY_TIMEOUT",
]);

const PERMANENT_NETWORK_CODES: ReadonlySet<string> = new Set([
  "ENOTFOUND",
  "ERR_INVALID_URL",
  "HOSTNAME_MISMATCH",
  "UNABLE_TO_VERIFY_LEAF_SIGNATURE",
  "UNABLE_TO_GET_ISSUER_CERT",
  "UNABLE_TO_GET_ISSUER_CERT_LOCALLY",
  "DEPTH_ZERO_SELF_SIGNED_CERT",
  "SELF_SIGNED_CERT_IN_CHAIN",
]);

const PERMANENT_TLS_CODE_PREFIX = /^(CERT_|ERR_TLS_|ERR_SSL_|ERR_OSSL_)/;

function isPermanentNetworkCode(code: string): boolean {
  return PERMANENT_NETWORK_CODES.has(code) || PERMANENT_TLS_CODE_PREFIX.test(code);
}

function collectErrorChain(err: unknown): object[] {
  const out: object[] = [];
  const seen = new Set<object>();
  const queue: unknown[] = [err];
  while (queue.length > 0 && out.length < MAX_ERROR_CHAIN_NODES) {
    const current = queue.shift();
    if (current === null || typeof current !== "object" || seen.has(current)) continue;
    seen.add(current);
    out.push(current);
    const node = current as { cause?: unknown; errors?: unknown };
    if (node.cause !== undefined) queue.push(node.cause);
    if (Array.isArray(node.errors)) queue.push(...node.errors.slice(0, MAX_AGGREGATE_MEMBERS));
  }
  return out;
}

export function describeTransportError(err: unknown): TransportErrorInfo | null {
  try {
    const chain = collectErrorChain(err);
    const root = chain[0] as { name?: unknown; message?: unknown } | undefined;
    if (!root) return null;
    const errorName =
      typeof root.name === "string" && SAFE_ERROR_NAMES.has(root.name) ? root.name : undefined;
    const isFetchFailed = err instanceof TypeError && root.message === "fetch failed";
    let transientCode: string | undefined;
    let transientSyscall: string | undefined;
    let permanentCode: string | undefined;
    let permanentSyscall: string | undefined;
    let unknownCode: string | undefined;
    let unknownSyscall: string | undefined;
    let hasUnknownCode = false;
    let aborted = false;
    for (const node of chain) {
      const { name, code, syscall } = node as { name?: unknown; code?: unknown; syscall?: unknown };
      if (name === "AbortError" || code === "ABORT_ERR") aborted = true;
      if (typeof code !== "string" || !SAFE_CODE.test(code)) continue;
      const safeSyscall =
        typeof syscall === "string" && SAFE_SYSCALLS.has(syscall) ? syscall : undefined;
      if (isPermanentNetworkCode(code)) {
        permanentCode ??= code;
        permanentSyscall ??= safeSyscall;
      } else if (TRANSIENT_NETWORK_CODES.has(code)) {
        transientCode ??= code;
        transientSyscall ??= safeSyscall;
      } else {
        hasUnknownCode = true;
        unknownCode ??= code;
        unknownSyscall ??= safeSyscall;
      }
    }
    if (aborted) return null;
    if (permanentCode) {
      return {
        retryable: false,
        mayHaveReached: true,
        ...(errorName ? { errorName } : {}),
        code: permanentCode,
        ...(permanentSyscall ? { syscall: permanentSyscall } : {}),
      };
    }
    if (transientCode && !hasUnknownCode) {
      return {
        retryable: true,
        mayHaveReached: true,
        ...(errorName ? { errorName } : {}),
        code: transientCode,
        ...(transientSyscall ? { syscall: transientSyscall } : {}),
      };
    }
    if (isFetchFailed && hasUnknownCode) {
      return {
        retryable: false,
        mayHaveReached: true,
        unrecognizedCause: true,
        ...(errorName ? { errorName } : {}),
        ...(unknownCode ? { code: unknownCode } : {}),
        ...(unknownSyscall ? { syscall: unknownSyscall } : {}),
      };
    }
    if (isFetchFailed) {
      return {
        retryable: true,
        mayHaveReached: true,
        ...(errorName ? { errorName } : {}),
      };
    }
    return null;
  } catch {
    return null;
  }
}

function describeUnknownError(err: unknown): TransportErrorInfo {
  let errorName: string | undefined;
  try {
    const name = (err as { name?: unknown } | null)?.name;
    if (typeof name === "string" && SAFE_ERROR_NAMES.has(name)) errorName = name;
  } catch {
    errorName = undefined;
  }
  return {
    retryable: false,
    mayHaveReached: true,
    unrecognizedCause: true,
    ...(errorName ? { errorName } : {}),
  };
}

function normalizeMaxAttempts(requested: number | undefined, fallback = DEFAULT_RETRY.maxAttempts): number {
  if (requested === undefined || !Number.isFinite(requested)) return fallback;
  return Math.max(1, Math.floor(requested));
}

function networkAttemptCap(network: SendRetryNetworkOptions): number {
  const hardCap = network.idempotent === true
    ? MAX_IDEMPOTENT_NETWORK_ATTEMPTS
    : MAX_NON_IDEMPOTENT_NETWORK_ATTEMPTS;
  const requested = network.maxAttempts;
  return requested !== undefined && Number.isFinite(requested)
    ? Math.max(1, Math.min(Math.floor(requested), hardCap))
    : hardCap;
}

function emitTransportAttempt(
  network: SendRetryNetworkOptions,
  attempt: number,
  maxAttempts: number,
  outcome: SendRetryOutcome,
  info: TransportErrorInfo,
  delayMs?: number,
): void {
  if (!network.onAttempt) return;
  const event: SendRetryAttemptEvent = {
    operation: network.operation,
    attempt,
    maxAttempts,
    outcome,
    ...(info.errorName ? { errorName: info.errorName } : {}),
    ...(info.code ? { causeCode: info.code } : {}),
    ...(info.syscall ? { causeSyscall: info.syscall } : {}),
    ...(info.unrecognizedCause === true ? { unrecognizedCause: true } : {}),
    ...(delayMs !== undefined && delayMs > 0 ? { delayMs } : {}),
    ambiguousDelivery: info.mayHaveReached,
    duplicateRisk: info.mayHaveReached && network.idempotent !== true,
  };
  try {
    network.onAttempt(event);
  } catch {
    return;
  }
}

type SendAttemptResult = {
  status: number;
  body: string;
  headers?: { get: (name: string) => string | null } | Headers | null;
};

function planTransportRetry(
  err: unknown,
  network: SendRetryNetworkOptions,
  physical: number,
  limit: number,
  o: RetryBackoffOptions,
): number | null {
  const info = describeTransportError(err) ?? describeUnknownError(err);
  if (!info.retryable) {
    emitTransportAttempt(network, physical, limit, "not_retryable", info);
    return null;
  }
  if (physical >= limit) {
    emitTransportAttempt(network, physical, limit, "exhausted", info);
    return null;
  }
  const delay = computeBackoffMs(physical - 1, o);
  emitTransportAttempt(network, physical, limit, "retry", info, delay);
  return delay;
}

async function runWithRetry<T>(
  attempt: () => Promise<T>,
  opts: SendRetryOptions,
  classify?: (result: T) => CliqSendError | null,
): Promise<T> {
  const o: RetryBackoffOptions = {
    maxAttempts: normalizeMaxAttempts(opts.maxAttempts),
    baseDelayMs: opts.baseDelayMs ?? DEFAULT_RETRY.baseDelayMs,
    maxDelayMs: opts.maxDelayMs ?? DEFAULT_RETRY.maxDelayMs,
    sleep: opts.sleep ?? DEFAULT_RETRY.sleep,
    random: opts.random ?? DEFAULT_RETRY.random,
  };
  const network = opts.network;
  let limit = o.maxAttempts;
  let physical = 0;
  for (;;) {
    network?.beforeAttempt?.();
    physical++;
    let result: T;
    try {
      result = await attempt();
    } catch (err) {
      if (!network) throw err;
      limit = Math.min(limit, networkAttemptCap(network));
      const delay = planTransportRetry(err, network, physical, limit, o);
      if (delay === null) throw err;
      if (delay > 0) await o.sleep(delay);
      continue;
    }
    const error = classify?.(result);
    if (!error) return result;
    if (error.kind !== "transient" || physical >= limit) throw error;
    const delay = computeBackoffMs(physical - 1, o, error.retryAfterMs);
    if (delay > 0) await o.sleep(delay);
  }
}

export async function withTransportRetry<T>(
  attempt: () => Promise<T>,
  opts: SendRetryOptions,
): Promise<T> {
  return runWithRetry(attempt, opts);
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
  attempt: () => Promise<SendAttemptResult>,
  opts: SendRetryOptions = {},
): Promise<{ status: number; body: string }> {
  const result = await runWithRetry(attempt, opts, (res) => {
    const kind = classifyCliqSendResponse(res);
    if (kind === null) return null;
    const headers = res.headers;
    const retryAfterRaw =
      headers instanceof Headers
        ? headers.get("retry-after")
        : headers?.get?.("retry-after") ?? null;
    return new CliqSendError(kind, res.status, res.body, parseRetryAfterMs(retryAfterRaw));
  });
  return { status: result.status, body: result.body };
}
