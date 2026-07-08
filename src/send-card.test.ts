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

  function makeClient(opts?: { refreshToken?: string; apiVersion?: "v2" | "v3" | Record<string, "v2" | "v3"> }) {
    return new CliqClient(
      "id",
      "secret",
      "bot",
      undefined,
      undefined,
      { maxAttempts: 1, baseDelayMs: 1, maxDelayMs: 1, sleep: async () => {}, random: () => 0 },
      undefined,
      opts?.refreshToken,
      opts?.apiVersion,
    );
  }

  const buttons: CliqButton[] = [
    { label: "Open", type: "+", action: "openurl", url: "https://example.com" },
    { label: "Confirm", type: "+", action: "invoke", data: "yes" },
  ];

  it("posts a DM card to /bots/{botId}/message with userids + buttons (v2 path)", async () => {
    const captured: { url: string; method: string; body: string; auth: string }[] = [];
    mockFetch({ captured });

    const client = makeClient({ apiVersion: "v2" });
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

  it("omits text from the payload when none is supplied (buttons-only card, v2 path)", async () => {
    const captured: { url: string; method: string; body: string; auth: string }[] = [];
    mockFetch({ captured });

    const client = makeClient({ apiVersion: "v2" });
    await client.sendCard({ to: "user-1", isDm: true, buttons });
    const body = JSON.parse(captured[0].body) as Record<string, unknown>;
    expect(body.text).toBeUndefined();
    expect(body.buttons).toEqual(buttons);
    expect(body.userids).toBe("user-1");
  });

  it("parses a bot-DM response shape ({message_details:{...}}) into chatId+messageId (v2 path)", async () => {
    mockFetch({
      sendBody: JSON.stringify({
        message_details: { "user-7": { chat_id: "CT_dm", message_id: "m-dm" } },
      }),
    });
    const client = makeClient({ apiVersion: "v2" });
    const result = await client.sendCard({ to: "user-7", isDm: true, buttons });
    expect(result.messageId).toBe("m-dm");
    expect(result.chatId).toBe("CT_dm");
  });

  describe("apiVersion: v3 channel card send", () => {
    it("posts a channel card to /api/v3/channels/{name}/message with a modern-inline Message Card body", async () => {
      const captured: { url: string; method: string; body: string; auth: string }[] = [];
      mockFetch({
        captured,
        oauthBody: { access_token: "RT-TOK", expires_in: 3600 },
        sendBody: JSON.stringify({ data: { id: "card-v3" } }),
      });

      const client = makeClient({ refreshToken: "rt", apiVersion: "v3" });
      const result = await client.sendCard({
        to: "dev-team",
        isDm: false,
        text: "Pick an option",
        buttons,
      });
      expect(result.messageId).toBe("card-v3");

      expect(captured).toHaveLength(1);
      const req = captured[0];
      expect(req.method).toBe("POST");
      expect(req.url).toContain("/api/v3/channels/dev-team/message");
      expect(req.url).not.toContain("bot_unique_name");
      expect(req.auth).toBe("Zoho-oauthtoken RT-TOK");
      const body = JSON.parse(req.body) as Record<string, unknown>;
      expect(body.card).toBeDefined();
      const card = body.card as { theme: string; title: string; buttons: unknown[] };
      expect(card.theme).toBe("modern-inline");
      expect(card.title).toBe("Pick an option");
      expect(card.buttons).toHaveLength(2);
      // The first button (openurl) becomes open.url; the second (invoke)
      // becomes invoke.bot carrying bot_name + message.
      const btn0 = card.buttons[0] as { action: { type: string; data: { web: string } } };
      expect(btn0.action.type).toBe("open.url");
      expect(btn0.action.data.web).toBe("https://example.com");
      const btn1 = card.buttons[1] as {
        action: { type: string; data: { bot_name: string; message: string } };
      };
      expect(btn1.action.type).toBe("invoke.bot");
      expect(btn1.action.data.bot_name).toBe("bot");
      expect(btn1.action.data.message).toBe("yes");
      // Full text kept as the top-level fallback.
      expect(body.text).toBe("Pick an option");
    });

    it("splits the first line into the title and the rest into a text slide", async () => {
      const captured: { url: string; method: string; body: string; auth: string }[] = [];
      mockFetch({ captured });

      const client = makeClient({ refreshToken: "rt", apiVersion: "v3" });
      await client.sendCard({
        to: "dev-team",
        isDm: false,
        text: "Header\nBody line 2",
        buttons,
      });
      const body = JSON.parse(captured[0].body) as {
        card: { title: string };
        slides?: Array<{ type: string; data: string }>;
      };
      expect(body.card.title).toBe("Header");
      expect(body.slides).toEqual([{ type: "text", data: "Body line 2" }]);
    });

    it("falls back to the v2 path when the v3 renderer yields no payload (no text + all buttons dropped)", async () => {
      const captured: { url: string; method: string; body: string; auth: string }[] = [];
      mockFetch({ captured, sendBody: JSON.stringify({ id: "card-v2-fb" }) });

      const client = makeClient({ refreshToken: "rt", apiVersion: "v3" });
      // Invoke button with no convertible payload + no text → v3 renderer
      // returns null → falls back to v2 channelsbyname send.
      const result = await client.sendCard({
        to: "dev-team",
        isDm: false,
        buttons: [{ label: "X", type: "+", action: "api", url: "https://x.com" }],
      });
      expect(result.messageId).toBe("card-v2-fb");
      expect(captured[0].url).toContain("/api/v2/channelsbyname/dev-team/message");
    });
  });

  describe("apiVersion: v3 DM card send", () => {
    it("posts a DM card to /api/v3/bots/{botId}/messages with a modern-inline Message Card body + userids + sync_message", async () => {
      const captured: { url: string; method: string; body: string; auth: string }[] = [];
      mockFetch({
        captured,
        // No refreshToken — the v3 DM card path uses client_credentials.
        // Live v3 bot-DM sync_message response shape (message_details.<uid>).
        sendBody: JSON.stringify({
          message_details: { "user-7": { chat_id: "CT_dm_v3", message_id: "card-dm-v3" } },
        }),
      });

      const client = makeClient({ apiVersion: "v3" });
      const result = await client.sendCard({
        to: "user-7",
        isDm: true,
        text: "Pick an option",
        buttons,
      });
      expect(result.messageId).toBe("card-dm-v3");
      expect(result.chatId).toBe("CT_dm_v3");

      expect(captured).toHaveLength(1);
      const req = captured[0];
      expect(req.method).toBe("POST");
      expect(req.url).toContain("/api/v3/bots/bot/messages");
      // NO bot_unique_name query param (the bot identity is in the path).
      expect(req.url).not.toContain("bot_unique_name");
      // client_credentials token (no refresh-token grant involved).
      expect(req.auth).toBe("Zoho-oauthtoken TOK");
      const body = JSON.parse(req.body) as Record<string, unknown>;
      expect(body.card).toBeDefined();
      const card = body.card as { theme: string; title: string; buttons: unknown[] };
      expect(card.theme).toBe("modern-inline");
      expect(card.title).toBe("Pick an option");
      expect(card.buttons).toHaveLength(2);
      // Recipient key is `userids` (v2-style, NO underscore) — a `user_ids`
      // key is rejected by the live v3 bot-DM endpoint with `extra_key_found`.
      expect(body.userids).toBe("user-7");
      expect(body.user_ids).toBeUndefined();
      expect(body.sync_message).toBe(true);
      // Full text kept as the top-level fallback.
      expect(body.text).toBe("Pick an option");
    });

    it("does NOT require a refresh token (client_credentials / Webhooks.CREATE scope)", async () => {
      const allRequests: { url: string }[] = [];
      const original = globalThis.fetch;
      globalThis.fetch = (async (url: URL | string) => {
        const urlStr = typeof url === "string" ? url : url.toString();
        allRequests.push({ url: urlStr });
        if (urlStr.includes("/oauth/v2/token")) {
          return new Response(JSON.stringify({ access_token: "TOK", expires_in: 3600 }), {
            status: 200,
          });
        }
        return new Response(JSON.stringify({ data: { id: "x" } }), { status: 200 });
      }) as typeof fetch;
      try {
        const client = makeClient({ apiVersion: "v3" });
        await client.sendCard({ to: "user-7", isDm: true, text: "Pick", buttons });
        // OAuth request used client_credentials (no refresh_token grant).
        const oauth = allRequests.find((r) => r.url.includes("/oauth/v2/token"));
        expect(oauth).toBeDefined();
        expect(oauth!.url).toContain("grant_type=client_credentials");
        expect(oauth!.url).toContain("scope=ZohoCliq.Webhooks.CREATE");
        expect(oauth!.url).not.toContain("grant_type=refresh_token");
      } finally {
        globalThis.fetch = original;
      }
    });

    it("falls back to the v2 DM path when the v3 renderer yields no payload", async () => {
      const captured: { url: string; method: string; body: string; auth: string }[] = [];
      mockFetch({ captured, sendBody: JSON.stringify({ id: "card-dm-v2-fb" }) });

      const client = makeClient({ apiVersion: "v3" });
      // No text + an unconvertible api-action button → v3 renderer returns
      // null → falls back to v2 /bots/{botId}/message send.
      const result = await client.sendCard({
        to: "user-7",
        isDm: true,
        buttons: [{ label: "X", type: "+", action: "api", url: "https://x.com" }],
      });
      expect(result.messageId).toBe("card-dm-v2-fb");
      expect(captured[0].url).toContain("/api/v2/bots/bot/message");
      const body = JSON.parse(captured[0].body) as { buttons: unknown[] };
      // v2 path keeps the raw v2 CliqButton shape at the top level.
      expect(body.buttons).toHaveLength(1);
    });

    it("converts invoke buttons to invoke.bot carrying the configured botId", async () => {
      const captured: { url: string; method: string; body: string; auth: string }[] = [];
      mockFetch({ captured });

      const client = makeClient({ apiVersion: "v3" });
      await client.sendCard({
        to: "user-9",
        isDm: true,
        text: "Confirm",
        buttons: [{ label: "Yes", type: "+", action: "invoke", data: "yes" }],
      });
      const body = JSON.parse(captured[0].body) as {
        card: { buttons: Array<{ action: { type: string; data: { bot_name: string; message: string } } }> };
      };
      expect(body.card.buttons).toHaveLength(1);
      expect(body.card.buttons[0].action.type).toBe("invoke.bot");
      expect(body.card.buttons[0].action.data.bot_name).toBe("bot");
      expect(body.card.buttons[0].action.data.message).toBe("yes");
    });
  });

  describe("apiVersion: v3 prompt theme", () => {
    it("renders a prompt Message Card on the v3 channel path when theme === 'prompt'", async () => {
      const captured: { url: string; method: string; body: string; auth: string }[] = [];
      mockFetch({
        captured,
        oauthBody: { access_token: "RT-TOK", expires_in: 3600 },
        sendBody: JSON.stringify({ data: { id: "prompt-v3" } }),
      });

      const client = makeClient({ refreshToken: "rt", apiVersion: "v3" });
      const result = await client.sendCard({
        to: "dev-team",
        isDm: false,
        text: "Approve deploy?",
        theme: "prompt",
        buttons,
      });
      expect(result.messageId).toBe("prompt-v3");

      const req = captured[0];
      expect(req.url).toContain("/api/v3/channels/dev-team/message");
      const body = JSON.parse(req.body) as {
        card: { theme: string; title: string; buttons: unknown[] };
        text?: string;
      };
      expect(body.card.theme).toBe("prompt");
      expect(body.card.title).toBe("Approve deploy?");
      expect(body.card.buttons).toHaveLength(2);
      expect(body.text).toBe("Approve deploy?");
    });

    it("renders a prompt Message Card on the v3 DM path when theme === 'prompt'", async () => {
      const captured: { url: string; method: string; body: string; auth: string }[] = [];
      mockFetch({
        captured,
        sendBody: JSON.stringify({
          message_details: { "user-7": { chat_id: "CT_p", message_id: "prompt-dm-v3" } },
        }),
      });

      const client = makeClient({ apiVersion: "v3" });
      const result = await client.sendCard({
        to: "user-7",
        isDm: true,
        text: "Approve deploy?",
        theme: "prompt",
        buttons,
      });
      expect(result.messageId).toBe("prompt-dm-v3");
      expect(result.chatId).toBe("CT_p");

      const req = captured[0];
      expect(req.url).toContain("/api/v3/bots/bot/messages");
      const body = JSON.parse(req.body) as {
        card: { theme: string; title: string; buttons: unknown[] };
        userids: string;
        sync_message: boolean;
      };
      expect(body.card.theme).toBe("prompt");
      expect(body.card.title).toBe("Approve deploy?");
      expect(body.card.buttons).toHaveLength(2);
      expect(body.userids).toBe("user-7");
      expect(body.sync_message).toBe(true);
    });

    it("falls back to v2 when theme === 'prompt' but no buttons survive (buttonless prompt is invalid)", async () => {
      const captured: { url: string; method: string; body: string; auth: string }[] = [];
      mockFetch({
        captured,
        oauthBody: { access_token: "RT-TOK", expires_in: 3600 },
        sendBody: JSON.stringify({ id: "prompt-fb" }),
      });

      const client = makeClient({ refreshToken: "rt", apiVersion: "v3" });
      const result = await client.sendCard({
        to: "dev-team",
        isDm: false,
        text: "Approve?",
        theme: "prompt",
        buttons: [{ label: "X", type: "+", action: "api", url: "https://x.com" }],
      });
      expect(result.messageId).toBe("prompt-fb");
      expect(captured[0].url).toContain("/api/v2/channelsbyname/dev-team/message");
    });
  });
});
