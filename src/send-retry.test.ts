import { describe, it, expect } from "vitest";
import {
  CliqSendError,
  classifyCliqSendResponse,
  computeBackoffMs,
  describeTransportError,
  parseRetryAfterMs,
  withSendRetry,
  withTransportRetry,
  type RetryBackoffOptions,
  type SendRetryAttemptEvent,
  type SendRetryOptions,
} from "./send-retry.js";

const baseOpts: RetryBackoffOptions = {
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
    const o: RetryBackoffOptions = { ...baseOpts, sleep: async (ms) => { sleeps.push(ms); } };
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
    const o: RetryBackoffOptions = { ...baseOpts, sleep: async () => {} };
    let i = 0;
    await expect(
      withSendRetry(async () => ({ status: 500, body: `b${i++}` }), o),
    ).rejects.toMatchObject({ name: "CliqSendError", kind: "transient", status: 500 });
    expect(i).toBe(3);
  });

  it("throws immediately on fatal (no retries)", async () => {
    const o: RetryBackoffOptions = { ...baseOpts, sleep: async () => { throw new Error("should not sleep"); } };
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
    const o: RetryBackoffOptions = { ...baseOpts, sleep: async (ms) => { sleeps.push(ms); } };
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
    const o: RetryBackoffOptions = { ...baseOpts, maxAttempts: 2, sleep: async (ms) => { sleeps.push(ms); } };
    await expect(
      withSendRetry(async () => ({ status: 500, body: "" }), o),
    ).rejects.toBeInstanceOf(CliqSendError);
    // Only one sleep between attempt 0 and attempt 1; no sleep after the final failure.
    expect(sleeps).toHaveLength(1);
  });

  it("does not retry a thrown transport failure unless network retry is opted in", async () => {
    let i = 0;
    await expect(
      withSendRetry(async () => {
        i++;
        throw Object.assign(new TypeError("fetch failed"), { cause: { code: "ECONNRESET", syscall: "read" } });
      }, baseOpts),
    ).rejects.toThrow("fetch failed");
    expect(i).toBe(1);
  });
});

function fetchFailed(code: string, syscall?: string): Error {
  return Object.assign(new TypeError("fetch failed"), {
    cause: { code, ...(syscall ? { syscall } : {}) },
  });
}

describe("describeTransportError", () => {
  it("recognizes a Node TypeError fetch failed with a nested transient cause", () => {
    expect(describeTransportError(fetchFailed("ECONNRESET", "read"))).toEqual({
      retryable: true,
      mayHaveReached: true,
      errorName: "TypeError",
      code: "ECONNRESET",
      syscall: "read",
    });
    expect(describeTransportError(fetchFailed("ETIMEDOUT", "connect"))).toMatchObject({
      retryable: true,
      code: "ETIMEDOUT",
      syscall: "connect",
    });
  });

  it("walks an undici aggregate cause chain to the transient code", () => {
    const inner = Object.assign(new Error("socket closed"), { code: "ECONNRESET", syscall: "read" });
    const aggregate = new AggregateError([inner], "socket failure");
    const outer = Object.assign(new TypeError("fetch failed"), { cause: aggregate });
    expect(describeTransportError(outer)).toMatchObject({
      retryable: true,
      code: "ECONNRESET",
      syscall: "read",
    });
  });

  it("treats a bare TypeError fetch failed (no cause) as retryable and ambiguous", () => {
    expect(describeTransportError(new TypeError("fetch failed"))).toEqual({
      retryable: true,
      mayHaveReached: true,
      errorName: "TypeError",
    });
  });

  it("does not retry a permanent TLS or config failure", () => {
    expect(describeTransportError(fetchFailed("UNABLE_TO_VERIFY_LEAF_SIGNATURE"))).toMatchObject({
      retryable: false,
    });
    expect(describeTransportError(fetchFailed("CERT_HAS_EXPIRED"))).toMatchObject({ retryable: false });
    expect(describeTransportError(fetchFailed("ENOTFOUND", "getaddrinfo"))).toMatchObject({
      retryable: false,
      code: "ENOTFOUND",
    });
  });

  it("keeps only syntax-validated, allowlisted fields in the info object", () => {
    const url = "https://accounts.zoho.eu/oauth?token=secret";
    const info = describeTransportError(
      fetchFailed(`ECONNRESET url=${url}`, "read; rm -rf"),
    );
    expect(info).toEqual({
      retryable: true,
      mayHaveReached: true,
      errorName: "TypeError",
    });
    expect(JSON.stringify(info)).not.toContain("zoho");
    expect(JSON.stringify(info)).not.toContain("secret");
  });

  it("flags an unrecognized fetch failed cause as non-retryable but diagnosable", () => {
    expect(describeTransportError(fetchFailed("ERR_SOMETHING_NEW", "connect"))).toEqual({
      retryable: false,
      mayHaveReached: true,
      unrecognizedCause: true,
      errorName: "TypeError",
      code: "ERR_SOMETHING_NEW",
      syscall: "connect",
    });
  });

  it("returns null for arbitrary exceptions and aborts", () => {
    expect(describeTransportError(new Error("boom"))).toBeNull();
    expect(describeTransportError(Object.assign(new Error("aborted"), { name: "AbortError" }))).toBeNull();
    expect(describeTransportError("not an error")).toBeNull();
  });
});

describe("withSendRetry network transport retry", () => {
  const networkOpts = (onAttempt: (event: SendRetryAttemptEvent) => void): SendRetryOptions => ({
    ...baseOpts,
    network: { operation: "send", onAttempt },
  });

  it("recovers a transient fetch failure with bounded backoff", async () => {
    const sleeps: number[] = [];
    const events: SendRetryAttemptEvent[] = [];
    let i = 0;
    const result = await withSendRetry(async () => {
      if (i++ === 0) throw fetchFailed("ECONNRESET", "read");
      return { status: 200, body: '{"id":"m1"}' };
    }, { ...networkOpts((event) => events.push(event)), sleep: async (ms) => { sleeps.push(ms); } });
    expect(result.status).toBe(200);
    expect(i).toBe(2);
    expect(sleeps).toEqual([250]);
    expect(events).toEqual([
      {
        operation: "send",
        attempt: 1,
        maxAttempts: 2,
        outcome: "retry",
        errorName: "TypeError",
        causeCode: "ECONNRESET",
        causeSyscall: "read",
        delayMs: 250,
        ambiguousDelivery: true,
        duplicateRisk: true,
      },
    ]);
  });

  it("exhausts a non-idempotent send and preserves the original cause", async () => {
    const events: SendRetryAttemptEvent[] = [];
    const sleeps: number[] = [];
    let i = 0;
    const caught = await withSendRetry(async () => {
      i++;
      throw fetchFailed("ETIMEDOUT", "connect");
    }, { ...networkOpts((event) => events.push(event)), sleep: async (ms) => { sleeps.push(ms); } }).catch(
      (err: unknown) => err,
    );
    expect(i).toBe(2);
    expect(sleeps).toHaveLength(1);
    expect(caught).toBeInstanceOf(TypeError);
    const err = caught as TypeError & { cause?: { code?: string } };
    expect(err.message).toBe("fetch failed");
    expect(err.cause?.code).toBe("ETIMEDOUT");
    expect(events.map((event) => event.outcome)).toEqual(["retry", "exhausted"]);
    expect(events.at(-1)).toMatchObject({
      attempt: 2,
      maxAttempts: 2,
      causeCode: "ETIMEDOUT",
      duplicateRisk: true,
    });
  });

  it("caps an idempotent edit at its own bound and records no duplicate risk", async () => {
    const events: SendRetryAttemptEvent[] = [];
    let i = 0;
    await expect(
      withSendRetry(async () => {
        i++;
        throw fetchFailed("ECONNRESET", "write");
      }, {
        ...baseOpts,
        maxAttempts: 9,
        network: { operation: "edit", idempotent: true, maxAttempts: 2, onAttempt: (event) => events.push(event) },
      }),
    ).rejects.toThrow("fetch failed");
    expect(i).toBe(2);
    expect(events.map((event) => event.outcome)).toEqual(["retry", "exhausted"]);
    expect(events.every((event) => event.operation === "edit" && event.duplicateRisk === false)).toBe(true);
    expect(events[0]).toMatchObject({ maxAttempts: 2, ambiguousDelivery: true });
  });

  it("does not retry a fatal HTTP response even with network retry enabled", async () => {
    const events: SendRetryAttemptEvent[] = [];
    let i = 0;
    await expect(
      withSendRetry(async () => {
        i++;
        return { status: 401, body: "no token" };
      }, networkOpts((event) => events.push(event))),
    ).rejects.toMatchObject({ kind: "fatal", status: 401 });
    expect(i).toBe(1);
    expect(events).toHaveLength(0);
  });

  it("does not retry a permanent TLS failure or an arbitrary exception", async () => {
    const events: SendRetryAttemptEvent[] = [];
    let tls = 0;
    await expect(
      withSendRetry(async () => {
        tls++;
        throw fetchFailed("CERT_HAS_EXPIRED");
      }, networkOpts((event) => events.push(event))),
    ).rejects.toThrow("fetch failed");
    expect(tls).toBe(1);
    expect(events).toEqual([
      {
        operation: "send",
        attempt: 1,
        maxAttempts: 2,
        outcome: "not_retryable",
        errorName: "TypeError",
        causeCode: "CERT_HAS_EXPIRED",
        ambiguousDelivery: true,
        duplicateRisk: true,
      },
    ]);

    let other = 0;
    await expect(
      withSendRetry(async () => {
        other++;
        throw new Error("programmer error https://cliq.zoho.eu token=abc");
      }, networkOpts(() => {})),
    ).rejects.toThrow("programmer error");
    expect(other).toBe(1);
  });

  it("leaves an HTTP-only budget alone when no transport error occurs", async () => {
    let i = 0;
    await expect(
      withSendRetry(async () => {
        i++;
        return { status: 503, body: "down" };
      }, { ...baseOpts, maxAttempts: 4, network: { operation: "send", maxAttempts: 1 } }),
    ).rejects.toMatchObject({ kind: "transient", status: 503 });
    expect(i).toBe(4);
  });

  it("stops after a transport failure followed by an HTTP 5xx once the send cap is reached", async () => {
    const events: SendRetryAttemptEvent[] = [];
    let i = 0;
    await expect(
      withSendRetry(async () => {
        i++;
        if (i === 1) throw fetchFailed("ECONNRESET", "read");
        return { status: 503, body: "down" };
      }, { ...baseOpts, maxAttempts: 5, network: { operation: "send", onAttempt: (event) => events.push(event) } }),
    ).rejects.toMatchObject({ kind: "transient", status: 503 });
    expect(i).toBe(2);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ outcome: "retry", attempt: 1, maxAttempts: 2 });
  });

  it("stops after an HTTP 5xx followed by a transport failure once the send cap is reached", async () => {
    const events: SendRetryAttemptEvent[] = [];
    let i = 0;
    const caught = await withSendRetry(async () => {
      i++;
      if (i === 1) return { status: 502, body: "bad gateway" };
      throw fetchFailed("ETIMEDOUT", "connect");
    }, { ...baseOpts, maxAttempts: 5, network: { operation: "send", onAttempt: (event) => events.push(event) } }).catch(
      (err: unknown) => err,
    );
    expect(i).toBe(2);
    expect(caught).toBeInstanceOf(TypeError);
    expect((caught as TypeError & { cause?: { code?: string } }).cause?.code).toBe("ETIMEDOUT");
    expect(events).toEqual([
      expect.objectContaining({ outcome: "exhausted", attempt: 2, maxAttempts: 2, causeCode: "ETIMEDOUT" }),
    ]);
  });

  it("recovers across mixed transport and HTTP failures within an edit's cap", async () => {
    const events: SendRetryAttemptEvent[] = [];
    const script: Array<() => { status: number; body: string }> = [
      () => { throw fetchFailed("ECONNRESET", "read"); },
      () => ({ status: 503, body: "down" }),
      () => ({ status: 200, body: "{}" }),
    ];
    let i = 0;
    const result = await withSendRetry(async () => script[i++]!(), {
      ...baseOpts,
      maxAttempts: 6,
      network: { operation: "edit", idempotent: true, onAttempt: (event) => events.push(event) },
    });
    expect(result.status).toBe(200);
    expect(i).toBe(3);
    expect(events).toEqual([expect.objectContaining({ outcome: "retry", attempt: 1, maxAttempts: 3 })]);
  });

  it("never exceeds the edit cap for any transport/HTTP interleaving", async () => {
    const kinds = ["t", "h"] as const;
    for (const a of kinds) for (const b of kinds) for (const c of kinds) for (const d of kinds) {
      const order = [a, b, c, d];
      let i = 0;
      await withSendRetry(async () => {
        const step = order[i++] ?? "h";
        if (step === "t") throw fetchFailed("ECONNRESET", "read");
        return { status: 503, body: "down" };
      }, { ...baseOpts, maxAttempts: 10, network: { operation: "edit", idempotent: true } }).catch(() => undefined);
      const firstTransport = order.indexOf("t");
      const expected = firstTransport === -1 ? 10 : Math.min(10, Math.max(firstTransport + 1, 3));
      expect(i).toBe(expected);
    }
  });

  it("honors opts.maxAttempts=1 for a transport failure and preserves the cause", async () => {
    const events: SendRetryAttemptEvent[] = [];
    let i = 0;
    const caught = await withSendRetry(async () => {
      i++;
      throw fetchFailed("ECONNRESET", "read");
    }, { ...baseOpts, maxAttempts: 1, network: { operation: "send", onAttempt: (event) => events.push(event) } }).catch(
      (err: unknown) => err,
    );
    expect(i).toBe(1);
    expect(caught).toBeInstanceOf(TypeError);
    expect((caught as TypeError & { cause?: { code?: string } }).cause?.code).toBe("ECONNRESET");
    expect(events).toEqual([
      expect.objectContaining({ outcome: "exhausted", attempt: 1, maxAttempts: 1 }),
    ]);
  });

  it("honors opts.maxAttempts=1 for an HTTP 5xx", async () => {
    let i = 0;
    await expect(
      withSendRetry(async () => {
        i++;
        return { status: 500, body: "boom" };
      }, { ...baseOpts, maxAttempts: 1, network: { operation: "edit", idempotent: true } }),
    ).rejects.toMatchObject({ kind: "transient", status: 500 });
    expect(i).toBe(1);
  });

  it("treats a non-finite maxAttempts as the default instead of looping forever", async () => {
    let i = 0;
    await expect(
      withSendRetry(async () => {
        i++;
        return { status: 500, body: "boom" };
      }, { ...baseOpts, maxAttempts: Number.NaN }),
    ).rejects.toMatchObject({ kind: "transient" });
    expect(i).toBe(3);
  });

  it("diagnoses an unrecognized fetch failed cause without retrying it", async () => {
    const events: SendRetryAttemptEvent[] = [];
    let i = 0;
    const caught = await withSendRetry(async () => {
      i++;
      throw fetchFailed("ERR_SOMETHING_NEW", "connect");
    }, networkOpts((event) => events.push(event))).catch((err: unknown) => err);
    expect(i).toBe(1);
    expect(caught).toBeInstanceOf(TypeError);
    expect((caught as TypeError & { cause?: { code?: string } }).cause?.code).toBe("ERR_SOMETHING_NEW");
    expect(events).toEqual([
      expect.objectContaining({
        outcome: "not_retryable",
        attempt: 1,
        causeCode: "ERR_SOMETHING_NEW",
        unrecognizedCause: true,
        ambiguousDelivery: true,
      }),
    ]);
  });

  it("logs an unknown exception as not-retryable without retrying it", async () => {
    const events: SendRetryAttemptEvent[] = [];
    let i = 0;
    const thrown = new Error("programmer error https://cliq.zoho.eu token=abc");
    const caught = await withSendRetry(async () => {
      i++;
      throw thrown;
    }, networkOpts((event) => events.push(event))).catch((err: unknown) => err);
    expect(i).toBe(1);
    expect(caught).toBe(thrown);
    expect(events).toEqual([
      {
        operation: "send",
        attempt: 1,
        maxAttempts: 2,
        outcome: "not_retryable",
        errorName: "Error",
        unrecognizedCause: true,
        ambiguousDelivery: true,
        duplicateRisk: true,
      },
    ]);
  });
});

describe("withTransportRetry", () => {
  const oauthOpts = (onAttempt: (event: SendRetryAttemptEvent) => void): SendRetryOptions => ({
    ...baseOpts,
    network: { operation: "oauth", idempotent: true, onAttempt },
  });

  it("retries a transient OAuth transport failure and then recovers", async () => {
    const sleeps: number[] = [];
    const events: SendRetryAttemptEvent[] = [];
    let i = 0;
    const result = await withTransportRetry(async () => {
      if (i++ === 0) throw fetchFailed("ECONNRESET", "read");
      return "token-response";
    }, { ...oauthOpts((event) => events.push(event)), sleep: async (ms) => { sleeps.push(ms); } });
    expect(result).toBe("token-response");
    expect(i).toBe(2);
    expect(sleeps).toEqual([250]);
    expect(events).toEqual([
      {
        operation: "oauth",
        attempt: 1,
        maxAttempts: 3,
        outcome: "retry",
        errorName: "TypeError",
        causeCode: "ECONNRESET",
        causeSyscall: "read",
        delayMs: 250,
        ambiguousDelivery: true,
        duplicateRisk: false,
      },
    ]);
  });

  it("exhausts at the OAuth cap, preserving the original cause", async () => {
    const events: SendRetryAttemptEvent[] = [];
    let i = 0;
    const caught = await withTransportRetry(async () => {
      i++;
      throw fetchFailed("ETIMEDOUT", "connect");
    }, oauthOpts((event) => events.push(event))).catch((err: unknown) => err);
    expect(i).toBe(3);
    expect(caught).toBeInstanceOf(TypeError);
    expect((caught as TypeError & { cause?: { code?: string } }).cause?.code).toBe("ETIMEDOUT");
    expect(events.map((event) => event.outcome)).toEqual(["retry", "retry", "exhausted"]);
    expect(events.map((event) => event.maxAttempts)).toEqual([3, 3, 3]);
    expect(events.map((event) => event.duplicateRisk)).toEqual([false, false, false]);
  });

  it("honors opts.maxAttempts=1 for an OAuth transport failure", async () => {
    const events: SendRetryAttemptEvent[] = [];
    let i = 0;
    const caught = await withTransportRetry(async () => {
      i++;
      throw fetchFailed("ECONNRESET", "read");
    }, { ...oauthOpts((event) => events.push(event)), maxAttempts: 1 }).catch((err: unknown) => err);
    expect(i).toBe(1);
    expect(caught).toBeInstanceOf(TypeError);
    expect(events).toEqual([expect.objectContaining({ outcome: "exhausted", attempt: 1, maxAttempts: 1 })]);
  });

  it("does not retry a permanent failure or an unknown exception", async () => {
    const events: SendRetryAttemptEvent[] = [];
    let tls = 0;
    await expect(
      withTransportRetry(async () => {
        tls++;
        throw fetchFailed("CERT_HAS_EXPIRED");
      }, oauthOpts((event) => events.push(event))),
    ).rejects.toThrow("fetch failed");
    expect(tls).toBe(1);

    let other = 0;
    const thrown = new Error("programmer error https://accounts.zoho.eu token=abc");
    const caught = await withTransportRetry(async () => {
      other++;
      throw thrown;
    }, oauthOpts((event) => events.push(event))).catch((err: unknown) => err);
    expect(other).toBe(1);
    expect(caught).toBe(thrown);
    expect(events).toEqual([
      { operation: "oauth", attempt: 1, maxAttempts: 3, outcome: "not_retryable", errorName: "TypeError", causeCode: "CERT_HAS_EXPIRED", ambiguousDelivery: true, duplicateRisk: false },
      { operation: "oauth", attempt: 1, maxAttempts: 3, outcome: "not_retryable", errorName: "Error", unrecognizedCause: true, ambiguousDelivery: true, duplicateRisk: false },
    ]);
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

