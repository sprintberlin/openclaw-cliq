import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getChannelActivity } from "openclaw/plugin-sdk/infra-runtime";
import cliqEntry from "../index.js";
import { cliqPlugin } from "./channel.js";
import { resetCliqDedupeForTest } from "./dedupe.js";
import { setCliqDetachedWebhookWorkForTest } from "./detached-dispatch.js";
import { resetCliqPairingStoreCacheForTests } from "./pairing-store.js";
import { setCliqClientRegistry } from "./runtime-api.js";
import {
  createCliqTestConfig,
  createMockIncomingRequest,
  createMockServerResponse,
  createTestRuntimeChannel,
  registerCliqPluginForTest,
  createMentionDelugePayload,
  createDmDelugePayload,
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

  it("POST /cliq/webhook with configured account but no webhook secret → 503 without dispatch", async () => {
    let dispatches = 0;
    const { webhook, api } = registerCliqPluginForTest();
    api.config = createCliqTestConfig({
      clientId: "id",
      clientSecret: "***",
      botId: "bot",
      botName: "openclaw-bot",
    });
    api.runtime = createTestRuntimeChannel(async () => {
      dispatches += 1;
    });
    const res = createMockServerResponse();
    const result = await webhook.handler(
      createMockIncomingRequest("POST", createMentionDelugePayload()),
      res as unknown as any,
    );
    expect(result).toBe(true);
    expect(res.statusCode).toBe(503);
    expect(res.headers["Connection"]).toBe("close");
    expect(res.body).toBe("cliq webhook secret not configured");
    expect(dispatches).toBe(0);
  });

  it("POST /cliq/webhook with enabled:false → 503 without dispatch (issue #125)", async () => {
    let dispatches = 0;
    const { webhook, api } = registerCliqPluginForTest();
    api.config = createCliqTestConfig({
      enabled: false,
      clientId: "id",
      clientSecret: "***",
      botId: "bot",
      botName: "openclaw-bot",
      webhookSecret: "s3cr3t",
    });
    api.runtime = createTestRuntimeChannel(async () => {
      dispatches += 1;
    });
    const res = createMockServerResponse();
    const result = await webhook.handler(
      createMockIncomingRequest("POST", createMentionDelugePayload(), {
        "x-cliq-webhook-secret": "s3cr3t",
      }),
      res as unknown as any,
    );
    expect(result).toBe(true);
    expect(res.statusCode).toBe(503);
    expect(res.body).toBe("cliq channel disabled");
    expect(dispatches).toBe(0);
  });

  it("POST /cliq/webhook with configured secret but missing header → 401 without dispatch", async () => {
    let dispatches = 0;
    const { webhook, api } = registerCliqPluginForTest();
    api.config = createCliqTestConfig({
      clientId: "id",
      clientSecret: "***",
      botId: "bot",
      botName: "openclaw-bot",
      webhookSecret: "s3cr3t",
    });
    api.runtime = createTestRuntimeChannel(async () => {
      dispatches += 1;
    });
    const res = createMockServerResponse();
    const result = await webhook.handler(
      createMockIncomingRequest("POST", createMentionDelugePayload()),
      res as unknown as any,
    );
    expect(result).toBe(true);
    expect(res.statusCode).toBe(401);
    expect(res.body).toBe("unauthorized");
    expect(dispatches).toBe(0);
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

describe("inbound activity timestamps (issue #98)", () => {
  beforeEach(() => {
    resetCliqDedupeForTest();
  });

  function configuredRegistration(opts: {
    inboundRun?: () => Promise<unknown>;
    extra?: Record<string, unknown>;
  } = {}) {
    const { webhook, api } = registerCliqPluginForTest();
    api.config = createCliqTestConfig({
      clientId: "id",
      clientSecret: "secret",
      botId: "bot",
      botName: "openclaw-bot",
      webhookSecret: "s3cr3t",
      ...opts.extra,
    });
    api.runtime = createTestRuntimeChannel(opts.inboundRun ?? (async () => undefined));
    return webhook;
  }

  async function post(
    webhook: ReturnType<typeof registerCliqPluginForTest>["webhook"],
    payload: Record<string, unknown>,
    headers: Record<string, string> = { "x-cliq-webhook-secret": "s3cr3t" },
  ) {
    const res = createMockServerResponse();
    await webhook.handler(
      createMockIncomingRequest("POST", payload, headers),
      res as unknown as any,
    );
    return res;
  }

  it("records inbound after an accepted mention", async () => {
    const before = getChannelActivity({
      channel: "cliq",
      accountId: "default",
    }).inboundAt;
    if (before !== null) {
      await new Promise((resolve) => setTimeout(resolve, 2));
    }
    const webhook = configuredRegistration();
    const res = await post(webhook, createMentionDelugePayload());
    expect(res.statusCode).toBe(200);
    const after = getChannelActivity({
      channel: "cliq",
      accountId: "default",
    }).inboundAt;
    expect(after).toEqual(expect.any(Number));
    expect(after).not.toBe(before);
  });

  it("does not record inbound for a 401 (wrong secret)", async () => {
    const before = getChannelActivity({
      channel: "cliq",
      accountId: "default",
    }).inboundAt;
    const webhook = configuredRegistration();
    await post(webhook, createDmDelugePayload(), {
      "x-cliq-webhook-secret": "wrong",
    });
    expect(
      getChannelActivity({ channel: "cliq", accountId: "default" }).inboundAt,
    ).toBe(before);
  });

  it("does not record inbound for a 503 (unconfigured secret)", async () => {
    const before = getChannelActivity({
      channel: "cliq",
      accountId: "default",
    }).inboundAt;
    const { webhook, api } = registerCliqPluginForTest();
    api.config = createCliqTestConfig({
      clientId: "id",
      clientSecret: "secret",
      botId: "bot",
    });
    await post(webhook, createDmDelugePayload());
    expect(
      getChannelActivity({ channel: "cliq", accountId: "default" }).inboundAt,
    ).toBe(before);
  });

  it("does not record inbound for an authenticated probe", async () => {
    const before = getChannelActivity({
      channel: "cliq",
      accountId: "default",
    }).inboundAt;
    const webhook = configuredRegistration();
    const res = await post(webhook, {
      handler: "openclaw-probe",
      nonce: "n1",
    });
    expect(res.statusCode).toBe(200);
    expect(
      getChannelActivity({ channel: "cliq", accountId: "default" }).inboundAt,
    ).toBe(before);
  });

  it("does not record inbound for a self-message", async () => {
    const before = getChannelActivity({
      channel: "cliq",
      accountId: "default",
    }).inboundAt;
    const webhook = configuredRegistration();
    const res = await post(
      webhook,
      createDmDelugePayload({
        user: { id: "bot", name: "openclaw-bot" },
      }),
    );
    expect(res.statusCode).toBe(200);
    expect(
      getChannelActivity({ channel: "cliq", accountId: "default" }).inboundAt,
    ).toBe(before);
  });

  it("does not record inbound for a denied sender", async () => {
    const before = getChannelActivity({
      channel: "cliq",
      accountId: "default",
    }).inboundAt;
    const webhook = configuredRegistration({
      extra: { dmPolicy: "allowlist", allowFrom: ["someone-else"] },
    });
    const res = await post(webhook, createDmDelugePayload());
    expect(res.statusCode).toBe(200);
    expect(
      getChannelActivity({ channel: "cliq", accountId: "default" }).inboundAt,
    ).toBe(before);
  });

  it("does not record inbound for a dedupe replay", async () => {
    const webhook = configuredRegistration();
    const payload = createMentionDelugePayload();
    const first = await post(webhook, payload);
    expect(first.statusCode).toBe(200);
    const firstAt = getChannelActivity({
      channel: "cliq",
      accountId: "default",
    }).inboundAt;
    expect(firstAt).toEqual(expect.any(Number));

    const replay = await post(webhook, payload);
    expect(replay.statusCode).toBe(200);
    expect(
      getChannelActivity({ channel: "cliq", accountId: "default" }).inboundAt,
    ).toBe(firstAt);
  });
});

describe("organization boundary + group admission over the webhook (issues #100 / #103)", () => {
  beforeEach(() => {
    resetCliqDedupeForTest();
  });

  function registration(extra: Record<string, unknown> = {}) {
    const dispatched: unknown[] = [];
    const { webhook, api } = registerCliqPluginForTest();
    api.config = createCliqTestConfig({
      clientId: "id",
      clientSecret: "secret",
      botId: "bot",
      botName: "openclaw-bot",
      webhookSecret: "s3cr3t",
      dmPolicy: "open",
      ...extra,
    });
    api.runtime = createTestRuntimeChannel(async (...args: unknown[]) => {
      dispatched.push(args);
      return undefined;
    });
    return { webhook, dispatched };
  }

  async function post(
    webhook: ReturnType<typeof registerCliqPluginForTest>["webhook"],
    payload: Record<string, unknown>,
    headers: Record<string, string> = { "x-cliq-webhook-secret": "s3cr3t" },
  ) {
    const res = createMockServerResponse();
    await webhook.handler(
      createMockIncomingRequest("POST", payload, headers),
      res as unknown as any,
    );
    return res;
  }

  it("dispatches a DM that carries a matching organization id", async () => {
    const { webhook, dispatched } = registration();
    const res = await post(
      webhook,
      createDmDelugePayload({
        user: { id: "user-123", name: "Alice", organization_id: "org-1" },
      }),
    );
    expect(res.statusCode).toBe(200);
    expect(dispatched).toHaveLength(1);
  });

  it("dispatches a DM with NO organization id (documented compatibility policy)", async () => {
    const { webhook, dispatched } = registration();
    const res = await post(webhook, createDmDelugePayload());
    expect(res.statusCode).toBe(200);
    expect(dispatched).toHaveLength(1);
  });

  it("never dispatches a forged payload sent with the wrong secret", async () => {
    const { webhook, dispatched } = registration();
    const res = await post(
      webhook,
      createDmDelugePayload({
        user: { id: "attacker", organization_id: "org-1" },
      }),
      { "x-cliq-webhook-secret": "wrong" },
    );
    expect(res.statusCode).toBe(401);
    expect(dispatched).toHaveLength(0);
  });

  it("denies a group mention from a channel outside the group allowlist", async () => {
    const { webhook, dispatched } = registration({
      groupPolicy: "allowlist",
      groups: { "dev-team": {} },
    });
    const res = await post(
      webhook,
      createMentionDelugePayload({ channel: { unique_name: "random" } }),
    );
    expect(res.statusCode).toBe(200);
    expect(dispatched).toHaveLength(0);
  });

  it("admits a group mention from an allowlisted channel", async () => {
    const { webhook, dispatched } = registration({
      groupPolicy: "allowlist",
      groups: { general: {} },
    });
    const res = await post(webhook, createMentionDelugePayload());
    expect(res.statusCode).toBe(200);
    expect(dispatched).toHaveLength(1);
  });

  it("keeps legacy configs (no groupPolicy) admitting mentions unchanged", async () => {
    const { webhook, dispatched } = registration();
    const res = await post(webhook, createMentionDelugePayload());
    expect(res.statusCode).toBe(200);
    expect(dispatched).toHaveLength(1);
  });
});

describe("pairing approval sentinel over the webhook (issue #117)", () => {
  let stateDir: string;
  let previousStateDir: string | undefined;
  const sends: Array<{ to: string; text: string }> = [];

  beforeEach(() => {
    resetCliqDedupeForTest();
    resetCliqPairingStoreCacheForTests();
    sends.length = 0;
    // Isolate the plugin pairing store from the developer's real state dir,
    // and stub the outbound client so no case can reach a live Zoho endpoint.
    stateDir = mkdtempSync(join(tmpdir(), "cliq-pairing-webhook-state-"));
    previousStateDir = process.env.OPENCLAW_STATE_DIR;
    process.env.OPENCLAW_STATE_DIR = stateDir;
    setCliqClientRegistry({
      getOrCreate: () => ({
        sendMessage: async (opts: { to: string; text: string }) => {
          sends.push({ to: opts.to, text: opts.text });
          return { messageId: "stub" };
        },
        sendCard: async () => ({ messageId: "stub-card" }),
      }),
      setLogger: () => {},
    } as unknown as Parameters<typeof setCliqClientRegistry>[0]);
  });

  afterEach(() => {
    setCliqClientRegistry(null);
    resetCliqPairingStoreCacheForTests();
    if (previousStateDir === undefined) delete process.env.OPENCLAW_STATE_DIR;
    else process.env.OPENCLAW_STATE_DIR = previousStateDir;
    rmSync(stateDir, { recursive: true, force: true });
  });

  function pairingRegistration(opts: {
    inboundRun: () => Promise<unknown>;
    notifyOwnerTarget?: string;
  }) {
    const section: Record<string, unknown> = {
      clientId: "id",
      clientSecret: "secret",
      botId: "bot",
      botName: "openclaw-bot",
      webhookSecret: "s3cr3t",
      dmPolicy: "pairing",
      allowFrom: [],
    };
    if (opts.notifyOwnerTarget) {
      section.pairing = { notifyOwnerTarget: opts.notifyOwnerTarget };
    }
    return registerCliqPluginForTest({
      config: createCliqTestConfig(section),
      runtime: createTestRuntimeChannel(opts.inboundRun),
    });
  }

  function sentinelPayload(senderId: string, text: string) {
    return {
      handler: "dm",
      message: { text, id: `sentinel-${senderId}-${text}` },
      user: { id: senderId, name: senderId },
      chat: { id: "CT_dm", type: "single" },
    };
  }

  it("does not dispatch an agent turn for a sentinel click", async () => {
    let runCalled = 0;
    const { webhook } = pairingRegistration({
      inboundRun: async () => {
        runCalled += 1;
        return undefined;
      },
      notifyOwnerTarget: "user:owner-1",
    });

    const res = createMockServerResponse();
    await webhook.handler(
      createMockIncomingRequest(
        "POST",
        sentinelPayload("owner-1", "__cliq_pairing_approve__ SOMECODE"),
        { "x-cliq-webhook-secret": "s3cr3t" },
      ),
      res as unknown as any,
    );

    expect(res.statusCode).toBe(200);
    expect(runCalled).toBe(0);
  });

  it("rejects a non-owner sentinel click and never dispatches it as agent input", async () => {
    let runCalled = 0;
    const { webhook, api } = pairingRegistration({
      inboundRun: async () => {
        runCalled += 1;
        return undefined;
      },
      notifyOwnerTarget: "user:owner-1",
    });
    const warnings: string[] = [];
    api.logger.warn = (msg: string) => warnings.push(String(msg));

    const res = createMockServerResponse();
    await webhook.handler(
      createMockIncomingRequest(
        "POST",
        sentinelPayload("attacker", "__cliq_pairing_approve__ SOMECODE"),
        { "x-cliq-webhook-secret": "s3cr3t" },
      ),
      res as unknown as any,
    );

    expect(res.statusCode).toBe(200);
    expect(runCalled).toBe(0);
    expect(warnings.join(" ")).toContain("is not the configured owner");
    // The bot must not answer a forged sentinel: replying would let any
    // sender make it DM them on demand, ahead of the DM admission gate.
    expect(sends).toHaveLength(0);
  });

  it("rejects a sentinel click when no owner target is configured", async () => {
    let runCalled = 0;
    const { webhook, api } = pairingRegistration({
      inboundRun: async () => {
        runCalled += 1;
        return undefined;
      },
    });
    const warnings: string[] = [];
    api.logger.warn = (msg: string) => warnings.push(String(msg));

    const res = createMockServerResponse();
    await webhook.handler(
      createMockIncomingRequest(
        "POST",
        sentinelPayload("attacker", "__cliq_pairing_approve__ SOMECODE"),
        { "x-cliq-webhook-secret": "s3cr3t" },
      ),
      res as unknown as any,
    );

    expect(res.statusCode).toBe(200);
    expect(runCalled).toBe(0);
    expect(warnings.join(" ")).toContain("no pairing.notifyOwnerTarget configured");
    expect(sends).toHaveLength(0);
  });
});

describe("durable-before-ack ingest (issue #12)", () => {
  beforeEach(() => {
    resetCliqDedupeForTest();
  });

  afterEach(() => {
    setCliqDetachedWebhookWorkForTest(undefined);
  });

  function buildDurableRegistration(opts: {
    inboundRun: (...args: unknown[]) => Promise<unknown>;
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

  it("acks 200 on a 'reply session initialization conflicted' dispatch error (issue #84)", async () => {
    let runCalled = 0;
    const { webhook } = buildDurableRegistration({
      inboundRun: async () => {
        runCalled++;
        throw new Error(
          "reply session initialization conflicted for agent:martin:cliq:direct:dm:20098819618",
        );
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
    // Acked 200 (not 500) so Cliq stops retrying instead of storming the conflict.
    expect(res.statusCode).toBe(200);
    expect(res.body).toBe("ok");
  });

  it("dedupes a redelivered caption-less file message — second POST acks 200 without a second dispatch (issue #84)", async () => {
    let runCalled = 0;
    const { webhook } = buildDurableRegistration({
      inboundRun: async () => {
        runCalled++;
        return undefined;
      },
    });
    // Group mention with a name-only attachment so admission allows it and
    // the dedupe key falls back to sender:chat:file:<names> (no messageId).
    const filePayload = {
      handler: "mention",
      message: "",
      user: { id: "u1", name: "Alice" },
      chat: {
        id: "CT_channel",
        type: "channel",
        chat_type: "channel",
        channel_unique_name: "dev-team",
        title: "#dev-team",
      },
      mentions: [{ id: "bot", name: "openclaw-bot", type: "bot" }],
      attachments: ["2020_03.png"],
    };
    const res1 = createMockServerResponse();
    await webhook.handler(
      createMockIncomingRequest("POST", filePayload, {
        "x-cliq-webhook-secret": "s3cr3t",
      }),
      res1 as unknown as any,
    );
    expect(res1.statusCode).toBe(200);
    expect(runCalled).toBe(1);
    // Cliq redelivers the same upload ~20s later.
    const res2 = createMockServerResponse();
    await webhook.handler(
      createMockIncomingRequest("POST", filePayload, {
        "x-cliq-webhook-secret": "s3cr3t",
      }),
      res2 as unknown as any,
    );
    expect(res2.statusCode).toBe(200);
    // No second dispatch — deduped as duplicate/inflight.
    expect(runCalled).toBe(1);
  });

  it("dispatches an identical slash command sent again after the content dedupe window (issue #114)", async () => {
    let runCalled = 0;
    const { webhook } = buildDurableRegistration({
      inboundRun: async () => {
        runCalled++;
        return undefined;
      },
    });
    const commandPayload = {
      handler: "mention",
      message: "/status",
      user: { id: "fake-user", name: "Test User" },
      chat: {
        id: "CT_channel",
        type: "channel",
        chat_type: "channel",
        channel_unique_name: "dev-team",
        title: "#dev-team",
      },
      mentions: [{ id: "bot", name: "openclaw-bot", type: "bot" }],
    };

    const first = createMockServerResponse();
    await webhook.handler(
      createMockIncomingRequest("POST", commandPayload, {
        "x-cliq-webhook-secret": "s3cr3t",
      }),
      first as unknown as any,
    );
    expect(first.statusCode).toBe(200);
    expect(runCalled).toBe(1);

    const redelivery = createMockServerResponse();
    await webhook.handler(
      createMockIncomingRequest("POST", commandPayload, {
        "x-cliq-webhook-secret": "s3cr3t",
      }),
      redelivery as unknown as any,
    );
    expect(redelivery.statusCode).toBe(200);
    expect(runCalled).toBe(1);

    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date(Date.now() + 5 * 60 * 1000));
      const resend = createMockServerResponse();
      await webhook.handler(
        createMockIncomingRequest("POST", commandPayload, {
          "x-cliq-webhook-secret": "s3cr3t",
        }),
        resend as unknown as any,
      );
      expect(resend.statusCode).toBe(200);
      expect(runCalled).toBe(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("dispatches two identical /new commands when each has its own eventId (issue #196)", async () => {
    const sids: string[] = [];
    let runCalled = 0;
    const { webhook } = buildDurableRegistration({
      inboundRun: async (...args: unknown[]) => {
        runCalled++;
        const params = args[0] as { raw?: { messageId?: string } } | undefined;
        if (params?.raw?.messageId) sids.push(params.raw.messageId);
        return undefined;
      },
    });
    const firstPayload = {
      handler: "mention",
      message: "/new",
      eventId: "delivery-1",
      user: { id: "fake-user", name: "Test User" },
      chat: {
        id: "CT_channel",
        type: "channel",
        chat_type: "channel",
        channel_unique_name: "dev-team",
        title: "#dev-team",
      },
      mentions: [{ id: "bot", name: "openclaw-bot", type: "bot" }],
    };
    const secondPayload = { ...firstPayload, eventId: "delivery-2" };

    const first = createMockServerResponse();
    await webhook.handler(
      createMockIncomingRequest("POST", firstPayload, {
        "x-cliq-webhook-secret": "s3cr3t",
      }),
      first as unknown as any,
    );
    const replay = createMockServerResponse();
    await webhook.handler(
      createMockIncomingRequest("POST", firstPayload, {
        "x-cliq-webhook-secret": "s3cr3t",
      }),
      replay as unknown as any,
    );
    const second = createMockServerResponse();
    await webhook.handler(
      createMockIncomingRequest("POST", secondPayload, {
        "x-cliq-webhook-secret": "s3cr3t",
      }),
      second as unknown as any,
    );
    expect(first.statusCode).toBe(200);
    expect(replay.statusCode).toBe(200);
    expect(second.statusCode).toBe(200);
    expect(runCalled).toBe(2);
    expect(sids).toEqual(["evt:delivery-1", "evt:delivery-2"]);
  });

  it("dispatches two identical /new commands from a params-wrapped eventId (issue #204)", async () => {
    const sids: string[] = [];
    let runCalled = 0;
    const { webhook } = buildDurableRegistration({
      inboundRun: async (...args: unknown[]) => {
        runCalled++;
        const params = args[0] as { raw?: { messageId?: string } } | undefined;
        if (params?.raw?.messageId) sids.push(params.raw.messageId);
        return undefined;
      },
    });
    const firstPayload = {
      handler: "mention",
      mentions: [{ id: "bot", name: "openclaw-bot", type: "bot" }],
      params: {
        message: { text: "/new" },
        eventId: "wrapped-1",
        user: { id: "fake-user", name: "Test User" },
        chat: {
          id: "CT_channel",
          type: "channel",
          chat_type: "channel",
          channel_unique_name: "dev-team",
          title: "#dev-team",
        },
      },
    };
    const replayPayload = firstPayload;
    const secondPayload = {
      handler: "mention",
      mentions: [{ id: "bot", name: "openclaw-bot", type: "bot" }],
      params: {
        message: { text: "/new" },
        eventId: "wrapped-2",
        user: { id: "fake-user", name: "Test User" },
        chat: {
          id: "CT_channel",
          type: "channel",
          chat_type: "channel",
          channel_unique_name: "dev-team",
          title: "#dev-team",
        },
      },
    };

    const first = createMockServerResponse();
    await webhook.handler(
      createMockIncomingRequest("POST", firstPayload, {
        "x-cliq-webhook-secret": "s3cr3t",
      }),
      first as unknown as any,
    );
    const replay = createMockServerResponse();
    await webhook.handler(
      createMockIncomingRequest("POST", replayPayload, {
        "x-cliq-webhook-secret": "s3cr3t",
      }),
      replay as unknown as any,
    );
    const second = createMockServerResponse();
    await webhook.handler(
      createMockIncomingRequest("POST", secondPayload, {
        "x-cliq-webhook-secret": "s3cr3t",
      }),
      second as unknown as any,
    );
    expect(first.statusCode).toBe(200);
    expect(replay.statusCode).toBe(200);
    expect(second.statusCode).toBe(200);
    expect(runCalled).toBe(2);
    expect(sids).toEqual(["evt:wrapped-1", "evt:wrapped-2"]);
  });

  it("acks 200 (not 400) for a caption-less image with attachments forwarded (issue #84)", async () => {
    const { webhook } = buildDurableRegistration({
      inboundRun: async () => undefined,
    });
    const res = createMockServerResponse();
    await webhook.handler(
      createMockIncomingRequest(
        "POST",
        {
          handler: "mention",
          message: "",
          user: { id: "u1", name: "Alice" },
          chat: {
            id: "CT_channel",
            type: "channel",
            chat_type: "channel",
            channel_unique_name: "dev-team",
            title: "#dev-team",
          },
          mentions: [{ id: "bot", name: "openclaw-bot", type: "bot" }],
          attachments: ["2020_03.png"],
        },
        { "x-cliq-webhook-secret": "s3cr3t" },
      ),
      res as unknown as any,
    );
    // Previously this was 400 invalid payload; now it dispatches with a
    // synthesized <file: name> body.
    expect(res.statusCode).toBe(200);
  });

  it("ackPolicy=immediate acks 200 without awaiting dispatch", async () => {
    setCliqDetachedWebhookWorkForTest(null);
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

  it("ackPolicy=immediate wraps the dispatch in runDetachedWebhookWork before acking (issue #122)", async () => {
    const events: string[] = [];
    let runResolved = false;
    setCliqDetachedWebhookWorkForTest((work) => {
      events.push("detached-called");
      return Promise.resolve().then(() => {
        events.push("detached-work-started");
        return work();
      });
    });
    const { webhook } = buildDurableRegistration({
      ackPolicy: "immediate",
      inboundRun: async () => {
        events.push("dispatch-started");
        await new Promise((r) => setTimeout(r, 50));
        runResolved = true;
      },
    });
    const res = createMockServerResponse();
    res.onEnd = () => events.push("acked");
    await webhook.handler(
      createMockIncomingRequest("POST", mentionPayload, {
        "x-cliq-webhook-secret": "s3cr3t",
      }),
      res as unknown as any,
    );

    // The admission root must be reserved while the request is still
    // admitted — i.e. BEFORE the 200 is written.
    expect(events.indexOf("detached-called")).toBeGreaterThanOrEqual(0);
    expect(events.indexOf("detached-called")).toBeLessThan(events.indexOf("acked"));
    expect(events.indexOf("detached-work-started")).toBeGreaterThan(events.indexOf("acked"));
    expect(events).not.toContain("dispatch-started");
    await vi.waitFor(() => expect(events).toContain("dispatch-started"));
    // Still ack-first: the dispatch has not resolved when we responded.
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toEqual({ status: "received" });
    expect(runResolved).toBe(false);

    await new Promise((r) => setTimeout(r, 80));
    expect(runResolved).toBe(true);
  });

  it("ackPolicy=immediate still acks and dispatches when the helper is absent", async () => {
    let runStarted = false;
    let runResolved = false;
    setCliqDetachedWebhookWorkForTest(null);
    const { webhook } = buildDurableRegistration({
      ackPolicy: "immediate",
      inboundRun: async () => {
        runStarted = true;
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
    expect(JSON.parse(res.body)).toEqual({ status: "received" });
    expect(runResolved).toBe(false);

    await new Promise((r) => setTimeout(r, 80));
    expect(runResolved).toBe(true);
  });

  it("ackPolicy=immediate still acks 200 when the detached helper itself throws", async () => {
    setCliqDetachedWebhookWorkForTest(() => {
      throw new Error("admission root unavailable");
    });
    let runStarted = false;
    const { webhook } = buildDurableRegistration({
      ackPolicy: "immediate",
      inboundRun: async () => {
        runStarted = true;
      },
    });
    const res = createMockServerResponse();
    await webhook.handler(
      createMockIncomingRequest("POST", mentionPayload, {
        "x-cliq-webhook-secret": "s3cr3t",
      }),
      res as unknown as any,
    );
    // A failing helper must never turn into a 500 for Cliq; the dispatch
    // still ran on the inherited chain.
    expect(runStarted).toBe(true);
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toEqual({ status: "received" });
    await new Promise((r) => setTimeout(r, 20));
  });

  it("after_dispatch never uses the detached helper and still 500s on dispatch failure", async () => {
    let detachedCalls = 0;
    setCliqDetachedWebhookWorkForTest((work) => {
      detachedCalls++;
      return work();
    });
    const { webhook } = buildDurableRegistration({
      inboundRun: async () => {
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
    expect(detachedCalls).toBe(0);
    expect(res.statusCode).toBe(500);
    expect(res.body).toBe("dispatch failed");
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

describe("default-visible inbound skip logging (issue #232)", () => {
  beforeEach(() => {
    resetCliqDedupeForTest();
  });

  /**
   * Register the plugin with a logger that records every `warn` line, so a
   * test can assert what an operator sees at the DEFAULT log level. `debug`
   * is deliberately captured separately: the whole point of #232 is that
   * these outcomes must NOT be debug-only.
   */
  function registrationWithLogs(opts: {
    inboundRun?: () => Promise<unknown>;
    extra?: Record<string, unknown>;
  } = {}) {
    const warns: string[] = [];
    const debugs: string[] = [];
    const { webhook, api } = registerCliqPluginForTest({
      logger: {
        warn: (m: string) => warns.push(m),
        debug: (m: string) => debugs.push(m),
      },
    });
    api.config = createCliqTestConfig({
      clientId: "id",
      clientSecret: "secret",
      botId: "bot",
      botName: "openclaw-bot",
      webhookSecret: "s3cr3t",
      ...opts.extra,
    });
    api.runtime = createTestRuntimeChannel(opts.inboundRun ?? (async () => undefined));
    return { webhook, warns, debugs };
  }

  async function post(
    webhook: ReturnType<typeof registerCliqPluginForTest>["webhook"],
    payload: unknown,
    headers: Record<string, string> = { "x-cliq-webhook-secret": "s3cr3t" },
  ) {
    const res = createMockServerResponse();
    await webhook.handler(
      createMockIncomingRequest("POST", payload as Record<string, unknown>, headers),
      res as unknown as any,
    );
    return res;
  }

  function skipLines(warns: string[]): string[] {
    return warns.filter((line) => line.startsWith("[cliq] inbound skipped:"));
  }

  it("logs a self-message skip at warn without leaking the matched value", async () => {
    // Self-protection runs before admission, so the default policy is fine.
    const { webhook, warns } = registrationWithLogs();
    const res = await post(
      webhook,
      createDmDelugePayload({ user: { id: "bot", name: "openclaw-bot" } }),
    );
    expect(res.statusCode).toBe(200);
    const lines = skipLines(warns);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("self");
    expect(lines[0]).toContain("matched_field=");
    // The matched VALUE is user-controlled (display name / email) and must
    // never reach a default-level log line.
    expect(lines[0]).not.toContain("openclaw-bot");
  });

  it("logs a dedupe skip at warn on redelivery", async () => {
    // `dmPolicy: "open"` so the message reaches the dedupe gate; the default
    // policy would stop it earlier at admission.
    const { webhook, warns } = registrationWithLogs({
      extra: { dmPolicy: "open" },
    });
    const payload = createDmDelugePayload();
    const first = await post(webhook, payload);
    expect(first.statusCode).toBe(200);
    // Same message id → the second delivery is a dedupe hit, which is exactly
    // what a lost message looks like from the Zoho execution log.
    const second = await post(webhook, payload);
    expect(second.statusCode).toBe(200);
    const lines = skipLines(warns);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatch(/duplicate|inflight/);
    expect(lines[0]).toContain("message=");
  });

  it("logs a denied sender as not_admitted", async () => {
    const { webhook, warns } = registrationWithLogs({
      extra: { dmPolicy: "allowlist", allowFrom: ["someone-else"] },
    });
    const res = await post(webhook, createDmDelugePayload());
    expect(res.statusCode).toBe(200);
    const lines = skipLines(warns);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("not_admitted");
    expect(lines[0]).toContain("sender=user-123");
  });

  it("logs an unmentioned group message as not_mentioned", async () => {
    const { webhook, warns } = registrationWithLogs();
    const res = await post(
      webhook,
      createMentionDelugePayload({
        message: { text: "no mention here", id: "m-nm", time: "2026-07-04T10:00:00Z" },
        mentions: [],
        handler: "message",
      }),
    );
    expect(res.statusCode).toBe(200);
    const lines = skipLines(warns);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("not_mentioned");
    // The message body must not appear in the operator log.
    expect(lines[0]).not.toContain("no mention here");
  });

  it("logs an unparseable payload as parser_rejected", async () => {
    const { webhook, warns } = registrationWithLogs();
    const res = await post(webhook, { user: { id: "u1" }, chat: { id: "c1" } });
    expect(res.statusCode).toBe(400);
    const lines = skipLines(warns);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("parser_rejected");
  });

  it("emits exactly one skip line and none for an accepted message", async () => {
    const { webhook, warns } = registrationWithLogs({
      extra: { dmPolicy: "open" },
    });
    const res = await post(webhook, createDmDelugePayload({ message: { text: "hi", id: "ok-1" } }));
    expect(res.statusCode).toBe(200);
    // A dispatched message is not a skip: the vocabulary must stay a reliable
    // signal that NO agent turn happened.
    expect(skipLines(warns)).toHaveLength(0);
  });
});
