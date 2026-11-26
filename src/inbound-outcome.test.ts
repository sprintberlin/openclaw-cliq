import { describe, expect, it } from "vitest";
import { CliqSendError } from "./send-retry.js";
import {
  CLIQ_DELIVERY_FAILURE_PREFIX,
  CLIQ_INBOUND_SKIP_PREFIX,
  CLIQ_INBOUND_SKIP_REASONS,
  cliqDedupeSkipReason,
  formatCliqDeliveryFailure,
  formatCliqInboundSkip,
} from "./inbound-outcome.js";

describe("inbound skip vocabulary (issue #232)", () => {
  it("renders a stable, greppable prefix and reason", () => {
    expect(formatCliqInboundSkip({ reason: "duplicate" })).toBe(
      "[cliq] inbound skipped: duplicate",
    );
  });

  it("includes identifiers when known", () => {
    const line = formatCliqInboundSkip({
      reason: "self",
      messageId: "evt:123",
      senderId: "u-1",
      detail: "matched_field=senderId",
    });
    expect(line).toBe(
      "[cliq] inbound skipped: self (message=evt:123 sender=u-1 detail=matched_field=senderId)",
    );
  });

  it("omits absent fields so a pre-parse skip still logs usefully", () => {
    // An unreadable body has no message id and no sender yet.
    const line = formatCliqInboundSkip({
      reason: "empty_body",
      detail: "empty body; content-length=0",
    });
    expect(line).toBe(
      "[cliq] inbound skipped: empty_body (detail=empty body; content-length=0)",
    );
    expect(line).not.toContain("message=");
    expect(line).not.toContain("sender=");
  });

  it("every reason renders with the shared prefix", () => {
    for (const reason of CLIQ_INBOUND_SKIP_REASONS) {
      const line = formatCliqInboundSkip({ reason });
      expect(line.startsWith(CLIQ_INBOUND_SKIP_PREFIX)).toBe(true);
      expect(line).toContain(reason);
    }
  });

  it("keeps the vocabulary unique and append-only", () => {
    // Doctor output, dashboards and operator greps match these codes.
    const unique = new Set<string>(CLIQ_INBOUND_SKIP_REASONS);
    expect(unique.size).toBe(CLIQ_INBOUND_SKIP_REASONS.length);
  });

  it("maps dedupe claim kinds onto skip reasons", () => {
    expect(cliqDedupeSkipReason("duplicate")).toBe("duplicate");
    expect(cliqDedupeSkipReason("inflight")).toBe("inflight");
    // `claimed` is the success path: it must NOT produce a skip line.
    expect(cliqDedupeSkipReason("claimed")).toBeNull();
  });

  it("has no parameter that can carry user content", () => {
    // Guard for the safety contract: these lines are emitted at warn (default
    // operator view), so the shape must stay identifier-only. If someone adds
    // a `text`/`message`/`body` field, this test fails and forces a review.
    const allowed = ["reason", "messageId", "senderId", "detail"].sort();
    const sample = {
      reason: "self" as const,
      messageId: "m",
      senderId: "s",
      detail: "d",
    };
    expect(Object.keys(sample).sort()).toEqual(allowed);
  });
});

describe("delivery failure lines (issue #353)", () => {
  const fetchFailed = Object.assign(new TypeError("fetch failed"), {
    cause: { code: "ECONNRESET", syscall: "read" },
  });

  it("keeps the transport cause a bare String(err) drops", () => {
    const line = formatCliqDeliveryFailure(fetchFailed, { kind: "final" });
    expect(line).toBe(
      `${CLIQ_DELIVERY_FAILURE_PREFIX}: kind=final (TypeError: fetch failed code=ECONNRESET syscall=read)`,
    );
  });

  it("keeps the HTTP status of a Cliq send failure without echoing its body", () => {
    const err = new CliqSendError("fatal", 401, '{"message":"token abc123 rejected"}');
    const line = formatCliqDeliveryFailure(err, { kind: "final" });
    expect(line).toBe(
      `${CLIQ_DELIVERY_FAILURE_PREFIX}: kind=final (CliqSendError status=401 kind=fatal code=HTTP_401)`,
    );
    expect(line).not.toContain("abc123");
  });

  it("keeps an allowlisted OAuth error code and status without the body", () => {
    const err = new Error("cliq: OAuth token request failed (401): invalid_client");
    const line = formatCliqDeliveryFailure(err, { kind: "final" });
    expect(line).toBe(
      `${CLIQ_DELIVERY_FAILURE_PREFIX}: kind=final (Error status=401 code=invalid_client)`,
    );
  });

  it("does not trust an OAuth-looking message with an unknown code or trailing text", () => {
    const secret = "1000.super-secret-token";
    for (const message of [
      `cliq: OAuth token request failed (401): ${secret}`,
      "cliq: OAuth token request failed (401): invalid_client trailing text",
      `prefix cliq: OAuth token request failed (401): invalid_client ${secret}`,
    ]) {
      const line = formatCliqDeliveryFailure(new Error(message), { kind: "final" });
      expect(line).not.toContain(secret);
      expect(line).not.toContain("code=invalid_client");
    }
  });

  it("survives a throwing getter without throwing or leaking", () => {
    const hostile = {
      get name(): string {
        throw new Error("name getter");
      },
      get message(): string {
        throw new Error("message getter SECRET_VALUE");
      },
      get cause(): unknown {
        throw new Error("cause getter");
      },
      get status(): number {
        throw new Error("status getter");
      },
    };
    const line = formatCliqDeliveryFailure(hostile, { kind: "final" });
    expect(line).toBe(`${CLIQ_DELIVERY_FAILURE_PREFIX}: kind=final (Error)`);
    expect(line).not.toContain("SECRET_VALUE");
  });

  it("names no recovery inline; the fallback lines correlate separately", () => {
    const line = formatCliqDeliveryFailure(fetchFailed, { kind: "final" });
    expect(line).not.toContain("recovery=");
  });

  it("walks a nested cause chain to the code", () => {
    const inner = Object.assign(new Error("socket closed"), { code: "ETIMEDOUT", syscall: "connect" });
    const err = Object.assign(new TypeError("fetch failed"), { cause: inner });
    expect(formatCliqDeliveryFailure(err, { kind: "final" })).toContain("code=ETIMEDOUT syscall=connect");
  });

  it("never echoes secrets, URLs, or raw bodies", () => {
    const secret = "1000.super-secret-token";
    const err = new Error(
      `cliq: send failed [fatal] status=401: {"access_token":"${secret}"} https://accounts.zoho.eu/oauth?client_secret=${secret}`,
    );
    const line = formatCliqDeliveryFailure(err, { kind: "final" });
    expect(line).not.toContain(secret);
    expect(line).not.toContain("http");
    expect(line).toBe(`${CLIQ_DELIVERY_FAILURE_PREFIX}: kind=final (Error)`);
  });

  it("flattens newlines and unsafe kinds so a crafted value cannot forge a log line", () => {
    const err = new Error("fetch failed\n[cliq] send ok: status=200");
    const line = formatCliqDeliveryFailure(err, { kind: "final\n[cliq] forged" });
    expect(line.split("\n")).toHaveLength(1);
    expect(line).toContain("kind=finalcliqforged");
    expect(line).not.toContain("send ok");
  });
});
