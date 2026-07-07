import { describe, it, expect } from "vitest";
import {
  CliqSendError,
  classifyCliqSendResponse,
  computeBackoffMs,
  parseRetryAfterMs,
  withSendRetry,
  type RetryOptions,
} from "./send-retry.js";

const baseOpts: Required<RetryOptions> = {
  maxAttempts: 3,
  baseDelayMs: 500,
  maxDelayMs: 8_000,
  sleep: async () => {},
  random: () => 0.5,
};

describe("classifyCliqSendResponse", () => {
  it("returns null for any 2xx success", () => {
    expect(classifyCliqSendResponse({ status: 200, body: "" })).toBeNull();
    expect(classifyCliqSendResponse({ status: 204, body: "" })).toBeNull();
  });

  it("classifies 401/403/404 as fatal", () => {
    expect(classifyCliqSendResponse({ status: 401, body: "no token" })).toBe("fatal");
    expect(classifyCliqSendResponse({ status: 403, body: "forbidden" })).toBe("fatal");
    expect(classifyCliqSendResponse({ status: 404, body: "no bot" })).toBe("fatal");
  });

  it("classifies 429 and 5xx as transient", () => {
    expect(classifyCliqSendResponse({ status: 429, body: "slow down" })).toBe("transient");
    expect(classifyCliqSendResponse({ status: 500, body: "boom" })).toBe("transient");
    expect(classifyCliqSendResponse({ status: 502, body: "boom" })).toBe("transient");
    expect(classifyCliqSendResponse({ status: 503, body: "boom" })).toBe("transient");
  });

  it("classifies format-looking 400s as format_rejected", () => {
    expect(classifyCliqSendResponse({ status: 400, body: "invalid markdown syntax" })).toBe("format_rejected");
    expect(classifyCliqSendResponse({ status: 400, body: "Bad Request: unsupported format" })).toBe("format_rejected");
    expect(classifyCliqSendResponse({ status: 400, body: "character not allowed in message" })).toBe("format_rejected");
  });

  it("treats structural-looking 400s as fatal", () => {
    expect(classifyCliqSendResponse({ status: 400, body: "chatid not found" })).toBe("fatal");
    expect(classifyCliqSendResponse({ status: 400, body: "invalid userids" })).toBe("fatal");
    expect(classifyCliqSendResponse({ status: 400, body: "missing required field text" })).toBe("fatal");
  });

  it("classifies v3-envelope 400s by the extracted message (issue #67)", () => {
    // v3 wraps the error text in `{"message":"…"}`. The structural pattern
    // must match the extracted message, not require the raw JSON to contain
    // the substring outside the envelope.
    expect(
      classifyCliqSendResponse({
        status: 400,
        body: JSON.stringify({ message: "invalid userids" }),
      }),
    ).toBe("fatal");
    expect(
      classifyCliqSendResponse({
        status: 400,
        body: JSON.stringify({ message: "chatid not found" }),
      }),
    ).toBe("fatal");
    expect(
      classifyCliqSendResponse({
        status: 400,
        body: JSON.stringify({ message: "unsupported markdown character" }),
      }),
    ).toBe("format_rejected");
    expect(
      classifyCliqSendResponse({
        status: 400,
        body: JSON.stringify({ message: "Bad Request: invalid format" }),
      }),
    ).toBe("format_rejected");
  });

  it("falls back to format_rejected for unmatched 400 (conservative: try plain)", () => {
    expect(classifyCliqSendResponse({ status: 400, body: "something weird" })).toBe("format_rejected");
  });

  it("classifies other 4xx as fatal", () => {
    expect(classifyCliqSendResponse({ status: 409, body: "conflict" })).toBe("fatal");
    expect(classifyCliqSendResponse({ status: 418, body: "teapot" })).toBe("fatal");
  });
});

describe("parseRetryAfterMs", () => {
  it("parses integer seconds to ms", () => {
    expect(parseRetryAfterMs("0")).toBe(0);
    expect(parseRetryAfterMs("5")).toBe(5_000);
    expect(parseRetryAfterMs("12")).toBe(12_000);
  });

  it("parses fractional seconds", () => {
    expect(parseRetryAfterMs("0.5")).toBe(500);
  });

  it("caps at 60 seconds", () => {
    expect(parseRetryAfterMs("120")).toBe(60_000);
  });

  it("returns undefined for garbage", () => {
    expect(parseRetryAfterMs(null)).toBeUndefined();
    expect(parseRetryAfterMs("")).toBeUndefined();
    expect(parseRetryAfterMs("not a date or number")).toBeUndefined();
  });

  it("parses an HTTP-date", () => {
    const now = Date.parse("2026-07-05T12:00:00Z");
    const future = new Date(now + 3_000).toUTCString();
    expect(parseRetryAfterMs(future, now)).toBe(3_000);
  });

  it("returns 0 for an HTTP-date in the past", () => {
    const now = Date.parse("2026-07-05T12:00:00Z");
    const past = new Date(now - 3_000).toUTCString();
    expect(parseRetryAfterMs(past, now)).toBe(0);
  });
});

describe("computeBackoffMs", () => {
  const opts = baseOpts;

  it("uses retry-after when provided (uncapped beyond maxDelayMs)", () => {
    expect(computeBackoffMs(0, opts, 200)).toBe(200);
    expect(computeBackoffMs(0, opts, 60_000)).toBe(60_000);
    // retry-after is honored verbatim even when it exceeds maxDelayMs (which
    // only governs the exponential backoff path). parseRetryAfterMs caps at 60s.
    expect(computeBackoffMs(0, opts, 100_000)).toBe(100_000);
  });

  it("applies full jitter to exponential backoff", () => {
    // attempt 0: 500 * 2^0 = 500; jitter 0.5 → 250
    expect(computeBackoffMs(0, opts)).toBe(250);
    // attempt 1: 500 * 2^1 = 1000; jitter 0.5 → 500
    expect(computeBackoffMs(1, opts)).toBe(500);
    // attempt 2: 500 * 2^2 = 2000; jitter 0.5 → 1000
    expect(computeBackoffMs(2, opts)).toBe(1000);
  });

  it("caps exponential growth at maxDelayMs", () => {
    expect(computeBackoffMs(10, opts)).toBeLessThanOrEqual(8_000);
  });

  it("returns 0 when random is 0", () => {
    const o = { ...opts, random: () => 0 };
    expect(computeBackoffMs(2, o)).toBe(0);
  });
});

describe("withSendRetry", () => {
  it("returns immediately on success", async () => {
    const calls: number[] = [];
    const result = await withSendRetry(
      async () => {
        calls.push(1);
        return { status: 200, body: '{"id":"m1"}' };
      },
      baseOpts,
    );
    expect(calls).toHaveLength(1);
    expect(result).toEqual({ status: 200, body: '{"id":"m1"}' });
  });

  it("retries transient (5xx) up to success", async () => {
    const sleeps: number[] = [];
    const o: Required<RetryOptions> = { ...baseOpts, sleep: async (ms) => { sleeps.push(ms); } };
    const statuses = [502, 429, 200];
    let i = 0;
    const result = await withSendRetry(
      async () => ({ status: statuses[i++], body: "" }),
      o,
    );
    expect(result.status).toBe(200);
    expect(i).toBe(3);
    expect(sleeps).toHaveLength(2);
    expect(sleeps.every((s) => s >= 0)).toBe(true);
  });

  it("throws CliqSendError(transient) after exhausting retries", async () => {
    const o: Required<RetryOptions> = { ...baseOpts, sleep: async () => {} };
    let i = 0;
    await expect(
      withSendRetry(async () => ({ status: 500, body: `b${i++}` }), o),
    ).rejects.toMatchObject({ name: "CliqSendError", kind: "transient", status: 500 });
    expect(i).toBe(3);
  });

  it("throws immediately on fatal (no retries)", async () => {
    const o: Required<RetryOptions> = { ...baseOpts, sleep: async () => { throw new Error("should not sleep"); } };
    let i = 0;
    await expect(
      withSendRetry(async () => ({ status: 404, body: `b${i++}` }), o),
    ).rejects.toMatchObject({ kind: "fatal", status: 404 });
    expect(i).toBe(1);
  });

  it("throws immediately on format_rejected (caller falls back)", async () => {
    let i = 0;
    await expect(
      withSendRetry(async () => ({ status: 400, body: `bad markdown ${i++}` }), baseOpts),
    ).rejects.toMatchObject({ kind: "format_rejected", status: 400 });
    expect(i).toBe(1);
  });

  it("honors Retry-After on 429", async () => {
    const sleeps: number[] = [];
    const o: Required<RetryOptions> = { ...baseOpts, sleep: async (ms) => { sleeps.push(ms); } };
    const headers = new Headers({ "retry-after": "2" });
    const statuses = [429, 200];
    let i = 0;
    await withSendRetry(
      async () => ({ status: statuses[i++], body: "", headers }),
      o,
    );
    expect(sleeps).toEqual([2_000]);
  });

  it("does not sleep between the last failure and throwing", async () => {
    const sleeps: number[] = [];
    const o: Required<RetryOptions> = { ...baseOpts, maxAttempts: 2, sleep: async (ms) => { sleeps.push(ms); } };
    await expect(
      withSendRetry(async () => ({ status: 500, body: "" }), o),
    ).rejects.toBeInstanceOf(CliqSendError);
    // Only one sleep between attempt 0 and attempt 1; no sleep after the final failure.
    expect(sleeps).toHaveLength(1);
  });
});

describe("CliqSendError", () => {
  it("carries kind, status, body, retryAfterMs", () => {
    const err = new CliqSendError("transient", 429, "slow down", 5_000);
    expect(err.kind).toBe("transient");
    expect(err.status).toBe(429);
    expect(err.body).toBe("slow down");
    expect(err.retryAfterMs).toBe(5_000);
    expect(err.message).toContain("429");
    expect(err.message).toContain("slow down");
    expect(err.message).toContain("5000ms");
  });

  it("appends the data-center hint to a fatal auth-failure body (issue #46)", () => {
    const err = new CliqSendError(
      "fatal",
      401,
      '{"error":"invalid_client"}',
    );
    expect(err.message).toContain("verify your Zoho data center");
  });

  it("appends the data-center hint to a v3-envelope auth failure (issue #67)", () => {
    // v3 401: `{"message":"Request was rejected because of invalid AuthToken."}`
    // — the v2 patterns (`invalid_token`, `unauthorized`) would NOT match the
    // raw body; the v3 envelope parser + the `invalid\s+authtoken` pattern
    // make the hint fire.
    const err = new CliqSendError(
      "fatal",
      401,
      JSON.stringify({ message: "Request was rejected because of invalid AuthToken." }),
    );
    expect(err.message).toContain("verify your Zoho data center");
    expect(err.errorMessage).toBe(
      "Request was rejected because of invalid AuthToken.",
    );
  });

  it("appends the data-center hint to a v3 403 not-enough-permission body (issue #67)", () => {
    const err = new CliqSendError(
      "fatal",
      403,
      JSON.stringify({
        message:
          "The user does not have enough permission to access the resource.",
      }),
    );
    expect(err.message).toContain("verify your Zoho data center");
  });

  it("exposes errorMessage as the raw body for a v2 opaque string", () => {
    const err = new CliqSendError("fatal", 401, "invalid_client");
    expect(err.errorMessage).toBe("invalid_client");
  });

  it("appends the data-center hint for oauthtoken_scope_invalid", () => {
    const err = new CliqSendError(
      "fatal",
      403,
      '{"code":"oauthtoken_scope_invalid"}',
    );
    expect(err.message).toContain("verify your Zoho data center");
  });

  it("does not append the hint to a transient / format_rejected error", () => {
    const transient = new CliqSendError("transient", 429, "slow down");
    expect(transient.message).not.toContain("verify your Zoho data center");
    const fmt = new CliqSendError(
      "format_rejected",
      400,
      '{"error":"invalid_client"}',
    );
    // Only fatal errors carry the DC hint — format_rejected is recoverable
    // by retrying plain text, so we don't muddy it with a DC pointer.
    expect(fmt.message).not.toContain("verify your Zoho data center");
  });

  it("does not append the hint to a fatal non-auth body", () => {
    const err = new CliqSendError("fatal", 404, '{"error":"bot not found"}');
    expect(err.message).not.toContain("verify your Zoho data center");
  });
});

