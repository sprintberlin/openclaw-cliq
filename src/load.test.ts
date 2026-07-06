import { describe, expect, it, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import cliqEntry from "../index.js";
import { cliqPlugin } from "./channel.js";
import { resetCliqDedupeForTest } from "./dedupe.js";
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

describe("build configuration (issue #7: npm run build)", () => {
  it("package.json exposes a build script invoking tsc -p tsconfig.build.json", () => {
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
