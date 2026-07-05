import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { cliqHeartbeatAdapter, probeCliqHeartbeat } from "./heartbeat.js";
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

function installFetch(opts: {
  tokenStatus?: number;
  tokenBody?: unknown;
} = {}): { restore: () => void; oauthCalls: number } {
  const original = globalThis.fetch;
  let oauthCalls = 0;
  globalThis.fetch = (async (url: URL | string) => {
    const urlStr = typeof url === "string" ? url : url.toString();
    if (urlStr.includes("/oauth/v2/token")) {
      oauthCalls++;
      const status = opts.tokenStatus ?? 200;
      const body = opts.tokenBody ?? { access_token: "tok", expires_in: 3600 };
      return new Response(JSON.stringify(body), { status });
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
  };
}

describe("cliq heartbeat adapter", () => {
  beforeEach(() => setCliqClientRegistry(null));
  afterEach(() => setCliqClientRegistry(null));

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
      };
      const result = await probeCliqHeartbeat(account);
      expect(result.ok).toBe(true);
    } finally {
      fetch.restore();
    }
  });

  it("sendTyping pre-warms the OAuth token (cached) and never throws", async () => {
    const fetch = installFetch();
    try {
      // First call mints the token.
      cliqHeartbeatAdapter.sendTyping({ cfg: CONFIGURED, to: "user-1" });
      // Allow the fire-and-forget getAccessToken to settle.
      await new Promise((r) => setTimeout(r, 10));
      expect(fetch.oauthCalls).toBe(1);

      // A keepalive shortly after reuses the cached token (no new OAuth call).
      cliqHeartbeatAdapter.sendTyping({ cfg: CONFIGURED, to: "user-1" });
      await new Promise((r) => setTimeout(r, 10));
      expect(fetch.oauthCalls).toBe(1);
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
      await new Promise((r) => setTimeout(r, 10));
    } finally {
      fetch.restore();
    }
  });

  it("sendTyping is a no-op when the channel is unconfigured or `to` is empty", async () => {
    const fetch = installFetch();
    try {
      cliqHeartbeatAdapter.sendTyping({ cfg: cfgWith({}), to: "user-1" });
      cliqHeartbeatAdapter.sendTyping({ cfg: CONFIGURED, to: "" });
      await new Promise((r) => setTimeout(r, 10));
      expect(fetch.oauthCalls).toBe(0);
    } finally {
      fetch.restore();
    }
  });

  it("clearTyping is a no-op that does not touch the network", async () => {
    const fetch = installFetch();
    try {
      cliqHeartbeatAdapter.clearTyping();
      await new Promise((r) => setTimeout(r, 10));
      expect(fetch.oauthCalls).toBe(0);
    } finally {
      fetch.restore();
    }
  });
});
