import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { CliqClient } from "./client.js";
import type { CliqButton } from "./presentation.js";

/**
 * `CliqClient.sendCard` posts a bot message with interactive buttons to the
 * DM (`/bots/{botId}/message` + `userids`, scope `ZohoCliq.Webhooks.CREATE`)
 * or channel (`/channelsbyname/{name}/message?bot_unique_name=`, scope
 * `ZohoCliq.Channels.UPDATE`) endpoint. The body is `{ text?, buttons, userids? }`.
 */
describe("CliqClient.sendCard", () => {
  let restoreFetch: (() => void) | null = null;

  beforeEach(() => {
    restoreFetch = null;
  });

  afterEach(() => {
    if (restoreFetch) {
      restoreFetch();
      restoreFetch = null;
    }
  });

  function mockFetch(opts: {
    oauthStatus?: number;
    oauthBody?: unknown;
    sendStatus?: number;
    sendBody?: string;
    captured?: { url: string; method: string; body: string; auth: string }[];
  }): void {
    const original = globalThis.fetch;
    const oauthStatus = opts.oauthStatus ?? 200;
    const oauthBody = opts.oauthBody ?? { access_token: "TOK", expires_in: 3600 };
    const sendStatus = opts.sendStatus ?? 200;
    const sendBody = opts.sendBody ?? JSON.stringify({ id: "card-1" });
    const captured = opts.captured ?? [];
    globalThis.fetch = (async (url: URL | string, init?: RequestInit) => {
      const urlStr = typeof url === "string" ? url : url.toString();
      if (urlStr.includes("/oauth/v2/token")) {
        return new Response(JSON.stringify(oauthBody), { status: oauthStatus });
      }
      captured.push({
        url: urlStr,
        method: init?.method ?? "GET",
        body: typeof init?.body === "string" ? init.body : "",
        auth: (init?.headers as Record<string, string> | undefined)?.Authorization ?? "",
      });
      return new Response(sendBody, { status: sendStatus });
    }) as typeof fetch;
    restoreFetch = () => {
      globalThis.fetch = original;
    };
  }

  function makeClient(opts?: { refreshToken?: string }) {
    return new CliqClient(
      "id",
      "secret",
      "bot",
      undefined,
      undefined,
      { maxAttempts: 1, baseDelayMs: 1, maxDelayMs: 1, sleep: async () => {}, random: () => 0 },
      undefined,
      opts?.refreshToken,
    );
  }

  const buttons: CliqButton[] = [
    { label: "Open", type: "+", action: "openurl", url: "https://example.com" },
    { label: "Confirm", type: "+", action: "invoke", data: "yes" },
  ];

  it("posts a DM card to /bots/{botId}/message with userids + buttons", async () => {
    const captured: { url: string; method: string; body: string; auth: string }[] = [];
    mockFetch({ captured });

    const client = makeClient();
    const result = await client.sendCard({ to: "user-7", isDm: true, text: "Pick", buttons });
    expect(result.messageId).toBe("card-1");

    expect(captured).toHaveLength(1);
    const req = captured[0];
    expect(req.method).toBe("POST");
    expect(req.url).toContain("/api/v2/bots/bot/message");
    expect(req.auth).toBe("Zoho-oauthtoken TOK");
    const body = JSON.parse(req.body) as Record<string, unknown>;
    expect(body.text).toBe("Pick");
    expect(body.userids).toBe("user-7");
    expect(body.buttons).toEqual(buttons);
  });

  it("posts a channel card to /channelsbyname/{name}/message with bot_unique_name query", async () => {
    const captured: { url: string; method: string; body: string; auth: string }[] = [];
    mockFetch({ captured, sendBody: JSON.stringify({ id: "card-chan" }) });

    const client = makeClient({ refreshToken: "rt" });
    const result = await client.sendCard({ to: "dev-team", isDm: false, text: "Hi", buttons });
    expect(result.messageId).toBe("card-chan");

    expect(captured).toHaveLength(1);
    const req = captured[0];
    expect(req.url).toContain("/api/v2/channelsbyname/dev-team/message");
    expect(req.url).toContain("bot_unique_name=bot");
    const body = JSON.parse(req.body) as Record<string, unknown>;
    expect(body.text).toBe("Hi");
    expect(body.userids).toBeUndefined();
    expect(body.buttons).toEqual(buttons);
  });

  it("omits text from the payload when none is supplied (buttons-only card)", async () => {
    const captured: { url: string; method: string; body: string; auth: string }[] = [];
    mockFetch({ captured });

    const client = makeClient();
    await client.sendCard({ to: "user-1", isDm: true, buttons });
    const body = JSON.parse(captured[0].body) as Record<string, unknown>;
    expect(body.text).toBeUndefined();
    expect(body.buttons).toEqual(buttons);
    expect(body.userids).toBe("user-1");
  });

  it("parses a bot-DM response shape ({message_details:{...}}) into chatId+messageId", async () => {
    mockFetch({
      sendBody: JSON.stringify({
        message_details: { "user-7": { chat_id: "CT_dm", message_id: "m-dm" } },
      }),
    });
    const client = makeClient();
    const result = await client.sendCard({ to: "user-7", isDm: true, buttons });
    expect(result.messageId).toBe("m-dm");
    expect(result.chatId).toBe("CT_dm");
  });
});
