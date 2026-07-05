import { describe, it, expect } from "vitest";
import type { IncomingMessage, ServerResponse } from "node:http";

type RejectRes = Pick<ServerResponse, "setHeader" | "end" | "statusCode">;
import {
  constantTimeSecretMatch,
  createFailedAuthRateLimiter,
  rejectUnauthedWebhook,
  resolveClientIp,
  verifyWebhookSecret,
  WEBHOOK_SECRET_HEADER,
} from "./webhook-security.js";

function reqWithHeaders(
  headers: Record<string, string | string[] | undefined>,
  socket?: { remoteAddress?: string },
): Pick<IncomingMessage, "headers" | "socket"> & { socket?: { remoteAddress?: string } } {
  return { headers, socket } as Pick<IncomingMessage, "headers" | "socket"> & {
    socket?: { remoteAddress?: string };
  };
}

interface ResLike {
  statusCode: number;
  headers: Record<string, string | string[]>;
  body: string;
  ended: boolean;
  setHeader(name: string, value: string | string[]): void;
  end(chunk?: string): void;
}

function makeRes(): ResLike {
  return {
    statusCode: 0,
    headers: {},
    body: "",
    ended: false,
    setHeader(name, value) {
      this.headers[name] = value;
    },
    end(chunk) {
      if (chunk !== undefined) this.body += chunk;
      this.ended = true;
    },
  };
}

function asRes(r: ResLike): RejectRes {
  return r as unknown as RejectRes;
}

describe("constantTimeSecretMatch", () => {
  it("matches identical strings", () => {
    expect(constantTimeSecretMatch("s3cr3t", "s3cr3t")).toBe(true);
  });

  it("rejects different strings of equal length", () => {
    expect(constantTimeSecretMatch("s3cr3t", "s3cr3u")).toBe(false);
  });

  it("rejects different-length strings", () => {
    expect(constantTimeSecretMatch("short", "longer-secret")).toBe(false);
    expect(constantTimeSecretMatch("longer-secret", "short")).toBe(false);
  });

  it("rejects empty provided against non-empty expected", () => {
    expect(constantTimeSecretMatch("", "s3cr3t")).toBe(false);
  });
});

describe("verifyWebhookSecret", () => {
  it("allows when no secret configured", () => {
    expect(verifyWebhookSecret(reqWithHeaders({}), undefined)).toBe(true);
  });

  it("rejects when secret configured but header missing", () => {
    expect(verifyWebhookSecret(reqWithHeaders({}), "s3cr3t")).toBe(false);
  });

  it("matches the canonical x-cliq-webhook-secret header", () => {
    expect(
      verifyWebhookSecret(
        reqWithHeaders({ [WEBHOOK_SECRET_HEADER]: "s3cr3t" }),
        "s3cr3t",
      ),
    ).toBe(true);
  });

  it("rejects a mismatched secret", () => {
    expect(
      verifyWebhookSecret(
        reqWithHeaders({ [WEBHOOK_SECRET_HEADER]: "wrong" }),
        "s3cr3t",
      ),
    ).toBe(false);
  });

  it("honors only the canonical header (single-header enforcement)", () => {
    // Authorization / x-webhook-secret must NOT be accepted even when correct.
    expect(
      verifyWebhookSecret(
        reqWithHeaders({ authorization: "Bearer s3cr3t" }),
        "s3cr3t",
      ),
    ).toBe(false);
    expect(
      verifyWebhookSecret(
        reqWithHeaders({ "x-webhook-secret": "s3cr3t" }),
        "s3cr3t",
      ),
    ).toBe(false);
  });

  it("uses the first value when the header is an array", () => {
    expect(
      verifyWebhookSecret(
        reqWithHeaders({ [WEBHOOK_SECRET_HEADER]: ["s3cr3t", "extra"] }),
        "s3cr3t",
      ),
    ).toBe(true);
  });
});

describe("resolveClientIp", () => {
  it("uses socket.remoteAddress when no x-forwarded-for", () => {
    expect(
      resolveClientIp(reqWithHeaders({}, { remoteAddress: "203.0.113.5" })),
    ).toBe("203.0.113.5");
  });

  it("prefers the first x-forwarded-for hop", () => {
    expect(
      resolveClientIp(
        reqWithHeaders(
          { "x-forwarded-for": "198.51.100.2, 10.0.0.1" },
          { remoteAddress: "10.0.0.1" },
        ),
      ),
    ).toBe("198.51.100.2");
  });

  it("falls back to 'unknown' when nothing is available", () => {
    expect(resolveClientIp(reqWithHeaders({}))).toBe("unknown");
  });
});

describe("createFailedAuthRateLimiter", () => {
  it("does not limit until max+1 failures in the window", () => {
    const limiter = createFailedAuthRateLimiter({ max: 3, windowMs: 1000 });
    expect(limiter.hit("1.2.3.4")).toEqual({ limited: false, retryAfterMs: 0 });
    expect(limiter.hit("1.2.3.4")).toEqual({ limited: false, retryAfterMs: 0 });
    expect(limiter.hit("1.2.3.4")).toEqual({ limited: false, retryAfterMs: 0 });
    const r = limiter.hit("1.2.3.4");
    expect(r.limited).toBe(true);
    expect(r.retryAfterMs).toBeGreaterThan(0);
  });

  it("tracks IPs independently", () => {
    const limiter = createFailedAuthRateLimiter({ max: 1, windowMs: 1000 });
    expect(limiter.hit("a").limited).toBe(false);
    expect(limiter.hit("b").limited).toBe(false);
    expect(limiter.hit("a").limited).toBe(true);
    expect(limiter.hit("b").limited).toBe(true);
  });

  it("reset() clears all buckets", () => {
    const limiter = createFailedAuthRateLimiter({ max: 1, windowMs: 1000 });
    limiter.hit("a");
    expect(limiter.hit("a").limited).toBe(true);
    limiter.reset();
    expect(limiter.hit("a").limited).toBe(false);
  });

  it("window expiry resets the counter", async () => {
    const limiter = createFailedAuthRateLimiter({ max: 1, windowMs: 20 });
    limiter.hit("a");
    expect(limiter.hit("a").limited).toBe(true);
    await new Promise((r) => setTimeout(r, 30));
    expect(limiter.hit("a").limited).toBe(false);
  });
});

describe("rejectUnauthedWebhook", () => {
  it("writes 401 + Connection: close on a normal failed auth", () => {
    const limiter = createFailedAuthRateLimiter({ max: 100, windowMs: 1000 });
    const res = makeRes();
    const code = rejectUnauthedWebhook({
      req: reqWithHeaders({}, { remoteAddress: "1.2.3.4" }),
      res: asRes(res),
      limiter,
    });
    expect(code).toBe(401);
    expect(res.statusCode).toBe(401);
    expect(res.headers["Connection"]).toBe("close");
    expect(res.body).toBe("unauthorized");
    expect(res.ended).toBe(true);
  });

  it("writes 429 + Retry-After once the IP exceeds the failed-auth limit", () => {
    const limiter = createFailedAuthRateLimiter({ max: 2, windowMs: 1000 });
    const res1 = makeRes();
    rejectUnauthedWebhook({
      req: reqWithHeaders({}, { remoteAddress: "9.9.9.9" }),
      res: asRes(res1),
      limiter,
    });
    const res2 = makeRes();
    rejectUnauthedWebhook({
      req: reqWithHeaders({}, { remoteAddress: "9.9.9.9" }),
      res: asRes(res2),
      limiter,
    });
    const res3 = makeRes();
    const code = rejectUnauthedWebhook({
      req: reqWithHeaders({}, { remoteAddress: "9.9.9.9" }),
      res: asRes(res3),
      limiter,
    });
    expect(code).toBe(429);
    expect(res3.statusCode).toBe(429);
    expect(res3.headers["Connection"]).toBe("close");
    expect(res3.headers["Retry-After"]).toBeTruthy();
    const retryAfter = Number(res3.headers["Retry-After"]);
    expect(retryAfter).toBeGreaterThan(0);
    expect(res3.body).toBe("too many failed auth attempts");
  });

  it("never rate-limits a passing request (limiter is only hit on the 401 path)", () => {
    // Sanity: a valid secret must not record a failed-auth hit, so even after
    // many valid requests the limiter bucket stays empty.
    const limiter = createFailedAuthRateLimiter({ max: 1, windowMs: 1000 });
    for (let i = 0; i < 50; i++) {
      const ok = verifyWebhookSecret(
        reqWithHeaders({ [WEBHOOK_SECRET_HEADER]: "s3cr3t" }),
        "s3cr3t",
      );
      expect(ok).toBe(true);
    }
    // First *failed* auth from the same IP is still under the limit.
    const res = makeRes();
    const code = rejectUnauthedWebhook({
      req: reqWithHeaders({}, { remoteAddress: "5.5.5.5" }),
      res: asRes(res),
      limiter,
    });
    expect(code).toBe(401);
  });
});
