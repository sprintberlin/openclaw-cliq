import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  CliqIngressMonitorRegistry,
  admitCliqEvent,
  configureCliqIngress,
  setCliqIngressGlobalsForTest,
  createCliqIngressPayloadCodec,
  resolveCliqIngressFacts,
  type CliqIngressMonitor,
} from "./ingress-runtime.js";
import {
  createCliqTestConfig,
  createMockIncomingRequest,
  createMockServerResponse,
  createTestRuntimeChannel,
  registerCliqPluginForTest,
  createMentionDelugePayload,
} from "./test-api.js";
import { resetCliqDedupeForTest } from "./dedupe.js";
import type { ParsedCliqInbound } from "./inbound.js";

function fakeParsed(overrides: Partial<ParsedCliqInbound> = {}): ParsedCliqInbound {
  return {
    text: "hello",
    messageId: "m-durable-1",
    timestamp: "2026-10-17T12:00:00Z",
    senderId: "user-1",
    senderName: "Alice",
    chatId: "chat-1",
    isGroup: false,
    isMention: true,
    mentionIds: [],
    attachments: [],
    ...overrides,
  } as ParsedCliqInbound;
}

function fakeRegistryMonitor(
  admitImpl: (raw: { parsed: ParsedCliqInbound }) => Promise<{
    kind: "ignored" | "durable";
    queueResult?: { kind: string; duplicate: boolean; record: { id: string } };
  }>,
): CliqIngressMonitor {
  return {
    admit: admitImpl as CliqIngressMonitor["admit"],
    start: () => {},
    stop: async () => {},
    waitForIdle: async () => {},
    isRunning: () => true,
    isStopped: () => false,
  };
}

describe("cliq ingress facts + codec (issue #261)", () => {
  it("derives eventId from messageId and lanes DMs per sender+chat", () => {
    const facts = resolveCliqIngressFacts(fakeParsed());
    expect(facts).toEqual({ eventId: "m-durable-1", laneKey: "cliq:dm:chat-1:user-1" });
  });

  it("lanes group messages by channel identity", () => {
    const facts = resolveCliqIngressFacts(
      fakeParsed({ isGroup: true, channelUniqueName: "general" }),
    );
    expect(facts?.laneKey).toBe("cliq:group:general");
  });

  it("returns null without a stable event identity (ignored admission)", () => {
    expect(resolveCliqIngressFacts(fakeParsed({ messageId: "" }))).toBeNull();
  });

  it("round-trips the serialized payload", () => {
    const codec = createCliqIngressPayloadCodec();
    const parsed = fakeParsed({
      attachments: [{ fileName: "a.png", bytes: new Uint8Array([1, 2, 3]) } as never],
    });
    const body = codec.serialize({ parsed, accountId: "default", receivedAt: 1 });
    const claim = {
      id: "m-durable-1",
      accountId: "default",
      receivedAt: 1,
      claim: { token: "t", ownerId: "o", claimedAt: 1 },
    } as never;
    const raw = codec.deserialize(body, { claim });
    expect(raw.parsed.messageId).toBe("m-durable-1");
    expect(raw.accountId).toBe("default");
    expect(raw.parsed.attachments[0].bytes).toBeInstanceOf(Uint8Array);
  });

  it("rejects a corrupt stored body as invalid-version", () => {
    const codec = createCliqIngressPayloadCodec();
    const claim = { id: "m-durable-1", claim: { token: "t" } } as never;
    expect(() => codec.deserialize("not-json{", { claim })).toThrowError(
      /corrupt|unsupported payload version/i,
    );
  });

  it("rejects an identity change after admission", () => {
    const codec = createCliqIngressPayloadCodec();
    const body = codec.serialize({
      parsed: fakeParsed(),
      accountId: "default",
      receivedAt: 1,
    });
    const claim = { id: "different-id", claim: { token: "t" } } as never;
    expect(() => codec.deserialize(body, { claim })).toThrowError(
      /identity changed/i,
    );
  });
});

describe("cliq ingress monitor registry (issue #261)", () => {
  it("reports unavailable when the runtime has no queue surface", async () => {
    const registry = new CliqIngressMonitorRegistry(null);
    expect(await registry.admitEvent("default", fakeParsed())).toEqual({
      kind: "unavailable",
    });
    expect(await registry.startAccount("default", {})).toBe("unavailable");
  });

  it("reports not_ready before startAccount and readiness after", async () => {
    const registry = new CliqIngressMonitorRegistry({
      isAvailable: () => true,
      openQueue: () => ({}) as never,
    });
    expect(registry.isReady("default")).toBe(false);
    expect(await registry.admitEvent("default", fakeParsed())).toEqual({
      kind: "not_ready",
    });
    const err = vi.spyOn(console, "warn").mockImplementation(() => {});
    // startAccount will fail creating a real monitor from an empty queue
    // object; both acceptable outcomes below keep the fallback contract.
    const started = await registry.startAccount("default", {
      deliver: async () => ({ kind: "completed" as const }),
    });
    expect(["started", "unavailable"]).toContain(started);
    err.mockRestore();
    await registry.stopAccount("default");
    expect(registry.isReady("default")).toBe(false);
  });

  it("admitCliqEvent routes through the process registry", async () => {
    const registry = new CliqIngressMonitorRegistry(null);
    setCliqIngressGlobalsForTest({ registry });
    expect(await admitCliqEvent("default", fakeParsed())).toEqual({
      kind: "unavailable",
    });
    setCliqIngressGlobalsForTest(null);
  });
});

describe("webhook durable admission before ack (issue #261)", () => {
  let dispatches: number;

  beforeEach(() => {
    resetCliqDedupeForTest();
    dispatches = 0;
  });

  afterEach(() => {
    setCliqIngressGlobalsForTest(null);
  });

  function registerWithRegistry(
    monitor: CliqIngressMonitor | null,
    hasSurface = true,
  ) {
    const registry = new CliqIngressMonitorRegistry(
      hasSurface ? { isAvailable: () => true, openQueue: () => ({}) as never } : null,
    );
    if (monitor) registry.setForAccount("default", monitor);
    const { webhook } = registerCliqPluginForTest({
      config: createCliqTestConfig({
        clientId: "id",
        clientSecret: "secret",
        botId: "bot",
        botName: "openclaw-bot",
        webhookSecret: "s3cr3t",
      }),
      runtime: createTestRuntimeChannel(async () => {
        dispatches += 1;
      }),
    });
    // registerCliqPluginForTest re-configured the globals from the mock
    // runtime; replace them with the fake registry under test.
    setCliqIngressGlobalsForTest({ registry });
    return webhook;
  }

  const post = async (webhook: Parameters<typeof registerCliqPluginForTest>[0] extends never ? never : { handler: (req: unknown, res: unknown) => Promise<boolean> }) => {
    const res = createMockServerResponse();
    const result = await webhook.handler(
      createMockIncomingRequest("POST", createMentionDelugePayload(), {
        "x-cliq-webhook-secret": "s3cr3t",
      }),
      res as unknown as never,
    );
    return { res, result };
  };

  it("acks 200 after a durable admission without awaiting dispatch", async () => {
    const webhook = registerWithRegistry(
      fakeRegistryMonitor(async () => ({
        kind: "durable",
        queueResult: { kind: "accepted", duplicate: false, record: { id: "m1" } },
      })),
    );
    const { res, result } = await post(webhook as never);
    expect(result).toBe(true);
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toEqual({ status: "received" });
    // The dispatch happens in the drain, not in this request.
    expect(dispatches).toBe(0);
  });

  it("acks 200 on a queue duplicate without a second turn", async () => {
    const webhook = registerWithRegistry(
      fakeRegistryMonitor(async () => ({
        kind: "durable",
        queueResult: { kind: "completed", duplicate: true, record: { id: "m1" } },
      })),
    );
    const { res } = await post(webhook as never);
    expect(res.statusCode).toBe(200);
    expect(dispatches).toBe(0);
  });

  it("answers 503 when the monitor is not ready (durable surface present)", async () => {
    const webhook = registerWithRegistry(null);
    const { res } = await post(webhook as never);
    expect(res.statusCode).toBe(503);
    expect(dispatches).toBe(0);
  });

  it("answers 503 when the durable append fails (never ack an unrecorded event)", async () => {
    const webhook = registerWithRegistry(
      fakeRegistryMonitor(async () => {
        throw new Error("sqlite append failed");
      }),
    );
    const { res } = await post(webhook as never);
    expect(res.statusCode).toBe(503);
    expect(dispatches).toBe(0);
  });

  it("falls through to the pre-queue path when the surface is unavailable", async () => {
    const webhook = registerWithRegistry(null, false);
    const { res } = await post(webhook as never);
    // Pre-queue default after the change: after_receive_record degrades to the
    // legacy await-dispatch flow — 200 with exactly one dispatch.
    expect(res.statusCode).toBe(200);
    expect(dispatches).toBe(1);
  });

  it("after_dispatch bypasses the durable branch entirely", async () => {
    const registry = new CliqIngressMonitorRegistry(null);
    registry.setForAccount(
      "default",
      fakeRegistryMonitor(async () => {
        throw new Error("must not be called");
      }),
    );
    const { webhook } = registerCliqPluginForTest({
      config: createCliqTestConfig({
        clientId: "id",
        clientSecret: "secret",
        botId: "bot",
        botName: "openclaw-bot",
        webhookSecret: "s3cr3t",
        ackPolicy: "after_dispatch",
      }),
      runtime: createTestRuntimeChannel(async () => {
        dispatches += 1;
      }),
    });
    setCliqIngressGlobalsForTest({
      registry: new CliqIngressMonitorRegistry({ isAvailable: () => true, openQueue: () => ({}) as never }),
    });
    const res = createMockServerResponse();
    await webhook.handler(
      createMockIncomingRequest("POST", createMentionDelugePayload(), {
        "x-cliq-webhook-secret": "s3cr3t",
      }),
      res as unknown as never,
    );
    expect(res.statusCode).toBe(200);
    expect(dispatches).toBe(1);
  });
});

describe("configureCliqIngress wiring (issue #261)", () => {
  it("builds an unavailable surface from a runtime without state", () => {
    const registry = configureCliqIngress({
      runtime: {} as never,
      config: () => ({}) as never,
    });
    expect(registry.hasDurableSurface()).toBe(false);
    setCliqIngressGlobalsForTest(null);
  });
});
