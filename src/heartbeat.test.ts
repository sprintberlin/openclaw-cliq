import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  cliqHeartbeatAdapter,
  probeCliqHeartbeat,
  rememberCliqChatId,
  lookupCliqChatId,
  resetCliqTypingState,
  isCliqChatId,
  DEFAULT_CLIQ_TYPING_MIN_INTERVAL_MS,
  DEFAULT_CLIQ_TYPING_MAX_DURATION_MS,
} from "./heartbeat.js";
import { setCliqClientRegistry } from "./runtime-api.js";
import type { OpenClawConfig } from "openclaw/plugin-sdk/channel-core";

function cfgWith(section: Record<string, unknown>): OpenClawConfig {
  return { channels: { cliq: section } } as unknown as OpenClawConfig;
}

const CONFIGURED = cfgWith({
  clientId: "id",
  clientSecret: "secret",
  botId: "bot",
});

const WITH_REFRESH = cfgWith({
  clientId: "id",
  clientSecret: "secret",
  botId: "bot",
  refreshToken: "rt",
});

function installFetch(opts: {
  tokenStatus?: number;
  tokenBody?: unknown;
  activityStatus?: number;
  activityBody?: string;
} = {}): {
  restore: () => void;
  oauthCalls: number;
  refreshCalls: number;
  activities: { url: string; body: string }[];
} {
  const original = globalThis.fetch;
  let oauthCalls = 0;
  let refreshCalls = 0;
  const activities: { url: string; body: string }[] = [];
  globalThis.fetch = (async (url: URL | string, init?: RequestInit) => {
    const urlStr = typeof url === "string" ? url : url.toString();
    if (urlStr.includes("/oauth/v2/token")) {
      oauthCalls++;
      if (urlStr.includes("grant_type=refresh_token")) refreshCalls++;
      const status = opts.tokenStatus ?? 200;
      const body = opts.tokenBody ?? { access_token: "tok", expires_in: 3600 };
      return new Response(JSON.stringify(body), { status });
    }
    if (urlStr.includes("/activities")) {
      activities.push({ url: urlStr, body: String(init?.body ?? "") });
      const status = opts.activityStatus ?? 204;
      return new Response(status === 204 ? null : (opts.activityBody ?? ""), {
        status,
      });
    }
    return new Response("", { status: 404 });
  }) as typeof fetch;
  return {
    restore: () => {
      globalThis.fetch = original;
    },
    get oauthCalls() {
      return oauthCalls;
    },
    get refreshCalls() {
      return refreshCalls;
    },
    activities,
  };
}

async function flush(): Promise<void> {
  await new Promise((r) => setTimeout(r, 20));
}

describe("cliq heartbeat adapter", () => {
  let now = 1_000_000;

  beforeEach(() => {
    setCliqClientRegistry(null);
    now = 1_000_000;
    resetCliqTypingState({ now: () => now });
  });
  afterEach(() => {
    setCliqClientRegistry(null);
    resetCliqTypingState();
  });

  it("checkReady resolves ok when OAuth token fetch succeeds", async () => {
    const fetch = installFetch();
    try {
      const result = await cliqHeartbeatAdapter.checkReady({
        cfg: CONFIGURED,
        accountId: undefined,
      });
      expect(result.ok).toBe(true);
      expect(result.reason).toBe("ok");
      expect(fetch.oauthCalls).toBe(1);
    } finally {
      fetch.restore();
    }
  });

  it("checkReady reuses the cached token on a second probe (no extra OAuth call)", async () => {
    const fetch = installFetch();
    try {
      await cliqHeartbeatAdapter.checkReady({ cfg: CONFIGURED });
      await cliqHeartbeatAdapter.checkReady({ cfg: CONFIGURED });
      expect(fetch.oauthCalls).toBe(1);
    } finally {
      fetch.restore();
    }
  });

  it("checkReady reports not ok when OAuth fails", async () => {
    const fetch = installFetch({
      tokenStatus: 401,
      tokenBody: { error: "invalid_client" },
    });
    try {
      const result = await cliqHeartbeatAdapter.checkReady({
        cfg: CONFIGURED,
        accountId: undefined,
      });
      expect(result.ok).toBe(false);
      expect(result.reason).toMatch(/401/);
    } finally {
      fetch.restore();
    }
  });

  it("checkReady returns not ok when channel is unconfigured", async () => {
    const fetch = installFetch();
    try {
      const result = await cliqHeartbeatAdapter.checkReady({
        cfg: cfgWith({}),
        accountId: undefined,
      });
      expect(result.ok).toBe(false);
      expect(result.reason).toMatch(/not configured/);
      expect(fetch.oauthCalls).toBe(0);
    } finally {
      fetch.restore();
    }
  });

  it("probeCliqHeartbeat resolves ok for a configured account", async () => {
    const fetch = installFetch();
    try {
      const account = {
        accountId: null,
        clientId: "id",
        clientSecret: "secret",
        botId: "bot",
        allowFrom: [],
        dmPolicy: undefined,
        ackPolicy: "after_dispatch" as const,
        selfSenderIds: [],
        blockStreaming: false,
        thinking: { mode: "off" as const, text: "thinking" },
        welcome: { enabled: false, text: "", textRejoin: "" },
        pairing: {
          notifyOwnerTarget: null,
          approveLabel: "Approve",
          denyLabel: "Deny",
          approvalTitle: "Pairing request",
          approvedOwnerText: "Approved.",
          deniedOwnerText: "Denied.",
        },
      };
      const result = await probeCliqHeartbeat(account);
      expect(result.ok).toBe(true);
    } finally {
      fetch.restore();
    }
  });

  it("sendTyping pre-warms the OAuth token when no chat id is known", async () => {
    const fetch = installFetch();
    try {
      cliqHeartbeatAdapter.sendTyping({ cfg: WITH_REFRESH, to: "user-1" });
      await flush();
      expect(fetch.oauthCalls).toBe(1);
      expect(fetch.activities).toHaveLength(0);
    } finally {
      fetch.restore();
    }
  });

  it("sendTyping swallows OAuth failures (never rejects / never throws sync)", async () => {
    const fetch = installFetch({
      tokenStatus: 500,
      tokenBody: { error: "server" },
    });
    try {
      expect(() =>
        cliqHeartbeatAdapter.sendTyping({ cfg: CONFIGURED, to: "user-1" }),
      ).not.toThrow();
      await flush();
    } finally {
      fetch.restore();
    }
  });

  it("sendTyping is a no-op when the channel is unconfigured or `to` is empty", async () => {
    const fetch = installFetch();
    try {
      cliqHeartbeatAdapter.sendTyping({ cfg: cfgWith({}), to: "user-1" });
      cliqHeartbeatAdapter.sendTyping({ cfg: CONFIGURED, to: "" });
      await flush();
      expect(fetch.oauthCalls).toBe(0);
      expect(fetch.activities).toHaveLength(0);
    } finally {
      fetch.restore();
    }
  });

  it("clearTyping without params does not touch the network", async () => {
    const fetch = installFetch();
    try {
      cliqHeartbeatAdapter.clearTyping();
      await flush();
      expect(fetch.oauthCalls).toBe(0);
      expect(fetch.activities).toHaveLength(0);
    } finally {
      fetch.restore();
    }
  });

  it("does not post typing without a refreshToken (capability gate)", async () => {
    const fetch = installFetch();
    try {
      rememberCliqChatId({
        chatId: "CT_dm_chat-B1",
        senderId: "user-1",
        isGroup: false,
      });
      cliqHeartbeatAdapter.sendTyping({ cfg: CONFIGURED, to: "user-1" });
      await flush();
      expect(fetch.activities).toHaveLength(0);
      expect(fetch.oauthCalls).toBe(1);
    } finally {
      fetch.restore();
    }
  });

  it("never posts a user id as the chat id", async () => {
    const fetch = installFetch();
    try {
      cliqHeartbeatAdapter.sendTyping({ cfg: WITH_REFRESH, to: "20098819618" });
      await flush();
      expect(fetch.activities).toHaveLength(0);
    } finally {
      fetch.restore();
    }
  });

  it("posts typing to the remembered inbound chat id", async () => {
    const fetch = installFetch();
    try {
      rememberCliqChatId({
        chatId: "CT_dm_chat-B1",
        senderId: "user-1",
        isGroup: false,
      });
      cliqHeartbeatAdapter.sendTyping({
        cfg: WITH_REFRESH,
        to: "cliq:user:user-1",
      });
      await flush();
      expect(fetch.activities).toHaveLength(1);
      expect(fetch.activities[0].url).toContain(
        "/api/v3/chats/CT_dm_chat-B1/activities",
      );
      expect(JSON.parse(fetch.activities[0].body)).toEqual({ action: "typing" });
      expect(fetch.refreshCalls).toBeGreaterThan(0);
    } finally {
      fetch.restore();
    }
  });

  it("accepts a raw CT_ chat id as `to`", async () => {
    const fetch = installFetch();
    try {
      cliqHeartbeatAdapter.sendTyping({
        cfg: WITH_REFRESH,
        to: "CT_already_a_chat",
      });
      await flush();
      expect(fetch.activities).toHaveLength(1);
      expect(fetch.activities[0].url).toContain(
        "/api/v3/chats/CT_already_a_chat/activities",
      );
    } finally {
      fetch.restore();
    }
  });

  it("throttles typing to at most one request per min interval", async () => {
    const fetch = installFetch();
    try {
      rememberCliqChatId({
        chatId: "CT_dm",
        senderId: "u1",
        isGroup: false,
      });
      cliqHeartbeatAdapter.sendTyping({ cfg: WITH_REFRESH, to: "u1" });
      await flush();
      now += DEFAULT_CLIQ_TYPING_MIN_INTERVAL_MS - 100;
      cliqHeartbeatAdapter.sendTyping({ cfg: WITH_REFRESH, to: "u1" });
      await flush();
      expect(fetch.activities).toHaveLength(1);
      now += 200;
      cliqHeartbeatAdapter.sendTyping({ cfg: WITH_REFRESH, to: "u1" });
      await flush();
      expect(fetch.activities).toHaveLength(2);
    } finally {
      fetch.restore();
    }
  });

  it("stops pulsing typing after the max duration", async () => {
    const fetch = installFetch();
    try {
      rememberCliqChatId({
        chatId: "CT_dm",
        senderId: "u1",
        isGroup: false,
      });
      cliqHeartbeatAdapter.sendTyping({ cfg: WITH_REFRESH, to: "u1" });
      await flush();
      now += DEFAULT_CLIQ_TYPING_MAX_DURATION_MS + 1;
      cliqHeartbeatAdapter.sendTyping({ cfg: WITH_REFRESH, to: "u1" });
      await flush();
      expect(fetch.activities).toHaveLength(1);
    } finally {
      fetch.restore();
    }
  });

  it("stops further typing for the turn after a 429", async () => {
    const fetch = installFetch({ activityStatus: 429, activityBody: "rate" });
    try {
      rememberCliqChatId({
        chatId: "CT_dm",
        senderId: "u1",
        isGroup: false,
      });
      expect(() =>
        cliqHeartbeatAdapter.sendTyping({ cfg: WITH_REFRESH, to: "u1" }),
      ).not.toThrow();
      await flush();
      expect(fetch.activities).toHaveLength(1);
      now += DEFAULT_CLIQ_TYPING_MIN_INTERVAL_MS + 10;
      cliqHeartbeatAdapter.sendTyping({ cfg: WITH_REFRESH, to: "u1" });
      await flush();
      expect(fetch.activities).toHaveLength(1);
    } finally {
      fetch.restore();
    }
  });

  it("clearTyping posts text_cleared after a typing pulse", async () => {
    const fetch = installFetch();
    try {
      rememberCliqChatId({
        chatId: "CT_dm",
        senderId: "u1",
        isGroup: false,
      });
      cliqHeartbeatAdapter.sendTyping({ cfg: WITH_REFRESH, to: "u1" });
      await flush();
      cliqHeartbeatAdapter.clearTyping({
        cfg: WITH_REFRESH,
        to: "u1",
      });
      await flush();
      expect(fetch.activities.map((a) => JSON.parse(a.body).action)).toEqual([
        "typing",
        "text_cleared",
      ]);
    } finally {
      fetch.restore();
    }
  });

  it("clearTyping swallows activity failures", async () => {
    const fetch = installFetch({ activityStatus: 500, activityBody: "boom" });
    try {
      rememberCliqChatId({
        chatId: "CT_dm",
        senderId: "u1",
        isGroup: false,
      });
      cliqHeartbeatAdapter.sendTyping({ cfg: WITH_REFRESH, to: "u1" });
      await flush();
      expect(() =>
        cliqHeartbeatAdapter.clearTyping({ cfg: WITH_REFRESH, to: "u1" }),
      ).not.toThrow();
      await flush();
    } finally {
      fetch.restore();
    }
  });
});

describe("cliq typing chat-id helpers", () => {
  beforeEach(() => resetCliqTypingState());
  afterEach(() => resetCliqTypingState());

  it("accepts CT_ chat ids and rejects user ids", () => {
    expect(isCliqChatId("CT_dm_chat-B1")).toBe(true);
    expect(isCliqChatId("CT_abcdef123456")).toBe(true);
    expect(isCliqChatId("20098819618")).toBe(false);
    expect(isCliqChatId("user-1")).toBe(false);
    expect(isCliqChatId("")).toBe(false);
  });

  it("looks up a remembered DM chat id from sender aliases", () => {
    rememberCliqChatId({
      accountId: null,
      chatId: "CT_dm_chat-B1",
      senderId: "u1",
      isGroup: false,
    });
    expect(lookupCliqChatId(null, "u1")).toBe("CT_dm_chat-B1");
    expect(lookupCliqChatId(null, "cliq:user:u1")).toBe("CT_dm_chat-B1");
    expect(lookupCliqChatId(null, "cliq:u1")).toBe("CT_dm_chat-B1");
  });

  it("looks up a remembered group chat id from the channel unique name", () => {
    rememberCliqChatId({
      chatId: "CT_channel_chat",
      channelUniqueName: "dev-team",
      isGroup: true,
    });
    expect(lookupCliqChatId(null, "cliq:channel:dev-team")).toBe("CT_channel_chat");
    expect(lookupCliqChatId(null, "dev-team")).toBe("CT_channel_chat");
  });
});
