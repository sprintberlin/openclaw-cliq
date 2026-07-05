import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  CliqClientRegistry,
  getCliqClientRegistry,
  resolveCliqClient,
  setCliqClientRegistry,
} from "./runtime-api.js";
import type { ResolvedCliqAccount } from "./client.js";

function account(over: Partial<ResolvedCliqAccount> = {}): ResolvedCliqAccount {
  return {
    accountId: null,
    clientId: "id",
    clientSecret: "secret",
    botId: "bot",
    allowFrom: [],
    dmPolicy: undefined,
    ackPolicy: "after_dispatch",
    selfSenderIds: [],
    ...over,
  };
}

describe("CliqClientRegistry.buildKey", () => {
  it("uses acct:<accountId> when accountId is set", () => {
    expect(
      CliqClientRegistry.buildKey(account({ accountId: "a1" })),
    ).toBe("acct:a1");
  });

  it("falls back to cc:<clientId>:<botId> when accountId is null", () => {
    expect(CliqClientRegistry.buildKey(account())).toBe("cc:id:bot");
  });

  it("treats empty-string accountId as null", () => {
    // accountId is typed string | null; empty string is truthy as a key
    expect(CliqClientRegistry.buildKey(account({ accountId: "" }))).toBe(
      "cc:id:bot",
    );
  });

  it("distinguishes accounts by clientId+botId", () => {
    expect(CliqClientRegistry.buildKey(account({ clientId: "id2" }))).toBe(
      "cc:id2:bot",
    );
    expect(CliqClientRegistry.buildKey(account({ botId: "bot2" }))).toBe(
      "cc:id:bot2",
    );
  });
});

describe("CliqClientRegistry instance", () => {
  let registry: CliqClientRegistry;

  beforeEach(() => {
    registry = new CliqClientRegistry();
  });

  it("getOrCreate returns the same instance for the same account", () => {
    const a = account();
    const c1 = registry.getOrCreate(a);
    const c2 = registry.getOrCreate(a);
    expect(c1).toBe(c2);
  });

  it("getOrCreate returns distinct instances for distinct accounts", () => {
    const c1 = registry.getOrCreate(account({ accountId: "a1" }));
    const c2 = registry.getOrCreate(account({ accountId: "a2" }));
    expect(c1).not.toBe(c2);
  });

  it("get returns undefined for an unseen account", () => {
    expect(registry.get(account())).toBeUndefined();
  });

  it("get returns the cached client after getOrCreate", () => {
    const created = registry.getOrCreate(account());
    expect(registry.get(account())).toBe(created);
  });

  it("evict removes the cached client and returns true", () => {
    const created = registry.getOrCreate(account());
    expect(registry.evict(account())).toBe(true);
    expect(registry.get(account())).toBeUndefined();
    // evicting again returns false
    expect(registry.evict(account())).toBe(false);
    // a fresh client is created on next getOrCreate
    expect(registry.getOrCreate(account())).not.toBe(created);
  });

  it("evict targets only the named account", () => {
    const c1 = registry.getOrCreate(account({ accountId: "a1" }));
    const c2 = registry.getOrCreate(account({ accountId: "a2" }));
    registry.evict(account({ accountId: "a1" }));
    expect(registry.get(account({ accountId: "a1" }))).toBeUndefined();
    expect(registry.get(account({ accountId: "a2" }))).toBe(c2);
    void c1;
  });

  it("clear removes all cached clients", () => {
    registry.getOrCreate(account({ accountId: "a1" }));
    registry.getOrCreate(account({ accountId: "a2" }));
    expect(registry.size).toBe(2);
    registry.clear();
    expect(registry.size).toBe(0);
  });

  it("size reflects the number of cached clients", () => {
    expect(registry.size).toBe(0);
    registry.getOrCreate(account({ accountId: "a1" }));
    expect(registry.size).toBe(1);
    registry.getOrCreate(account({ accountId: "a1" }));
    expect(registry.size).toBe(1);
    registry.getOrCreate(account({ accountId: "a2" }));
    expect(registry.size).toBe(2);
  });

  it("shares the OAuth token cache across getOrCreate calls for the same account", async () => {
    const original = globalThis.fetch;
    let oauthCalls = 0;
    globalThis.fetch = (async (url: URL | string) => {
      const urlStr = typeof url === "string" ? url : url.toString();
      if (urlStr.includes("/oauth/v2/token")) {
        oauthCalls += 1;
        return new Response(
          JSON.stringify({ access_token: `tok-${oauthCalls}`, expires_in: 3600 }),
          { status: 200 },
        );
      }
      return new Response(JSON.stringify({ id: "msg-1" }), { status: 200 });
    }) as typeof fetch;
    try {
      const a = account();
      // First request: mints a client and fetches a token.
      const c1 = registry.getOrCreate(a);
      await c1.getAccessToken();
      // Second request (later): same account, same registry — must reuse the
      // SAME client instance and its cached token, so no new OAuth round-trip.
      const c2 = registry.getOrCreate(a);
      await c2.getAccessToken();
      expect(c1).toBe(c2);
      expect(oauthCalls).toBe(1);
    } finally {
      globalThis.fetch = original;
    }
  });
});

describe("singleton registry helpers", () => {
  afterEach(() => {
    setCliqClientRegistry(null);
  });

  it("getCliqClientRegistry returns a registry (lazily created)", () => {
    const r = getCliqClientRegistry();
    expect(r).toBeInstanceOf(CliqClientRegistry);
  });

  it("getCliqClientRegistry returns the same instance on repeat calls", () => {
    const r1 = getCliqClientRegistry();
    const r2 = getCliqClientRegistry();
    expect(r1).toBe(r2);
  });

  it("setCliqClientRegistry(null) resets the singleton", () => {
    const r1 = getCliqClientRegistry();
    setCliqClientRegistry(null);
    const r2 = getCliqClientRegistry();
    expect(r2).not.toBe(r1);
  });

  it("setCliqClientRegistry installs a custom registry", () => {
    const custom = new CliqClientRegistry();
    setCliqClientRegistry(custom);
    expect(getCliqClientRegistry()).toBe(custom);
  });

  it("resolveCliqClient uses the singleton and caches across calls", () => {
    const a = account();
    const c1 = resolveCliqClient(a);
    const c2 = resolveCliqClient(a);
    expect(c1).toBe(c2);
  });

  it("resolveCliqClient respects a registry installed via setCliqClientRegistry", () => {
    const custom = new CliqClientRegistry();
    setCliqClientRegistry(custom);
    const a = account();
    const c = resolveCliqClient(a);
    expect(custom.get(a)).toBe(c);
  });
});
