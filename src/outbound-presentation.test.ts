import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  cliqOutboundPresentation,
  renderCliqPresentation,
  sendCliqPayload,
  isCliqCardChannelData,
} from "./outbound-presentation.js";
import { setCliqClientRegistry } from "./runtime-api.js";
import type { ReplyPayload } from "openclaw/plugin-sdk/core";
import type { ChannelOutboundPayloadContext } from "openclaw/plugin-sdk/channel-runtime";
import type { MessagePresentation } from "openclaw/plugin-sdk/interactive-runtime";
import { createCliqTestConfig as cfgWith } from "./test-api.js";

const baseCfg = cfgWith({
  clientId: "id",
  clientSecret: "secret",
  botId: "bot",
  // Pin the v2 card path so these routing/chunking tests stay focused on the
  // presentation layer (the v3 default DM-card path posts a `card` body, not
  // top-level `buttons` — covered by src/send-card.test.ts).
  apiVersion: "v2",
});

function mockFetch(opts: {
  captured?: { url: string; method: string; body: string }[];
  sendBody?: string;
}): () => void {
  const original = globalThis.fetch;
  const captured = opts.captured ?? [];
  const sendBody = opts.sendBody ?? JSON.stringify({ id: "msg-x" });
  globalThis.fetch = (async (url: URL | string, init?: RequestInit) => {
    const urlStr = typeof url === "string" ? url : url.toString();
    if (urlStr.includes("/oauth/v2/token")) {
      return new Response(
        JSON.stringify({ access_token: "tok", expires_in: 3600 }),
        { status: 200 },
      );
    }
    if (init?.method === "POST") {
      captured.push({
        url: urlStr,
        method: "POST",
        body: typeof init.body === "string" ? init.body : "",
      });
      return new Response(sendBody, { status: 200 });
    }
    return new Response("", { status: 404 });
  }) as typeof fetch;
  return () => {
    globalThis.fetch = original;
  };
}

function buildCtx(
  payload: ReplyPayload,
  overrides?: Partial<ChannelOutboundPayloadContext>,
): ChannelOutboundPayloadContext {
  return {
    cfg: baseCfg,
    to: "cliq:user:u1",
    text: payload.text ?? "",
    payload,
    accountId: undefined,
    ...overrides,
  } as ChannelOutboundPayloadContext;
}

describe("cliqOutboundPresentation adapter surface", () => {
  it("advertises presentation capabilities + renderPresentation + sendPayload", () => {
    expect(cliqOutboundPresentation.presentationCapabilities).toBeDefined();
    expect(cliqOutboundPresentation.presentationCapabilities?.supported).toBe(true);
    expect(cliqOutboundPresentation.presentationCapabilities?.buttons).toBe(true);
    expect(typeof cliqOutboundPresentation.renderPresentation).toBe("function");
    expect(typeof cliqOutboundPresentation.sendPayload).toBe("function");
  });
});

describe("renderCliqPresentation", () => {
  it("returns null when the presentation has no buttons and no text", () => {
    const presentation: MessagePresentation = { blocks: [] };
    const result = renderCliqPresentation({
      payload: { text: "hi" },
      presentation,
      ctx: buildCtx({ text: "hi" }),
    });
    expect(result).toBeNull();
  });

  it("attaches channelData.cliqCard with buttons and appends card text to payload text", () => {
    const presentation: MessagePresentation = {
      title: "Approve?",
      blocks: [
        { type: "text", text: "Run deploy" },
        {
          type: "buttons",
          buttons: [
            { label: "Yes", action: { type: "callback", value: "yes" } },
            { label: "No", action: { type: "callback", value: "no" } },
          ],
        },
      ],
    };
    const result = renderCliqPresentation({
      payload: { text: "Pick an option" },
      presentation,
      ctx: buildCtx({ text: "Pick an option" }),
    });
    expect(result).not.toBeNull();
    // Agent text first, then card text (title + text block) joined.
    expect(result!.text).toBe("Pick an option\n\nApprove?\n\nRun deploy");
    expect(isCliqCardChannelData(result!.channelData)).toBe(true);
    const card = (result!.channelData as { cliqCard: { buttons: unknown[]; text?: string } }).cliqCard;
    expect(card.buttons).toHaveLength(2);
    expect(card.text).toBe("Approve?\n\nRun deploy");
  });

  it("omits the card marker when there are no buttons (text-only presentation)", () => {
    const presentation: MessagePresentation = {
      blocks: [{ type: "text", text: "just text" }],
    };
    const result = renderCliqPresentation({
      payload: { text: "agent reply" },
      presentation,
      ctx: buildCtx({ text: "agent reply" }),
    });
    expect(result).not.toBeNull();
    expect(result!.text).toBe("agent reply\n\njust text");
    // No buttons → no cliqCard marker → sendPayload falls back to sendMessage.
    expect(isCliqCardChannelData(result!.channelData)).toBe(false);
  });

  it("preserves existing channelData when attaching the card", () => {
    const presentation: MessagePresentation = {
      blocks: [
        { type: "buttons", buttons: [{ label: "Go", url: "https://x" }] },
      ],
    };
    const result = renderCliqPresentation({
      payload: { text: "r", channelData: { other: 1 } },
      presentation,
      ctx: buildCtx({ text: "r" }),
    });
    expect(result!.channelData).toMatchObject({ other: 1, cliqCard: { buttons: [{ label: "Go" }] } });
  });
});

describe("sendCliqPayload", () => {
  let restore: (() => void) | null = null;

  beforeEach(() => {
    setCliqClientRegistry(null);
    restore = null;
  });

  afterEach(() => {
    if (restore) restore();
  });

  it("routes a payload with channelData.cliqCard through sendCard (buttons + first chunk)", async () => {
    const captured: { url: string; method: string; body: string }[] = [];
    restore = mockFetch({ captured });
    const buttons = [{ label: "Yes", type: "+", action: "invoke", data: "yes" }];
    const payload: ReplyPayload = {
      text: "Pick",
      channelData: { cliqCard: { buttons } },
    };
    const result = await sendCliqPayload(buildCtx(payload));
    expect(result.channel).toBe("cliq");
    expect(result.messageId).toBe("msg-x");
    // Only one send (the card). No follow-up sendMessage for a single chunk.
    expect(captured).toHaveLength(1);
    const body = JSON.parse(captured[0].body) as { text?: string; buttons?: unknown[]; userids?: string };
    expect(body.text).toBe("Pick");
    expect(body.buttons).toEqual(buttons);
    expect(body.userids).toBe("u1");
  });

  it("chunks long text: first chunk + buttons via sendCard, rest via sendMessage", async () => {
    const captured: { url: string; method: string; body: string }[] = [];
    restore = mockFetch({ captured });
    const longText = "a".repeat(5500);
    const buttons = [{ label: "OK", type: "+", action: "openurl", url: "https://x" }];
    const payload: ReplyPayload = {
      text: longText,
      channelData: { cliqCard: { buttons } },
    };
    await sendCliqPayload(buildCtx(payload));
    // One card send + at least one follow-up plain message.
    expect(captured.length).toBeGreaterThanOrEqual(2);
    const first = JSON.parse(captured[0].body) as { buttons?: unknown[]; text: string };
    expect(first.buttons).toEqual(buttons);
    expect(first.text.length).toBeLessThanOrEqual(5000);
    for (let i = 1; i < captured.length; i++) {
      const rest = JSON.parse(captured[i].body) as { buttons?: unknown[]; text: string };
      expect(rest.buttons).toBeUndefined();
      expect(rest.text.length).toBeLessThanOrEqual(5000);
    }
  });

  it("falls back to sendMessage when no card is present (plain reply path)", async () => {
    const captured: { url: string; method: string; body: string }[] = [];
    restore = mockFetch({ captured });
    const payload: ReplyPayload = { text: "plain reply" };
    await sendCliqPayload(buildCtx(payload));
    expect(captured).toHaveLength(1);
    const body = JSON.parse(captured[0].body) as { text: string; buttons?: unknown[] };
    expect(body.text).toBe("plain reply");
    expect(body.buttons).toBeUndefined();
  });

  it("routes a channel target through channelsbyname (not bots)", async () => {
    const captured: { url: string; method: string; body: string }[] = [];
    restore = mockFetch({ captured });
    const buttons = [{ label: "OK", type: "+", action: "openurl", url: "https://x" }];
    const payload: ReplyPayload = {
      text: "hi",
      channelData: { cliqCard: { buttons } },
    };
    await sendCliqPayload(
      buildCtx(payload, { to: "cliq:channel:dev-team" }),
    );
    expect(captured).toHaveLength(1);
    expect(captured[0].url).toContain("/channelsbyname/dev-team/message");
    expect(captured[0].url).toContain("bot_unique_name=bot");
  });
});

describe("isCliqCardChannelData", () => {
  it("rejects non-object and array values", () => {
    expect(isCliqCardChannelData(null)).toBe(false);
    expect(isCliqCardChannelData(undefined)).toBe(false);
    expect(isCliqCardChannelData("x")).toBe(false);
    expect(isCliqCardChannelData([])).toBe(false);
    expect(isCliqCardChannelData({})).toBe(false);
  });

  it("accepts an object with a cliqCard marker", () => {
    expect(isCliqCardChannelData({ cliqCard: { buttons: [] } })).toBe(true);
  });
});
