import { describe, it, expect } from "vitest";
import cliqEntry from "../index.js";
import {
  createCliqTestConfig,
  createMockIncomingRequest,
  createMockServerResponse,
  createTestRuntimeChannel,
  registerCliqPluginForTest,
  createTestPluginApi,
  createMentionDelugePayload,
  createDmDelugePayload,
} from "./test-api.js";

describe("test-api contract surface", () => {
  it("createCliqTestConfig wraps a section under channels.cliq", () => {
    const cfg = createCliqTestConfig({ clientId: "id" });
    expect(cfg).toEqual({
      channels: { cliq: { clientId: "id" } },
    });
  });

  it("createMockServerResponse captures status, headers, body, ended", () => {
    const res = createMockServerResponse();
    res.statusCode = 201;
    res.setHeader("X-Test", "yes");
    res.end("hello");
    expect(res.statusCode).toBe(201);
    expect(res.headers["X-Test"]).toBe("yes");
    expect(res.body).toBe("hello");
    expect(res.ended).toBe(true);
  });

  it("createMockIncomingRequest emits data + end for a JSON body", async () => {
    const req = createMockIncomingRequest("POST", { hello: "world" });
    const chunks: Buffer[] = [];
    let ended = false;
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      ended = true;
    });
    await new Promise((r) => setTimeout(r, 10));
    expect(ended).toBe(true);
    expect(JSON.parse(Buffer.concat(chunks).toString("utf8"))).toEqual({
      hello: "world",
    });
  });

  it("createMockIncomingRequest passes a string body through verbatim", async () => {
    const req = createMockIncomingRequest("GET", "raw-text");
    const chunks: Buffer[] = [];
    let ended = false;
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      ended = true;
    });
    await new Promise((r) => setTimeout(r, 10));
    expect(ended).toBe(true);
    expect(Buffer.concat(chunks).toString("utf8")).toBe("raw-text");
  });

  it("createTestPluginApi captures routes + collectors without registering", () => {
    const reg = createTestPluginApi();
    expect(reg.routes).toEqual([]);
    expect(reg.securityAuditCollectors).toEqual([]);
    expect(reg.registeredChannel()).toBe(false);
    expect(reg.cliRegistered()).toBe(false);
    expect(reg.api.registrationMode).toBe("full");
  });

  it("registerCliqPluginForTest registers channel + cli + webhook route + collector", () => {
    const reg = registerCliqPluginForTest();
    expect(reg.registeredChannel()).toBe(true);
    expect(reg.cliRegistered()).toBe(true);
    expect(reg.webhook.path).toBe("/cliq/webhook");
    expect(reg.webhook.auth).toBe("plugin");
    expect(typeof reg.webhook.handler).toBe("function");
    expect(reg.securityAuditCollectors).toHaveLength(1);
  });

  it("registerCliqPluginForTest({ register: false }) does not invoke entry.register", () => {
    const reg = registerCliqPluginForTest({ register: false });
    expect(reg.registeredChannel()).toBe(false);
    expect(reg.cliRegistered()).toBe(false);
    expect(reg.webhook).toBeUndefined();
  });

  it("createTestRuntimeChannel exposes the channel surface the dispatch path reads", () => {
    let called = 0;
    const runtime = createTestRuntimeChannel(async () => {
      called++;
    });
    const channel = (runtime as { channel: Record<string, unknown> }).channel;
    expect(typeof channel.inbound).toBe("object");
    expect(typeof channel.routing).toBe("object");
    expect(typeof channel.session).toBe("object");
    expect(typeof channel.reply).toBe("object");
  });

  it("createMentionDelugePayload returns a group mention payload, overridable", () => {
    const base = createMentionDelugePayload();
    expect((base.chat as { type: string }).type).toBe("channel");
    expect((base.handler as string)).toBe("mention");
    expect(Array.isArray(base.mentions)).toBe(true);
    const custom = createMentionDelugePayload({ handler: "openclaw-bot" });
    expect((custom.handler as string)).toBe("openclaw-bot");
  });

  it("createDmDelugePayload returns a single-chat DM payload, overridable", () => {
    const base = createDmDelugePayload();
    expect((base.chat as { type: string }).type).toBe("single");
    expect((base.handler as string)).toBe("dm");
    const custom = createDmDelugePayload({ user: { id: "u2" } });
    expect((custom.user as { id: string }).id).toBe("u2");
  });

  it("end-to-end: configured webhook returns 200 received using the full harness", async () => {
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
    const result = await webhook.handler(
      createMockIncomingRequest("POST", createMentionDelugePayload(), {
        "x-cliq-webhook-secret": "s3cr3t",
      }),
      res as unknown as any,
    );
    expect(result).toBe(true);
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toEqual({ status: "received" });
  });

  it("entry.register is the same function cliqEntry exposes", () => {
    expect(typeof cliqEntry.register).toBe("function");
  });
});
