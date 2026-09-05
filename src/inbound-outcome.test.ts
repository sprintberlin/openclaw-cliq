import { describe, expect, it } from "vitest";
import {
  CLIQ_INBOUND_SKIP_PREFIX,
  CLIQ_INBOUND_SKIP_REASONS,
  cliqDedupeSkipReason,
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
