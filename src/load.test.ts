import { describe, expect, it, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import cliqEntry from "../index.js";
import { cliqPlugin } from "./channel.js";
import { resetCliqDedupeForTest } from "./dedupe.js";
import { setCliqClientRegistry } from "./runtime-api.js";
import {
  createCliqTestConfig,
  createMockIncomingRequest,
  createMockServerResponse,
  createTestRuntimeChannel,
  registerCliqPluginForTest,
  createMentionDelugePayload,
} from "./test-api.js";

describe("plugin entry load + /cliq/webhook smoke", () => {
  beforeEach(() => {
    resetCliqDedupeForTest();
  });

  it("exports a DefinedChannelPluginEntry for channel id 'cliq'", () => {
    expect(cliqEntry).toBeTruthy();
    expect(cliqEntry.id).toBe("cliq");
    expect(cliqEntry.name).toBe("Zoho Cliq");
    expect(typeof cliqEntry.description).toBe("string");
    expect(cliqEntry.channelPlugin).toBe(cliqPlugin);
    expect(typeof cliqEntry.register).toBe("function");
  });

  it("register() wires channel registration, cli metadata, and the /cliq/webhook route", () => {
    const { webhook, registeredChannel, cliRegistered, securityAuditCollectors } =
      registerCliqPluginForTest();
    expect(registeredChannel()).toBe(true);
    expect(cliRegistered()).toBe(true);
    expect(webhook).toBeTruthy();
    expect(webhook.auth).toBe("plugin");
    expect(typeof webhook.handler).toBe("function");
    // The security-audit collector must be registered so `openclaw security
    // audit` surfaces Cliq findings (missing webhook secret, wildcard
    // allowFrom, open DM policy, plaintext secrets).
    expect(securityAuditCollectors).toHaveLength(1);
    expect(typeof securityAuditCollectors[0]).toBe("function");
  });

  it("GET /cliq/webhook → 405 Method Not Allowed (Allow: POST)", async () => {
    const { webhook } = registerCliqPluginForTest();
    const res = createMockServerResponse();
    const result = await webhook.handler(
      createMockIncomingRequest("GET", ""),
      res as unknown as any,
    );
    expect(result).toBe(true);
    expect(res.statusCode).toBe(405);
    expect(res.headers["Allow"]).toBe("POST");
    expect(res.body).toBe("Method Not Allowed");
    expect(res.ended).toBe(true);
  });

  it("POST /cliq/webhook with dummy Deluge payload but unconfigured channel → 503 (acceptable HTTP response)", async () => {
    const { webhook } = registerCliqPluginForTest();
    const res = createMockServerResponse();
    const payload = createMentionDelugePayload({ handler: "openclaw-bot" });
    const result = await webhook.handler(
      createMockIncomingRequest("POST", payload),
      res as unknown as any,
    );
    expect(result).toBe(true);
    expect(res.ended).toBe(true);
    expect(res.statusCode).toBe(503);
    expect(res.body).toBe("cliq not configured");
  });

  it("POST /cliq/webhook with configured account + valid secret + dummy payload → 200 received", async () => {
    const { webhook, api } = registerCliqPluginForTest();
    api.config = createCliqTestConfig({
      clientId: "id",
      clientSecret: "secret",
      botId: "bot",
      botName: "openclaw-bot",
      webhookSecret: "s3cr3t",
    });
    api.runtime = createTestRuntimeChannel(async () => undefined);
    const res = createMockServerResponse();
    const payload = createMentionDelugePayload();
    const result = await webhook.handler(
      createMockIncomingRequest("POST", payload, {
        "x-cliq-webhook-secret": "s3cr3t",
      }),
      res as unknown as any,
    );
    expect(result).toBe(true);
    expect(res.ended).toBe(true);
    expect(res.statusCode).toBe(200);
    expect(res.headers["Content-Type"]).toBe("application/json");
    expect(JSON.parse(res.body)).toEqual({ status: "received" });
  });

  it("POST /cliq/webhook with wrong secret → 401 unauthorized", async () => {
    const { webhook, api } = registerCliqPluginForTest();
    api.config = createCliqTestConfig({
      clientId: "id",
      clientSecret: "secret",
      botId: "bot",
      botName: "openclaw-bot",
      webhookSecret: "s3cr3t",
    });
    const res = createMockServerResponse();
    const result = await webhook.handler(
      createMockIncomingRequest("POST", { message: "x" }, {
        "x-cliq-webhook-secret": "wrong",
      }),
      res as unknown as any,
    );
    expect(result).toBe(true);
    expect(res.statusCode).toBe(401);
    expect(res.body).toBe("unauthorized");
  });
});

describe("durable-before-ack ingest (issue #12)", () => {
  beforeEach(() => {
    resetCliqDedupeForTest();
  });

  function buildDurableRegistration(opts: {
    inboundRun: () => Promise<unknown>;
    ackPolicy?: "after_dispatch" | "immediate";
  }) {
    const section: Record<string, unknown> = {
      clientId: "id",
      clientSecret: "secret",
      botId: "bot",
      botName: "openclaw-bot",
      webhookSecret: "s3cr3t",
    };
    if (opts.ackPolicy) section.ackPolicy = opts.ackPolicy;
    return registerCliqPluginForTest({
      config: createCliqTestConfig(section),
      runtime: createTestRuntimeChannel(opts.inboundRun),
    });
  }

  const mentionPayload = createMentionDelugePayload();

  it("default ackPolicy awaits dispatch; on success returns 200", async () => {
    let runCalled = 0;
    const { webhook } = buildDurableRegistration({
      inboundRun: async () => {
        runCalled++;
        return undefined;
      },
    });
    const res = createMockServerResponse();
    await webhook.handler(
      createMockIncomingRequest("POST", mentionPayload, {
        "x-cliq-webhook-secret": "s3cr3t",
      }),
      res as unknown as any,
    );
    expect(runCalled).toBe(1);
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toEqual({ status: "received" });
  });

  it("default ackPolicy awaits dispatch; on failure returns 500 so Cliq redelivers", async () => {
    let runCalled = 0;
    const { webhook } = buildDurableRegistration({
      inboundRun: async () => {
        runCalled++;
        throw new Error("spool failed");
      },
    });
    const res = createMockServerResponse();
    await webhook.handler(
      createMockIncomingRequest("POST", mentionPayload, {
        "x-cliq-webhook-secret": "s3cr3t",
      }),
      res as unknown as any,
    );
    expect(runCalled).toBe(1);
    expect(res.statusCode).toBe(500);
    expect(res.body).toBe("dispatch failed");
  });

  it("ackPolicy=immediate acks 200 without awaiting dispatch", async () => {
    let runStarted = false;
    let runResolved = false;
    const { webhook } = buildDurableRegistration({
      ackPolicy: "immediate",
      inboundRun: async () => {
        runStarted = true;
        // Simulate a long agent round-trip; the webhook must ack before this
        // resolves (fire-and-forget).
        await new Promise((r) => setTimeout(r, 50));
        runResolved = true;
      },
    });
    const res = createMockServerResponse();
    await webhook.handler(
      createMockIncomingRequest("POST", mentionPayload, {
        "x-cliq-webhook-secret": "s3cr3t",
      }),
      res as unknown as any,
    );
    expect(runStarted).toBe(true);
    expect(res.statusCode).toBe(200);
    expect(res.ended).toBe(true);
    // The dispatch is still running when we acked.
    expect(runResolved).toBe(false);
    // Give the fire-and-forget dispatch a chance to finish so the test
    // doesn't leak an unhandled rejection.
    await new Promise((r) => setTimeout(r, 80));
    expect(runResolved).toBe(true);
  });
});

describe("welcome-on-subscribe webhook routing (issue #52)", () => {
  beforeEach(() => {
    resetCliqDedupeForTest();
    setCliqClientRegistry(null);
  });

  function buildWelcomeRegistration(opts: {
    welcome?: { enabled: boolean; text?: string; textRejoin?: string };
    dmPolicy?: string;
    allowFrom?: string[];
  } = {}) {
    const section: Record<string, unknown> = {
      clientId: "id",
      clientSecret: "secret",
      botId: "bot",
      botName: "openclaw-bot",
      webhookSecret: "s3cr3t",
      apiBase: "https://cliq.test",
      oauthBase: "https://accounts.test",
    };
    if (opts.welcome) section.welcome = opts.welcome;
    if (opts.dmPolicy) section.dmPolicy = opts.dmPolicy;
    if (opts.allowFrom) section.allowFrom = opts.allowFrom;
    return registerCliqPluginForTest({
      config: createCliqTestConfig(section),
      runtime: createTestRuntimeChannel(async () => undefined),
    });
  }

  function mockFetchSends(): {
    sends: { url: string; body: string }[];
    install: () => () => void;
  } {
    const sends: { url: string; body: string }[] = [];
    const install = () => {
      const original = globalThis.fetch;
      globalThis.fetch = (async (url: URL | string, init?: RequestInit) => {
        const urlStr = typeof url === "string" ? url : url.toString();
        if (urlStr.includes("/oauth/v2/token")) {
          return new Response(
            JSON.stringify({ access_token: "tok", expires_in: 3600 }),
            { status: 200 },
          );
        }
        if (init?.method === "POST") {
          sends.push({ url: urlStr, body: init.body as string });
          return new Response(JSON.stringify({ id: "msg-1" }), {
            status: 200,
          });
        }
        return new Response("", { status: 404 });
      }) as typeof fetch;
      return () => {
        globalThis.fetch = original;
      };
    };
    return { sends, install };
  }

  it("routes a welcome event to a greeting DM when welcome.enabled is true", async () => {
    const { webhook } = buildWelcomeRegistration({
      welcome: { enabled: true, text: "Hi {{firstName}}!", textRejoin: "Hi!" },
      dmPolicy: "open",
    });
    const { sends, install } = mockFetchSends();
    const restore = install();
    try {
      const res = createMockServerResponse();
      await webhook.handler(
        createMockIncomingRequest(
          "POST",
          {
            handler: "welcome",
            user: { id: "u1", first_name: "Jane" },
            newuser: true,
          },
          { "x-cliq-webhook-secret": "s3cr3t" },
        ),
        res as unknown as any,
      );
      expect(res.statusCode).toBe(200);
      expect(res.body).toBe("ok");
      // Exactly one POST: the greeting DM (no inbound dispatch).
      expect(sends).toHaveLength(1);
      const parsed = JSON.parse(sends[0].body) as { text: string; userids: string };
      expect(parsed.text).toBe("Hi Jane!");
      expect(parsed.userids).toBe("u1");
      // Greeting DMs go through the bot-message endpoint.
      expect(sends[0].url).toContain("/bots/bot/message");
    } finally {
      restore();
    }
  });

  it("acks a welcome event with no send when welcome is disabled (default)", async () => {
    const { webhook } = buildWelcomeRegistration({ dmPolicy: "open" });
    const { sends, install } = mockFetchSends();
    const restore = install();
    try {
      const res = createMockServerResponse();
      await webhook.handler(
        createMockIncomingRequest(
          "POST",
          {
            handler: "welcome",
            user: { id: "u1", name: "Jane" },
            newuser: true,
          },
          { "x-cliq-webhook-secret": "s3cr3t" },
        ),
        res as unknown as any,
      );
      expect(res.statusCode).toBe(200);
      expect(sends).toHaveLength(0);
    } finally {
      restore();
    }
  });

  it("acks a welcome event with no send when the sender is denied by dmPolicy", async () => {
    const { webhook } = buildWelcomeRegistration({
      welcome: { enabled: true, text: "Hi", textRejoin: "Hi" },
      dmPolicy: "allowlist",
      allowFrom: ["someone-else"],
    });
    const { sends, install } = mockFetchSends();
    const restore = install();
    try {
      const res = createMockServerResponse();
      await webhook.handler(
        createMockIncomingRequest(
          "POST",
          {
            handler: "welcome",
            user: { id: "stranger", name: "Stranger" },
            newuser: true,
          },
          { "x-cliq-webhook-secret": "s3cr3t" },
        ),
        res as unknown as any,
      );
      expect(res.statusCode).toBe(200);
      expect(sends).toHaveLength(0);
    } finally {
      restore();
    }
  });

  it("dedupes a redelivered welcome event (no double greeting)", async () => {
    const { webhook } = buildWelcomeRegistration({
      welcome: { enabled: true, text: "Hi", textRejoin: "Hi" },
      dmPolicy: "open",
    });
    const { sends, install } = mockFetchSends();
    const restore = install();
    try {
      const payload = {
        handler: "welcome",
        user: { id: "u1", name: "Jane" },
        newuser: true,
      };
      const res1 = createMockServerResponse();
      await webhook.handler(
        createMockIncomingRequest("POST", payload, {
          "x-cliq-webhook-secret": "s3cr3t",
        }),
        res1 as unknown as any,
      );
      const res2 = createMockServerResponse();
      await webhook.handler(
        createMockIncomingRequest("POST", payload, {
          "x-cliq-webhook-secret": "s3cr3t",
        }),
        res2 as unknown as any,
      );
      // First: greeted (1 send). Second: deduped (still 1 send total).
      expect(sends).toHaveLength(1);
      expect(res1.statusCode).toBe(200);
      expect(res2.statusCode).toBe(200);
    } finally {
      restore();
    }
  });

  it("rejects a welcome payload with no subscriber id as 400", async () => {
    const { webhook } = buildWelcomeRegistration({
      welcome: { enabled: true, text: "Hi", textRejoin: "Hi" },
      dmPolicy: "open",
    });
    const { sends, install } = mockFetchSends();
    const restore = install();
    try {
      const res = createMockServerResponse();
      await webhook.handler(
        createMockIncomingRequest(
          "POST",
          { handler: "welcome", user: { name: "NoId" } },
          { "x-cliq-webhook-secret": "s3cr3t" },
        ),
        res as unknown as any,
      );
      expect(res.statusCode).toBe(400);
      expect(sends).toHaveLength(0);
    } finally {
      restore();
    }
  });

  it("acks 200 even when the greeting send fails (never breaks the webhook)", async () => {
    const { webhook } = buildWelcomeRegistration({
      welcome: { enabled: true, text: "Hi", textRejoin: "Hi" },
      dmPolicy: "open",
    });
    const original = globalThis.fetch;
    globalThis.fetch = (async (url: URL | string) => {
      const urlStr = typeof url === "string" ? url : url.toString();
      if (urlStr.includes("/oauth/v2/token")) {
        return new Response(
          JSON.stringify({ access_token: "tok", expires_in: 3600 }),
          { status: 200 },
        );
      }
      // Bot-message send fails with a 500.
      return new Response("boom", { status: 500 });
    }) as typeof fetch;
    try {
      const res = createMockServerResponse();
      await webhook.handler(
        createMockIncomingRequest(
          "POST",
          {
            handler: "welcome",
            user: { id: "u1", name: "Jane" },
            newuser: true,
          },
          { "x-cliq-webhook-secret": "s3cr3t" },
        ),
        res as unknown as any,
      );
      expect(res.statusCode).toBe(200);
    } finally {
      globalThis.fetch = original;
    }
  });
});

describe("build configuration (issue #7: npm run build)", () => {  it("package.json exposes a build script invoking tsc -p tsconfig.build.json", () => {
    const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
    expect(typeof pkg.scripts.build).toBe("string");
    expect(pkg.scripts.build).toMatch(/tsc/);
    expect(pkg.scripts.build).toMatch(/tsconfig\.build\.json/);
  });

  it("tsconfig.build.json emits JS to dist/ and disables noEmit", () => {
    const cfg = JSON.parse(
      readFileSync(new URL("../tsconfig.build.json", import.meta.url), "utf8"),
    );
    expect(cfg.compilerOptions.noEmit).toBe(false);
    expect(cfg.compilerOptions.outDir).toBe("dist");
    expect(cfg.compilerOptions.allowImportingTsExtensions).toBe(false);
  });

  it("package.json main + exports point at the compiled dist output", () => {
    const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
    expect(pkg.main).toBe("./dist/index.js");
    expect(pkg.exports?.["."]?.default).toBe("./dist/index.js");
    expect(pkg.exports?.["./setup-entry"]?.default).toBe("./dist/setup-entry.js");
  });
});
