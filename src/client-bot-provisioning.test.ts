import { afterEach, describe, expect, it } from "vitest";
import { CliqClient } from "./client.js";

interface CapturedRequest {
  url: URL;
  method: string;
  body?: string;
}

function installFetch(
  handler: (request: CapturedRequest, call: number) => Response,
): { requests: CapturedRequest[]; restore: () => void } {
  const original = globalThis.fetch;
  const requests: CapturedRequest[] = [];
  let call = 0;
  globalThis.fetch = (async (input: URL | string, init?: RequestInit) => {
    const url = new URL(typeof input === "string" ? input : input.toString());
    if (url.pathname === "/oauth/v2/token") {
      return new Response(JSON.stringify({ access_token: "token", expires_in: 3600 }), {
        status: 200,
      });
    }
    const request = {
      url,
      method: init?.method ?? "GET",
      body: typeof init?.body === "string" ? init.body : undefined,
    };
    requests.push(request);
    call++;
    return handler(request, call);
  }) as typeof fetch;
  return { requests, restore: () => { globalThis.fetch = original; } };
}

afterEach(() => {
  globalThis.fetch = globalThis.fetch;
});

describe("CliqClient bot/handler provisioning API", () => {
  it("creates an organization bot without sending a unique_name", async () => {
    const mock = installFetch(() => new Response(JSON.stringify({
      data: { id: "b-1", unique_name: "franzi", name: "Franzi" },
    }), { status: 201 }));
    const client = new CliqClient("id", "secret", "franzi");
    try {
      const result = await client.createBot("Franzi");
      expect(result).toEqual({
        ok: true,
        bot: { id: "b-1", unique_name: "franzi", name: "Franzi" },
      });
    } finally {
      mock.restore();
    }
    expect(mock.requests[0].url.pathname).toBe("/api/v3/bots");
    expect(mock.requests[0].method).toBe("POST");
    const body = JSON.parse(mock.requests[0].body!) as {
      name?: unknown;
      scope?: unknown;
      description?: unknown;
      unique_name?: unknown;
    };
    expect(body).toEqual({
      name: "Franzi",
      scope: "organization",
      description: "OpenClaw channel bot",
    });
    expect(typeof body.description).toBe("string");
    expect((body.description as string).trim().length).toBeGreaterThan(0);
    expect(body).not.toHaveProperty("unique_name");
    expect(mock.requests[0].body).not.toContain("unique_name");
  });

  it("creates a handler through the collection route with type and script", async () => {
    const mock = installFetch(() => new Response("{}", { status: 201 }));
    const client = new CliqClient("id", "secret", "franzi");
    try {
      expect(await client.createBotHandler("b-1", "message_handler", "handler body")).toEqual({ ok: true });
    } finally {
      mock.restore();
    }
    expect(mock.requests[0].url.pathname).toBe("/api/v3/bots/b-1/handlers");
    expect(mock.requests[0].method).toBe("POST");
    expect(JSON.parse(mock.requests[0].body!)).toEqual({ type: "message_handler", script: "handler body" });
  });

  it("updates a handler through PATCH with a script-only body", async () => {
    const mock = installFetch(() => new Response("{}", { status: 200 }));
    const client = new CliqClient("id", "secret", "franzi");
    try {
      expect(await client.updateBotHandler("b-1", "mention_handler", "handler body")).toEqual({ ok: true });
    } finally {
      mock.restore();
    }
    expect(mock.requests[0].url.pathname).toBe("/api/v3/bots/b-1/handlers/mention_handler");
    expect(mock.requests[0].method).toBe("PATCH");
    expect(JSON.parse(mock.requests[0].body!)).toEqual({ script: "handler body" });
  });

  it("returns the Zoho error code without exposing its raw body", async () => {
    const leaked = 'webhookSecret = "live-secret"; access_token = "tok";';
    const mock = installFetch(() => new Response(JSON.stringify({
      code: "operation_failed",
      message: leaked,
    }), { status: 400 }));
    const client = new CliqClient("id", "secret", "franzi");
    let result;
    try {
      result = await client.createBotHandler("b-1", "mention_handler", "handler body");
    } finally {
      mock.restore();
    }
    expect(result).toEqual({ ok: false, code: "operation_failed", status: 400 });
    expect(JSON.stringify(result)).not.toContain("live-secret");
    expect(JSON.stringify(result)).not.toContain("tok");
  });

  it("classifies a missing update scope without returning OAuth response content", async () => {
    const mock = installFetch(() => new Response(JSON.stringify({
      code: "oauthtoken_scope_invalid",
      message: "raw sensitive response",
    }), { status: 401 }));
    const client = new CliqClient("id", "secret", "franzi");
    let result;
    try {
      result = await client.updateBotHandler("b-1", "message_handler", "handler body");
    } finally {
      mock.restore();
    }
    expect(result).toEqual({ ok: false, code: "missing_scope", status: 401 });
    expect(JSON.stringify(result)).not.toContain("raw sensitive response");
  });
});
