import { describe, expect, it } from "vitest";
import { EventEmitter } from "node:events";
import cliqEntry from "../index.js";
import { cliqPlugin } from "./channel.js";

type CapturedRoute = {
  path: string;
  auth: string;
  handler: (req: any, res: any) => Promise<boolean | void> | boolean | void;
};

interface IncomingLike {
  method?: string;
  headers?: Record<string, string | string[] | undefined>;
  on(event: "data" | "end" | "error", listener: (...args: any[]) => void): this;
  removeAllListeners(): this;
  destroy(): void;
}

interface ResLike {
  statusCode?: number;
  headers: Record<string, string | string[]>;
  body: string;
  ended: boolean;
  setHeader(name: string, value: string | string[]): void;
  end(chunk?: string): void;
}

function makeRes(): ResLike {
  return {
    headers: {},
    body: "",
    ended: false,
    setHeader(name, value) {
      this.headers[name] = value;
    },
    end(chunk) {
      if (chunk !== undefined) this.body += chunk;
      this.ended = true;
    },
  };
}

function makeReq(
  method: string,
  body: unknown,
  headers: Record<string, string | string[] | undefined> = {},
): IncomingLike {
  const ee = new EventEmitter() as EventEmitter & IncomingLike & { destroy(): void };
  ee.method = method;
  ee.headers = headers;
  // Keep the native EventEmitter `removeAllListeners` / `on` — readJsonBody
  // relies on them and overriding them naively causes infinite recursion.
  ee.destroy = () => {
    /* no-op */
  };
  queueMicrotask(() => {
    const raw = typeof body === "string" ? body : JSON.stringify(body);
    ee.emit("data", Buffer.from(raw, "utf8"));
    ee.emit("end");
  });
  return ee as IncomingLike;
}

function buildMockApi() {
  const routes: CapturedRoute[] = [];
  let registeredChannel = false;
  let cliRegistered = false;
  const api = {
    registrationMode: "full" as const,
    config: {} as Record<string, unknown>,
    logger: {
      warn: () => {},
      error: () => {},
      info: () => {},
      debug: () => {},
    },
    runtime: {} as Record<string, unknown>,
    registerChannel: () => {
      registeredChannel = true;
    },
    registerCli: () => {
      cliRegistered = true;
    },
    registerHttpRoute: (params: CapturedRoute) => {
      routes.push(params);
    },
  };
  return { api, routes, isRegistered: () => registeredChannel, cliRegistered: () => cliRegistered };
}

describe("plugin entry load + /cliq/webhook smoke", () => {
  it("exports a DefinedChannelPluginEntry for channel id 'cliq'", () => {
    expect(cliqEntry).toBeTruthy();
    expect(cliqEntry.id).toBe("cliq");
    expect(cliqEntry.name).toBe("Zoho Cliq");
    expect(typeof cliqEntry.description).toBe("string");
    expect(cliqEntry.channelPlugin).toBe(cliqPlugin);
    expect(typeof cliqEntry.register).toBe("function");
  });

  it("register() wires channel registration, cli metadata, and the /cliq/webhook route", () => {
    const { api, routes, isRegistered, cliRegistered } = buildMockApi();
    cliqEntry.register(api as any);
    expect(isRegistered()).toBe(true);
    expect(cliRegistered()).toBe(true);
    const webhook = routes.find((r) => r.path === "/cliq/webhook");
    expect(webhook).toBeTruthy();
    expect(webhook!.auth).toBe("plugin");
    expect(typeof webhook!.handler).toBe("function");
  });

  it("GET /cliq/webhook → 405 Method Not Allowed (Allow: POST)", async () => {
    const { api, routes } = buildMockApi();
    cliqEntry.register(api as any);
    const webhook = routes.find((r) => r.path === "/cliq/webhook")!;
    const res = makeRes();
    const result = await webhook.handler(makeReq("GET", ""), res as unknown as any);
    expect(result).toBe(true);
    expect(res.statusCode).toBe(405);
    expect(res.headers["Allow"]).toBe("POST");
    expect(res.body).toBe("Method Not Allowed");
    expect(res.ended).toBe(true);
  });

  it("POST /cliq/webhook with dummy Deluge payload but unconfigured channel → 503 (acceptable HTTP response)", async () => {
    const { api, routes } = buildMockApi();
    cliqEntry.register(api as any);
    const webhook = routes.find((r) => r.path === "/cliq/webhook")!;
    const res = makeRes();
    const payload = {
      message: { text: "hello from cliq", id: "m1", time: "2026-07-04T10:00:00Z" },
      user: { id: "user-123", name: "Alice", email: "alice@example.com" },
      chat: { id: "chat-1-B", type: "channel" },
      channel: { unique_name: "general" },
      handler: "openclaw-bot",
    };
    const result = await webhook.handler(
      makeReq("POST", payload),
      res as unknown as any,
    );
    expect(result).toBe(true);
    expect(res.ended).toBe(true);
    expect(res.statusCode).toBe(503);
    expect(res.body).toBe("cliq not configured");
  });

  it("POST /cliq/webhook with configured account + valid secret + dummy payload → 200 received", async () => {
    const { api, routes } = buildMockApi();
    api.config = {
      channels: {
        cliq: {
          clientId: "id",
          clientSecret: "secret",
          botId: "bot",
          botName: "openclaw-bot",
          webhookSecret: "s3cr3t",
        },
      },
    };
    api.runtime = {
      channel: {
        routing: {
          resolveAgentRoute: () => ({ agentId: "agent-1", sessionKey: "sess-1" }),
        },
        session: {
          resolveStorePath: () => "/store/agent-1",
          readSessionUpdatedAt: () => undefined,
          recordInboundSession: () => undefined,
        },
        reply: {
          resolveEnvelopeFormatOptions: () => ({}),
          formatAgentEnvelope: () => "envelope text",
          finalizeInboundContext: () => ({}),
          dispatchReplyWithBufferedBlockDispatcher: async () => undefined,
        },
        inbound: {
          run: async () => undefined,
        },
      },
    };
    cliqEntry.register(api as any);
    const webhook = routes.find((r) => r.path === "/cliq/webhook")!;
    const res = makeRes();
    const payload = {
      message: { text: "@openclaw-bot hello", id: "m1", time: "2026-07-04T10:00:00Z" },
      user: { id: "user-123", name: "Alice", email: "alice@example.com" },
      chat: { id: "chat-1-B", type: "channel" },
      channel: { unique_name: "general" },
      mentions: [{ id: "bot", type: "bot" }],
      handler: "mention",
    };
    const result = await webhook.handler(
      makeReq("POST", payload, { "x-cliq-webhook-secret": "s3cr3t" }),
      res as unknown as any,
    );
    expect(result).toBe(true);
    expect(res.ended).toBe(true);
    expect(res.statusCode).toBe(200);
    expect(res.headers["Content-Type"]).toBe("application/json");
    expect(JSON.parse(res.body)).toEqual({ status: "received" });
  });

  it("POST /cliq/webhook with wrong secret → 401 unauthorized", async () => {
    const { api, routes } = buildMockApi();
    api.config = {
      channels: {
        cliq: {
          clientId: "id",
          clientSecret: "secret",
          botId: "bot",
          botName: "openclaw-bot",
          webhookSecret: "s3cr3t",
        },
      },
    };
    cliqEntry.register(api as any);
    const webhook = routes.find((r) => r.path === "/cliq/webhook")!;
    const res = makeRes();
    const result = await webhook.handler(
      makeReq("POST", { message: "x" }, { "x-cliq-webhook-secret": "wrong" }),
      res as unknown as any,
    );
    expect(result).toBe(true);
    expect(res.statusCode).toBe(401);
    expect(res.body).toBe("unauthorized");
  });
});
