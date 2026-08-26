import { describe, it, expect } from "vitest";
import {
  classifyPreflightNetworkError,
  runCliqWebhookPreflight,
  validateWebhookUrl,
  type CliqPreflightFetch,
} from "./webhook-preflight.js";
import { CLIQ_PROBE_HANDLER } from "./webhook-probe.js";

const URL_OK = "https://laura-cliq.example.com/cliq/webhook";

function stageOf(report: { stages: Array<{ id: string; status: string; detail: string }> }, id: string) {
  const stage = report.stages.find((s) => s.id === id);
  if (!stage) throw new Error(`stage ${id} missing from report`);
  return stage;
}

describe("validateWebhookUrl (issue #96)", () => {
  it("accepts a https URL ending in /cliq/webhook", () => {
    expect(validateWebhookUrl(URL_OK)).toEqual({ ok: true, hostname: "laura-cliq.example.com" });
  });

  it("rejects a http URL because Zoho requires HTTPS", () => {
    const result = validateWebhookUrl("http://example.com/cliq/webhook");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toMatch(/https/i);
  });

  it("rejects a syntactically invalid URL", () => {
    expect(validateWebhookUrl("not a url").ok).toBe(false);
  });

  it("rejects a non-http protocol", () => {
    expect(validateWebhookUrl("ftp://example.com/cliq/webhook").ok).toBe(false);
  });

  it("warns when the path is not the plugin route", () => {
    const result = validateWebhookUrl("https://example.com/wrong");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toMatch(/\/cliq\/webhook/);
  });
});

describe("classifyPreflightNetworkError (issue #96)", () => {
  it("classifies DNS failures distinctly", () => {
    expect(classifyPreflightNetworkError({ code: "ENOTFOUND" })).toBe("dns");
    expect(classifyPreflightNetworkError({ code: "EAI_AGAIN" })).toBe("dns");
  });

  it("classifies TLS failures distinctly", () => {
    expect(classifyPreflightNetworkError({ code: "CERT_HAS_EXPIRED" })).toBe("tls");
    expect(classifyPreflightNetworkError({ code: "ERR_TLS_CERT_ALTNAME_INVALID" })).toBe("tls");
    expect(classifyPreflightNetworkError({ code: "UNABLE_TO_VERIFY_LEAF_SIGNATURE" })).toBe("tls");
    expect(classifyPreflightNetworkError({ code: "DEPTH_ZERO_SELF_SIGNED_CERT" })).toBe("tls");
  });

  it("classifies connection failures as proxy/transport problems", () => {
    expect(classifyPreflightNetworkError({ code: "ECONNREFUSED" })).toBe("proxy");
    expect(classifyPreflightNetworkError({ code: "ETIMEDOUT" })).toBe("proxy");
  });

  it("reads the code off a nested cause (undici wraps errors)", () => {
    expect(classifyPreflightNetworkError({ cause: { code: "ENOTFOUND" } })).toBe("dns");
  });

  it("falls back to 'network' for an unknown failure", () => {
    expect(classifyPreflightNetworkError(new Error("boom"))).toBe("network");
  });
});

describe("runCliqWebhookPreflight (issue #96)", () => {
  const secret = "s3cr3t";

  function fetchStub(handler: CliqPreflightFetch): CliqPreflightFetch {
    return handler;
  }

  /** A stub of a correctly deployed public endpoint. */
  const healthyFetch = fetchStub(async (_url, init) => {
    const method = init?.method ?? "GET";
    const headers = (init?.headers ?? {}) as Record<string, string>;
    if (method === "GET") {
      return { status: 405, text: async () => "Method Not Allowed" };
    }
    if (headers["x-cliq-webhook-secret"] !== secret) {
      return { status: 401, text: async () => "unauthorized" };
    }
    const body = JSON.parse(String(init?.body ?? "{}"));
    if (body.handler !== CLIQ_PROBE_HANDLER) {
      return { status: 400, text: async () => "invalid payload" };
    }
    return {
      status: 200,
      text: async () =>
        JSON.stringify({ ok: true, channel: "cliq", probe: body.probe, botId: "laura", dispatched: false }),
    };
  });

  it("passes every stage against a correctly deployed endpoint", async () => {
    const report = await runCliqWebhookPreflight({ url: URL_OK, secret, fetchImpl: healthyFetch });
    expect(report.ok).toBe(true);
    expect(stageOf(report, "url").status).toBe("pass");
    expect(stageOf(report, "reachability").status).toBe("pass");
    expect(stageOf(report, "method").status).toBe("pass");
    expect(stageOf(report, "secret").status).toBe("pass");
    expect(stageOf(report, "probe").status).toBe("pass");
  });

  it("proves the authenticated probe did not dispatch an agent turn", async () => {
    const report = await runCliqWebhookPreflight({ url: URL_OK, secret, fetchImpl: healthyFetch });
    expect(report.dispatched).toBe(false);
    expect(stageOf(report, "probe").detail).toMatch(/no agent turn/i);
  });

  it("correlates a unique nonce through the probe", async () => {
    let seen = "";
    const report = await runCliqWebhookPreflight({
      url: URL_OK,
      secret,
      fetchImpl: async (_url, init) => {
        const headers = (init?.headers ?? {}) as Record<string, string>;
        if ((init?.method ?? "GET") === "GET") return { status: 405, text: async () => "" };
        if (headers["x-cliq-webhook-secret"] !== secret) return { status: 401, text: async () => "" };
        seen = JSON.parse(String(init?.body)).probe;
        return {
          status: 200,
          text: async () => JSON.stringify({ ok: true, probe: seen, dispatched: false }),
        };
      },
    });
    expect(seen).not.toBe("");
    expect(report.nonce).toBe(seen);
  });

  it("fails on an invalid URL without touching the network", async () => {
    let called = false;
    const report = await runCliqWebhookPreflight({
      url: "http://example.com/cliq/webhook",
      secret,
      fetchImpl: async () => {
        called = true;
        return { status: 200, text: async () => "" };
      },
    });
    expect(report.ok).toBe(false);
    expect(called).toBe(false);
    expect(stageOf(report, "url").status).toBe("fail");
  });

  it("reports a missing DNS record as a DNS failure, not a route failure", async () => {
    const report = await runCliqWebhookPreflight({
      url: URL_OK,
      secret,
      fetchImpl: async () => {
        throw Object.assign(new Error("getaddrinfo ENOTFOUND"), { code: "ENOTFOUND" });
      },
    });
    expect(report.ok).toBe(false);
    const stage = stageOf(report, "reachability");
    expect(stage.status).toBe("fail");
    expect(stage.detail).toMatch(/dns/i);
  });

  it("reports an expired certificate as a TLS failure", async () => {
    const report = await runCliqWebhookPreflight({
      url: URL_OK,
      secret,
      fetchImpl: async () => {
        throw Object.assign(new Error("certificate has expired"), { code: "CERT_HAS_EXPIRED" });
      },
    });
    expect(stageOf(report, "reachability").detail).toMatch(/tls|certificate/i);
    expect(report.ok).toBe(false);
  });

  it("reports a wrong certificate hostname as a TLS failure", async () => {
    const report = await runCliqWebhookPreflight({
      url: URL_OK,
      secret,
      fetchImpl: async () => {
        throw Object.assign(new Error("altname invalid"), {
          code: "ERR_TLS_CERT_ALTNAME_INVALID",
        });
      },
    });
    expect(stageOf(report, "reachability").detail).toMatch(/tls|certificate/i);
  });

  it("reports a missing route (404) as a route failure, not an auth failure", async () => {
    const report = await runCliqWebhookPreflight({
      url: URL_OK,
      secret,
      fetchImpl: async () => ({ status: 404, text: async () => "not found" }),
    });
    expect(report.ok).toBe(false);
    const stage = stageOf(report, "method");
    expect(stage.status).toBe("fail");
    expect(stage.detail).toMatch(/route|404/i);
  });

  it("flags a redirect as a proxy problem so a catch-all redirect is obvious", async () => {
    const report = await runCliqWebhookPreflight({
      url: URL_OK,
      secret,
      fetchImpl: async () => ({
        status: 301,
        text: async () => "",
        headers: { location: "https://elsewhere.example.com/" },
      }),
    });
    expect(report.ok).toBe(false);
    const stage = stageOf(report, "method");
    expect(stage.detail).toMatch(/redirect/i);
    expect(stage.detail).toContain("https://elsewhere.example.com/");
  });

  it("flags an HTML login/challenge page in front of the route", async () => {
    const report = await runCliqWebhookPreflight({
      url: URL_OK,
      secret,
      fetchImpl: async () => ({
        status: 200,
        text: async () => "<html><body>Log in</body></html>",
        headers: { "content-type": "text/html" },
      }),
    });
    expect(report.ok).toBe(false);
    expect(stageOf(report, "method").detail).toMatch(/html|challenge|login/i);
  });

  it("distinguishes the OpenClaw web UI from an upstream challenge page", async () => {
    // The gateway registers /cliq/webhook only when the cliq channel is
    // configured. Without it the gateway's own web UI answers the path, which
    // reaches the origin but proves the plugin is not serving the route.
    const report = await runCliqWebhookPreflight({
      url: URL_OK,
      secret,
      fetchImpl: async () => ({
        status: 200,
        text: async () =>
          '<!doctype html>\n<html data-openclaw-terminal-enabled="false" lang="en"><head></head></html>',
        headers: { "content-type": "text/html" },
      }),
    });
    expect(report.ok).toBe(false);
    const detail = stageOf(report, "method").detail;
    expect(detail).toMatch(/openclaw/i);
    expect(detail).toMatch(/not registered|not configured|plugin/i);
    // The tunnel/proxy itself is fine — do not blame an upstream challenge.
    expect(detail).not.toMatch(/captcha/i);
    expect(stageOf(report, "reachability").status).toBe("pass");
  });

  it("fails when the endpoint accepts an unauthenticated POST", async () => {
    const report = await runCliqWebhookPreflight({
      url: URL_OK,
      secret,
      fetchImpl: async (_url, init) => {
        const method = init?.method ?? "GET";
        if (method === "GET") return { status: 405, text: async () => "" };
        return { status: 200, text: async () => "ok" };
      },
    });
    expect(report.ok).toBe(false);
    const stage = stageOf(report, "secret");
    expect(stage.status).toBe("fail");
    expect(stage.detail).toMatch(/without a secret|unauthenticated/i);
  });

  it("fails when a wrong secret is accepted", async () => {
    const report = await runCliqWebhookPreflight({
      url: URL_OK,
      secret,
      fetchImpl: async (_url, init) => {
        const method = init?.method ?? "GET";
        const headers = (init?.headers ?? {}) as Record<string, string>;
        if (method === "GET") return { status: 405, text: async () => "" };
        if (!headers["x-cliq-webhook-secret"]) return { status: 401, text: async () => "" };
        return { status: 200, text: async () => "ok" };
      },
    });
    expect(report.ok).toBe(false);
    expect(stageOf(report, "secret").status).toBe("fail");
  });

  it("reports the 503 fail-closed state when the gateway has no secret configured", async () => {
    const report = await runCliqWebhookPreflight({
      url: URL_OK,
      secret,
      fetchImpl: async (_url, init) => {
        if ((init?.method ?? "GET") === "GET") return { status: 405, text: async () => "" };
        return { status: 503, text: async () => "cliq webhook secret not configured" };
      },
    });
    expect(report.ok).toBe(false);
    const stage = stageOf(report, "secret");
    expect(stage.detail).toMatch(/not configured/i);
  });

  it("skips the probe when the caller has no secret to authenticate with", async () => {
    const report = await runCliqWebhookPreflight({
      url: URL_OK,
      secret: undefined,
      fetchImpl: async () => ({ status: 405, text: async () => "" }),
    });
    expect(stageOf(report, "probe").status).toBe("skipped");
    expect(report.ok).toBe(false);
  });

  it("fails the probe when the plugin rejects the authenticated probe payload", async () => {
    const report = await runCliqWebhookPreflight({
      url: URL_OK,
      secret,
      fetchImpl: async (_url, init) => {
        const method = init?.method ?? "GET";
        const headers = (init?.headers ?? {}) as Record<string, string>;
        if (method === "GET") return { status: 405, text: async () => "" };
        if (headers["x-cliq-webhook-secret"] !== secret) return { status: 401, text: async () => "" };
        return { status: 400, text: async () => "invalid payload" };
      },
    });
    expect(report.ok).toBe(false);
    const stage = stageOf(report, "probe");
    expect(stage.status).toBe("fail");
    expect(stage.detail).toMatch(/older version|probe/i);
  });

  it("never includes the secret in any stage detail or the JSON report", async () => {
    const report = await runCliqWebhookPreflight({ url: URL_OK, secret, fetchImpl: healthyFetch });
    const serialized = JSON.stringify(report);
    expect(serialized).not.toContain(secret);
    for (const stage of report.stages) expect(stage.detail).not.toContain(secret);
  });

  it("redacts the secret if a server echoes it back in a response body", async () => {
    const report = await runCliqWebhookPreflight({
      url: URL_OK,
      secret,
      fetchImpl: async (_url, init) => {
        if ((init?.method ?? "GET") === "GET") return { status: 405, text: async () => "" };
        return { status: 500, text: async () => `boom: secret was ${secret}` };
      },
    });
    expect(JSON.stringify(report)).not.toContain(secret);
  });

  it("produces a stable machine-readable shape for #97 to consume", async () => {
    const report = await runCliqWebhookPreflight({ url: URL_OK, secret, fetchImpl: healthyFetch });
    expect(Object.keys(report).sort()).toEqual(
      ["dispatched", "nonce", "ok", "stages", "url"].sort(),
    );
    for (const stage of report.stages) {
      expect(Object.keys(stage).sort()).toEqual(["detail", "id", "label", "status"].sort());
      expect(["pass", "fail", "warn", "skipped"]).toContain(stage.status);
    }
  });

  it("reports every stage even after an early failure so the report is complete", async () => {
    const report = await runCliqWebhookPreflight({
      url: "http://example.com/cliq/webhook",
      secret,
      fetchImpl: async () => ({ status: 200, text: async () => "" }),
    });
    expect(report.stages.map((s) => s.id)).toEqual([
      "url",
      "reachability",
      "method",
      "secret",
      "probe",
    ]);
  });
});
