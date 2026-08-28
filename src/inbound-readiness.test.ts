import { describe, it, expect } from "vitest";
import {
  resolveCliqInboundReadiness,
  type CliqInboundReadinessInput,
} from "./inbound-readiness.js";

const PASSING = {
  ok: true,
  url: "https://host.example.com/cliq/webhook",
  nonce: "n",
  dispatched: false,
  stages: [],
};

const FAILING = { ...PASSING, ok: false };

function resolve(input: Partial<CliqInboundReadinessInput> = {}) {
  return resolveCliqInboundReadiness({
    configured: true,
    publicUrl: "https://host.example.com/cliq/webhook",
    preflight: PASSING,
    ...input,
  });
}

describe("resolveCliqInboundReadiness (issue #96)", () => {
  it("marks inbound ready when the channel is configured and the preflight passed", () => {
    const result = resolve();
    expect(result.ready).toBe(true);
  });

  it("refuses to mark inbound ready when the preflight failed", () => {
    const result = resolve({ preflight: FAILING });
    expect(result.ready).toBe(false);
    expect(result.reason).toMatch(/preflight/i);
  });

  it("marks a warn-only preflight as inconclusive", () => {
    const result = resolve({
      preflight: {
        ...FAILING,
        stages: [
          {
            id: "method",
            label: "Route",
            status: "warn",
            detail: "gateway returned 502 after bounded readiness retries",
          },
        ],
      },
    });
    expect(result.ready).toBe(false);
    expect(result.inconclusive).toBe(true);
    expect(result.reason).toMatch(/inconclusive|502/i);
  });

  it("refuses to mark inbound ready when the channel is not configured", () => {
    const result = resolve({ configured: false });
    expect(result.ready).toBe(false);
    expect(result.reason).toMatch(/not configured/i);
  });

  it("does not claim readiness when no public URL is known", () => {
    const result = resolve({ publicUrl: undefined, preflight: undefined });
    expect(result.ready).toBe(false);
    expect(result.reason).toMatch(/public/i);
  });

  it("does not claim readiness when the preflight was never run", () => {
    const result = resolve({ preflight: undefined });
    expect(result.ready).toBe(false);
    expect(result.reason).toMatch(/not been verified|not run/i);
  });

  it("treats an unreachable endpoint as not ready even with full credentials", () => {
    const result = resolve({
      preflight: {
        ...FAILING,
        stages: [
          { id: "reachability", label: "DNS", status: "fail", detail: "DNS did not resolve" },
        ],
      },
    });
    expect(result.ready).toBe(false);
  });

  it("surfaces the first failing stage detail so the operator gets the actual cause", () => {
    const result = resolve({
      preflight: {
        ...FAILING,
        stages: [
          { id: "url", label: "URL", status: "pass", detail: "fine" },
          { id: "reachability", label: "DNS", status: "fail", detail: "DNS did not resolve host" },
          { id: "method", label: "Route", status: "skipped", detail: "not reached" },
        ],
      },
    });
    expect(result.reason).toContain("DNS did not resolve host");
  });
});
