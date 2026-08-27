import { afterEach, describe, expect, it, vi } from "vitest";
import { CliqClient, isCliqBotReadFailure } from "./client.js";

function installFetch(
  handler: (url: URL, call: number) => Response,
): { urls: URL[]; restore: () => void } {
  const original = globalThis.fetch;
  const urls: URL[] = [];
  let call = 0;
  globalThis.fetch = (async (input: URL | string) => {
    const url = new URL(typeof input === "string" ? input : input.toString());
    if (url.pathname === "/oauth/v2/token") {
      return new Response(JSON.stringify({ access_token: "token", expires_in: 3600 }), {
        status: 200,
      });
    }
    urls.push(url);
    call++;
    return handler(url, call);
  }) as typeof fetch;
  return { urls, restore: () => { globalThis.fetch = original; } };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("CliqClient read-only bot inspection API", () => {
  it("lists bots with the documented max page size and follows next_token", async () => {
    const mock = installFetch((_url, call) => {
      if (call === 1) {
        return new Response(JSON.stringify({
          data: [{ id: "b-1", unique_name: "openclaw-bot" }],
          next_token: "cursor-1",
        }), { status: 200 });
      }
      return new Response(JSON.stringify({
        data: [{ id: "b-2", unique_name: "other-bot" }],
      }), { status: 200 });
    });
    const client = new CliqClient("id", "secret", "openclaw-bot");
    try {
      const result = await client.listBots();
      expect(result).toHaveLength(2);
    } finally {
      mock.restore();
    }
    expect(mock.urls).toHaveLength(2);
    expect(mock.urls[0].pathname).toBe("/api/v3/bots");
    expect(mock.urls[0].searchParams.get("limit")).toBe("50");
    expect(mock.urls[0].searchParams.has("next_token")).toBe(false);
    expect(mock.urls[1].searchParams.get("next_token")).toBe("cursor-1");
  });

  it("reads bot metadata through the internal b-id route", async () => {
    const mock = installFetch(() => new Response(JSON.stringify({
      data: { id: "b-1", unique_name: "openclaw-bot", status: "enabled", scope: "organization" },
    }), { status: 200 }));
    const client = new CliqClient("id", "secret", "openclaw-bot");
    try {
      const result = await client.getBot("b-1");
      expect(result).toMatchObject({ id: "b-1", status: "enabled", scope: "organization" });
    } finally {
      mock.restore();
    }
    expect(mock.urls[0].pathname).toBe("/api/v3/bots/b-1");
  });

  it("fully paginates the subscriber list before declaring it complete", async () => {
    const mock = installFetch((_url, call) => new Response(JSON.stringify(
      call === 1
        ? { data: [{ user_id: "u-1" }], next_token: "sub-cursor" }
        : { data: [{ user_id: "u-2" }] },
    ), { status: 200 }));
    const client = new CliqClient("id", "secret", "openclaw-bot");
    try {
      const result = await client.listBotSubscribers("b-1");
      expect(result).toMatchObject({
        subscribers: [{ user_id: "u-1" }, { user_id: "u-2" }],
        complete: true,
      });
    } finally {
      mock.restore();
    }
    expect(mock.urls[0].pathname).toBe("/api/v3/bots/b-1/subscribers");
    expect(mock.urls[1].searchParams.get("next_token")).toBe("sub-cursor");
  });

  it("classifies a subscriber permission refusal without exposing the response body", async () => {
    const sentinel = "SENSITIVE_RESPONSE_BODY";
    const mock = installFetch(() => new Response(JSON.stringify({
      code: "forbidden",
      message: sentinel,
    }), { status: 403 }));
    const client = new CliqClient("id", "secret", "openclaw-bot");
    let result;
    try {
      result = await client.listBotSubscribers("b-1");
    } finally {
      mock.restore();
    }
    expect(isCliqBotReadFailure(result)).toBe(true);
    expect(result).toMatchObject({ kind: "forbidden", status: 403 });
    expect(JSON.stringify(result)).not.toContain(sentinel);
  });

  it("classifies missing Bots.READ separately from the subscriber permission boundary", async () => {
    const mock = installFetch(() => new Response(JSON.stringify({
      code: "oauthtoken_scope_invalid",
      message: "scope invalid",
    }), { status: 403 }));
    const client = new CliqClient("id", "secret", "openclaw-bot");
    let result;
    try {
      result = await client.listBots();
    } finally {
      mock.restore();
    }
    expect(result).toMatchObject({ kind: "missing_scope", status: 403 });
  });
});
