import { describe, it, expect } from "vitest";
import {
  buildLocalWebhookUrl,
  checkCliqWebhookRoute,
  formatCliqRouteCheckReport,
  CLIQ_ROUTE_HEADER,
  CLIQ_ROUTE_HEADER_VALUE,
  INSPECT_NOTE,
  type CliqRouteCheckFetch,
} from "./webhook-route-check.js";
import { runCliqWebhookRouteCommand } from "./webhook-route-command.js";
import { registerCliqPluginForTest } from "./test-api.js";

const LOCAL_URL = "http://127.0.0.1:18789/cliq/webhook";

describe("route registration is asserted independently of the inspect field (issue #108)", () => {
  it("registers /cliq/webhook with a handler that answers GET with 405", async () => {
    // The regression guard the issue asks for: registration is proven from the
    // plugin's own registration call plus the handler's observable contract,
    // never from `plugins inspect --runtime`'s httpRoutes count (which is
    // produced by a non-activating load and is structurally always 0).
    const { routes, webhook } = registerCliqPluginForTest();
    expect(routes.map((r) => r.path)).toContain("/cliq/webhook");
    expect(webhook).toBeTruthy();
    expect(webhook.auth).toBe("plugin");

    const res = {
      statusCode: 0,
      headers: {} as Record<string, string>,
      body: "",
      setHeader(k: string, v: string) {
        this.headers[k] = v;
      },
      end(chunk?: string) {
        this.body = chunk ?? "";
      },
    };
    await webhook.handler(
      { method: "GET", headers: {} } as never,
      res as never,
    );
    // 405 is the signal `checkCliqWebhookRoute` reads as registered.
    expect(res.statusCode).toBe(405);
    expect(res.headers["Allow"]).toBe("POST");
    expect(res.headers[CLIQ_ROUTE_HEADER]).toBe(CLIQ_ROUTE_HEADER_VALUE);
  });
});

describe("buildLocalWebhookUrl", () => {
  it("defaults to the loopback gateway route", () => {
    expect(buildLocalWebhookUrl()).toBe(LOCAL_URL);
  });

  it("honors a custom port", () => {
    expect(buildLocalWebhookUrl({ port: 9999 })).toBe(
      "http://127.0.0.1:9999/cliq/webhook",
    );
  });
});

describe("checkCliqWebhookRoute", () => {
  const fetchStub = (handler: CliqRouteCheckFetch): CliqRouteCheckFetch => handler;

  it("reports the route as registered when GET is rejected with 405", async () => {
    const report = await checkCliqWebhookRoute({
      fetchImpl: fetchStub(async () => ({
        status: 405,
        headers: { [CLIQ_ROUTE_HEADER]: CLIQ_ROUTE_HEADER_VALUE },
      })),
    });
    expect(report.ok).toBe(true);
    expect(report.status).toBe("registered");
    expect(report.httpStatus).toBe(405);
    expect(report.url).toBe(LOCAL_URL);
    expect(report.detail).toMatch(/registered/i);
  });

  it("does not trust an unrelated 405 without the Cliq route signature", async () => {
    const report = await checkCliqWebhookRoute({
      fetchImpl: fetchStub(async () => ({
        status: 405,
        headers: { allow: "POST" },
      })),
    });
    expect(report.ok).toBe(false);
    expect(report.status).toBe("unknown");
    expect(report.detail).toMatch(/route signature/i);
  });

  it("matches the route signature case-insensitively", async () => {
    const report = await checkCliqWebhookRoute({
      fetchImpl: fetchStub(async () => ({
        status: 405,
        headers: { "X-OpenClaw-Cliq-Route": CLIQ_ROUTE_HEADER_VALUE },
      })),
    });
    expect(report.ok).toBe(true);
    expect(report.status).toBe("registered");
  });

  it("reports an unsigned 404 as unknown because a proxy may have generated it", async () => {
    const report = await checkCliqWebhookRoute({
      fetchImpl: fetchStub(async () => ({ status: 404 })),
    });
    expect(report.ok).toBe(false);
    expect(report.status).toBe("unknown");
    expect(report.httpStatus).toBe(404);
    expect(report.detail).toMatch(/inconclusive/i);
    expect(report.detail).toMatch(/proxy|another service/i);
  });

  it("never uses a POST or sends a secret, so it cannot dispatch a turn", async () => {
    const methods: string[] = [];
    await checkCliqWebhookRoute({
      fetchImpl: fetchStub(async (_url, init) => {
        methods.push(init?.method ?? "GET");
        return {
          status: 405,
          headers: { [CLIQ_ROUTE_HEADER]: CLIQ_ROUTE_HEADER_VALUE },
        };
      }),
    });
    expect(methods).toEqual(["GET"]);
  });

  it("treats an unreachable gateway as unknown, not as a missing route", async () => {
    const report = await checkCliqWebhookRoute({
      fetchImpl: fetchStub(async () => {
        throw Object.assign(new Error("connect ECONNREFUSED"), { code: "ECONNREFUSED" });
      }),
    });
    expect(report.status).toBe("unknown");
    expect(report.ok).toBe(false);
    expect(report.httpStatus).toBeNull();
    expect(report.detail).toMatch(/could not reach/i);
    expect(report.detail).not.toMatch(/is NOT registered/);
  });

  it("treats an unexpected status as inconclusive rather than a pass", async () => {
    const report = await checkCliqWebhookRoute({
      fetchImpl: fetchStub(async () => ({
        status: 200,
      })),
    });
    expect(report.ok).toBe(false);
    expect(report.status).toBe("unknown");
    expect(report.httpStatus).toBe(200);
    expect(report.detail).toMatch(/inconclusive/i);
  });

  it("rejects a URL that is not the plugin route instead of guessing", async () => {
    let called = false;
    const report = await checkCliqWebhookRoute({
      url: "https://example.com/wrong",
      fetchImpl: fetchStub(async () => {
        called = true;
        return { status: 405 };
      }),
    });
    expect(called).toBe(false);
    expect(report.ok).toBe(false);
    expect(report.status).toBe("unknown");
  });

  it("accepts an explicit https URL for a proxied deployment", async () => {
    const report = await checkCliqWebhookRoute({
      url: "https://cliq.example.com/cliq/webhook",
      fetchImpl: fetchStub(async () => ({
        status: 405,
        headers: { [CLIQ_ROUTE_HEADER]: CLIQ_ROUTE_HEADER_VALUE },
      })),
    });
    expect(report.ok).toBe(true);
    expect(report.url).toBe("https://cliq.example.com/cliq/webhook");
  });

  it("always carries the explanation for the inspect httpRoutes discrepancy", async () => {
    for (const status of [405, 404, 500]) {
      const report = await checkCliqWebhookRoute({
        fetchImpl: fetchStub(async () => ({ status })),
      });
      expect(report.inspectNote).toBe(INSPECT_NOTE);
      expect(report.inspectNote).toMatch(/httpRoutes/);
    }
  });
});

describe("formatCliqRouteCheckReport", () => {
  it("renders the verdict and the inspect explanation", async () => {
    const report = await checkCliqWebhookRoute({
      fetchImpl: async () => ({
        status: 405,
        headers: { [CLIQ_ROUTE_HEADER]: CLIQ_ROUTE_HEADER_VALUE },
      }),
    });
    const lines = formatCliqRouteCheckReport(report);
    expect(lines[0]).toContain(LOCAL_URL);
    expect(lines.join("\n")).toMatch(/PASS/);
    expect(lines.join("\n")).toMatch(/httpRoutes/);
  });
});

describe("runCliqWebhookRouteCommand", () => {
  it("exits 0 when the route is registered", async () => {
    const lines: string[] = [];
    const code = await runCliqWebhookRouteCommand(
      {},
      {
        runCheck: async () => ({
          ok: true,
          status: "registered",
          url: LOCAL_URL,
          httpStatus: 405,
          detail: "registered",
          inspectNote: INSPECT_NOTE,
        }),
        writeLine: (line) => lines.push(line),
      },
    );
    expect(code).toBe(0);
    expect(lines.join("\n")).toContain(LOCAL_URL);
  });

  it("exits 1 when the result is inconclusive so it is safe as a deploy gate", async () => {
    const code = await runCliqWebhookRouteCommand(
      {},
      {
        runCheck: async () => ({
          ok: false,
          status: "unknown",
          url: LOCAL_URL,
          httpStatus: null,
          detail: "unreachable",
          inspectNote: INSPECT_NOTE,
        }),
        writeLine: () => {},
      },
    );
    expect(code).toBe(1);
  });

  it("emits the machine-readable report with --json", async () => {
    const lines: string[] = [];
    await runCliqWebhookRouteCommand(
      { json: true },
      {
        runCheck: async () => ({
          ok: true,
          status: "registered",
          url: LOCAL_URL,
          httpStatus: 405,
          detail: "registered",
          inspectNote: INSPECT_NOTE,
        }),
        writeLine: (line) => lines.push(line),
      },
    );
    const parsed = JSON.parse(lines.join("\n"));
    expect(parsed).toMatchObject({ ok: true, status: "registered", httpStatus: 405 });
  });

  it("passes a valid port through and rejects an invalid one", async () => {
    const seen: number[] = [];
    const errors: string[] = [];
    const deps = {
      runCheck: async ({ port }: { url?: string; port?: number }) => {
        if (port !== undefined) seen.push(port);
        return {
          ok: true,
          status: "registered" as const,
          url: LOCAL_URL,
          httpStatus: 405,
          detail: "registered",
          inspectNote: INSPECT_NOTE,
        };
      },
      writeLine: () => {},
      writeError: (line: string) => errors.push(line),
    };
    expect(await runCliqWebhookRouteCommand({ port: 9999 }, deps)).toBe(0);
    expect(await runCliqWebhookRouteCommand({ port: Number("abc") }, deps)).toBe(2);
    expect(await runCliqWebhookRouteCommand({ port: 70000 }, deps)).toBe(2);
    expect(seen).toEqual([9999]);
    expect(errors).toHaveLength(2);
    expect(errors.every((line) => line.includes("Invalid --port"))).toBe(true);
  });
});
