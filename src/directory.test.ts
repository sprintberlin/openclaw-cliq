import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  cliqDirectoryAdapter,
  applyCliqDirectoryQueryAndLimit,
} from "./directory.js";
import { setCliqClientRegistry } from "./runtime-api.js";
import type { OpenClawConfig } from "openclaw/plugin-sdk/channel-core";
import type {
  CliqChannelRecord,
  CliqUserRecord,
} from "./client.js";

function cfgWith(section: Record<string, unknown>): OpenClawConfig {
  return { channels: { cliq: section } } as unknown as OpenClawConfig;
}

const CONFIGURED = cfgWith({
  clientId: "id",
  clientSecret: "secret",
  botId: "mybot",
  botName: "My Bot",
});

interface FetchMock {
  restore: () => void;
  requests: { url: string; method: string }[];
}

/** Install a fetch mock that serves the OAuth + users + channels endpoints. */
function installFetch(opts: {
  users?: CliqUserRecord[];
  channels?: CliqChannelRecord[];
  usersStatus?: number;
  channelsStatus?: number;
  tokenStatus?: number;
} = {}): FetchMock {
  const original = globalThis.fetch;
  const requests: { url: string; method: string }[] = [];
  globalThis.fetch = (async (
    input: URL | string,
    init?: RequestInit,
  ) => {
    const url = typeof input === "string" ? input : input.toString();
    const method = init?.method ?? "GET";
    requests.push({ url, method });
    if (url.includes("/oauth/v2/token")) {
      const status = opts.tokenStatus ?? 200;
      if (status !== 200) {
        return new Response(JSON.stringify({ error: "invalid_client" }), {
          status,
        });
      }
      return new Response(
        JSON.stringify({ access_token: "tok", expires_in: 3600 }),
        { status: 200 },
      );
    }
    if (url.includes("/api/v2/users")) {
      const status = opts.usersStatus ?? 200;
      if (status !== 200) {
        return new Response('{"error":"denied"}', { status });
      }
      return new Response(
        JSON.stringify({ users: opts.users ?? [] }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }
    if (url.includes("/api/v2/channels")) {
      const status = opts.channelsStatus ?? 200;
      if (status !== 200) {
        return new Response('{"error":"denied"}', { status });
      }
      return new Response(
        JSON.stringify({ channels: opts.channels ?? [] }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }
    return new Response("", { status: 404 });
  }) as typeof fetch;
  return {
    restore: () => {
      globalThis.fetch = original;
    },
    get requests() {
      return requests;
    },
  };
}

describe("cliq directory adapter", () => {
  beforeEach(() => setCliqClientRegistry(null));
  afterEach(() => setCliqClientRegistry(null));

  it("self returns the configured bot identity without an API call", async () => {
    const fetch = installFetch();
    try {
      const self = await cliqDirectoryAdapter.self?.({
        cfg: CONFIGURED,
        accountId: undefined,
        // The directory adapter passes a runtime env; we don't use it.
        runtime: {} as never,
      });
      expect(self).toEqual({
        kind: "user",
        id: "mybot",
        name: "My Bot",
      });
      // No HTTP call should have been made for `self` (pure config lookup).
      expect(
        fetch.requests.filter((r) => r.url.includes("/api/v2/")),
      ).toHaveLength(0);
    } finally {
      fetch.restore();
    }
  });

  it("self returns null when the channel is unconfigured", async () => {
    const fetch = installFetch();
    try {
      const self = await cliqDirectoryAdapter.self?.({
        cfg: cfgWith({}),
        accountId: undefined,
        runtime: {} as never,
      });
      expect(self).toBeNull();
    } finally {
      fetch.restore();
    }
  });

  it("listPeers fetches users with the Users.READ scope", async () => {
    const users: CliqUserRecord[] = [
      { id: "u1", first_name: "Ada", last_name: "Lovelace", email: "ada@x.com" },
      { id: "u2", name: "Grace Hopper" },
    ];
    const fetch = installFetch({ users });
    try {
      const peers = (await cliqDirectoryAdapter.listPeers?.({
        cfg: CONFIGURED,
        accountId: undefined,
        query: null,
        limit: null,
        runtime: {} as never,
      }))!;
      expect(peers).toHaveLength(2);
      expect(peers[0]).toMatchObject({ kind: "user", id: "u1", name: "Ada Lovelace" });
      expect(peers[1]).toMatchObject({ kind: "user", id: "u2", name: "Grace Hopper" });
      // The users endpoint was hit with a scoped token request.
      const oauth = fetch.requests.filter((r) =>
        r.url.includes("/oauth/v2/token"),
      );
      expect(oauth).toHaveLength(1);
      expect(oauth[0].url).toContain("scope=ZohoCliq.Users.READ");
      const usersCall = fetch.requests.filter((r) =>
        r.url.includes("/api/v2/users"),
      );
      expect(usersCall).toHaveLength(1);
    } finally {
      fetch.restore();
    }
  });

  it("listPeers tolerates user_id field and missing names", async () => {
    const users: CliqUserRecord[] = [
      { user_id: "u9", email: "bot@x.com" },
    ];
    const fetch = installFetch({ users });
    try {
      const peers = (await cliqDirectoryAdapter.listPeers?.({
        cfg: CONFIGURED,
        accountId: undefined,
        query: null,
        limit: null,
        runtime: {} as never,
      }))!;
      expect(peers).toHaveLength(1);
      expect(peers[0].id).toBe("u9");
      expect(peers[0].name).toBe("bot@x.com");
    } finally {
      fetch.restore();
    }
  });

  it("listGroups fetches channels with the Channels.READ scope", async () => {
    const channels: CliqChannelRecord[] = [
      { id: "c1", name: "Engineering", unique_name: "eng" },
      { id: "c2", unique_name: "ops" },
    ];
    const fetch = installFetch({ channels });
    try {
      const groups = (await cliqDirectoryAdapter.listGroups?.({
        cfg: CONFIGURED,
        accountId: undefined,
        query: null,
        limit: null,
        runtime: {} as never,
      }))!;
      expect(groups).toHaveLength(2);
      expect(groups[0]).toMatchObject({
        kind: "group",
        id: "c1",
        name: "Engineering",
        handle: "eng",
      });
      expect(groups[1]).toMatchObject({ kind: "group", id: "c2", handle: "ops" });
      const oauth = fetch.requests.filter((r) =>
        r.url.includes("/oauth/v2/token"),
      );
      expect(oauth[0].url).toContain("scope=ZohoCliq.Channels.READ");
    } finally {
      fetch.restore();
    }
  });

  it("listPeers applies the query filter across id/name/handle", async () => {
    const users: CliqUserRecord[] = [
      { id: "u1", name: "Ada Ops" },
      { id: "u2", name: "Grace" },
      { id: "ops-team", name: "Ops" },
    ];
    const fetch = installFetch({ users });
    try {
      const peers = (await cliqDirectoryAdapter.listPeers?.({
        cfg: CONFIGURED,
        accountId: undefined,
        query: "ops",
        limit: null,
        runtime: {} as never,
      }))!;
      expect(peers.map((p) => p.id).sort()).toEqual(["ops-team", "u1"]);
    } finally {
      fetch.restore();
    }
  });

  it("listPeers applies the limit cap after filtering", async () => {
    const users: CliqUserRecord[] = Array.from({ length: 10 }, (_, i) => ({
      id: `u${i}`,
      name: `User ${i}`,
    }));
    const fetch = installFetch({ users });
    try {
      const peers = (await cliqDirectoryAdapter.listPeers?.({
        cfg: CONFIGURED,
        accountId: undefined,
        query: null,
        limit: 3,
        runtime: {} as never,
      }))!;
      expect(peers).toHaveLength(3);
    } finally {
      fetch.restore();
    }
  });

  it("listPeers returns an empty list when the channel is unconfigured", async () => {
    const fetch = installFetch();
    try {
      const peers = await cliqDirectoryAdapter.listPeers?.({
        cfg: cfgWith({}),
        accountId: undefined,
        query: null,
        limit: null,
        runtime: {} as never,
      });
      expect(peers).toEqual([]);
      expect(fetch.requests).toHaveLength(0);
    } finally {
      fetch.restore();
    }
  });

  it("listPeers degrades to an empty list on an API error (never throws)", async () => {
    const fetch = installFetch({ usersStatus: 403 });
    try {
      const peers = await cliqDirectoryAdapter.listPeers?.({
        cfg: CONFIGURED,
        accountId: undefined,
        query: null,
        limit: null,
        runtime: {} as never,
      });
      expect(peers).toEqual([]);
    } finally {
      fetch.restore();
    }
  });

  it("listPeers degrades to an empty list on an OAuth failure", async () => {
    const fetch = installFetch({ tokenStatus: 401 });
    try {
      const peers = await cliqDirectoryAdapter.listPeers?.({
        cfg: CONFIGURED,
        accountId: undefined,
        query: null,
        limit: null,
        runtime: {} as never,
      });
      expect(peers).toEqual([]);
    } finally {
      fetch.restore();
    }
  });

  it("paginates users until the page is exhausted or maxItems is reached", async () => {
    // Page 1: 200 records, page 2: 50 records (total 250). With limit=200
    // the adapter should only fetch one page (maxItems=200).
    const page1 = Array.from({ length: 200 }, (_, i) => ({
      id: `u${i}`,
      name: `User ${i}`,
    }));
    const page2 = Array.from({ length: 50 }, (_, i) => ({
      id: `u${200 + i}`,
      name: `User ${200 + i}`,
    }));
    const original = globalThis.fetch;
    let usersCallCount = 0;
    globalThis.fetch = (async (input: URL | string) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url.includes("/oauth/v2/token")) {
        return new Response(
          JSON.stringify({ access_token: "tok", expires_in: 3600 }),
          { status: 200 },
        );
      }
      if (url.includes("/api/v2/users")) {
        usersCallCount++;
        const recs = usersCallCount === 1 ? page1 : page2;
        return new Response(JSON.stringify({ users: recs }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      return new Response("", { status: 404 });
    }) as typeof fetch;
    try {
      const peers = await cliqDirectoryAdapter.listPeers?.({
        cfg: CONFIGURED,
        accountId: undefined,
        query: null,
        limit: 200,
        runtime: {} as never,
      });
      expect(peers).toHaveLength(200);
      // Only one users page was fetched (limit cap hit).
      expect(usersCallCount).toBe(1);
    } finally {
      globalThis.fetch = original;
    }
  });

  it("skips user records without a resolvable id", async () => {
    const users: CliqUserRecord[] = [
      { first_name: "NoId" }, // no id / user_id
      { id: "u1", name: "Good" },
    ];
    const fetch = installFetch({ users });
    try {
      const peers = (await cliqDirectoryAdapter.listPeers?.({
        cfg: CONFIGURED,
        accountId: undefined,
        query: null,
        limit: null,
        runtime: {} as never,
      }))!;
      expect(peers).toHaveLength(1);
      expect(peers[0].id).toBe("u1");
    } finally {
      fetch.restore();
    }
  });
});

describe("applyCliqDirectoryQueryAndLimit", () => {
  it("filters case-insensitively across id, name, and handle", () => {
    const entries = [
      { kind: "user" as const, id: "u1", name: "Ada Ops" },
      { kind: "group" as const, id: "c1", name: "Engineering", handle: "eng-ops" },
      { kind: "user" as const, id: "u2", name: "Grace" },
    ];
    const out = applyCliqDirectoryQueryAndLimit(entries, "OPS", null);
    expect(out.map((e) => e.id).sort()).toEqual(["c1", "u1"]);
  });

  it("applies the limit after filtering", () => {
    const entries = Array.from({ length: 5 }, (_, i) => ({
      kind: "user" as const,
      id: `u${i}`,
      name: `User ${i}`,
    }));
    expect(applyCliqDirectoryQueryAndLimit(entries, "user", 2)).toHaveLength(2);
  });

  it("returns all entries when query is empty and limit is null", () => {
    const entries = [
      { kind: "user" as const, id: "u1" },
      { kind: "group" as const, id: "c1" },
    ];
    expect(applyCliqDirectoryQueryAndLimit(entries, null, null)).toHaveLength(2);
  });
});

/**
 * v3 directory dead-end regression guard.
 *
 * v3 has NO org-user / channel directory: `GET /api/v3/chats?type=dm|channel`
 * returns only the chats the bot has ALREADY conversed with — a semantic change,
 * not a clean swap. `openclaw directory` lists ALL org users / channels, so the
 * `listUsers` / `listChannels` paths stay on `/api/v2/...` indefinitely,
 * REGARDLESS of the `apiVersion` opt-in. These tests lock that invariant so a
 * future contributor does not wire the directory to a v3 path that cannot list
 * the full org directory. See docs/learnings/094-*.md.
 */
describe("CliqClient directory listing stays on /api/v2 regardless of apiVersion", () => {
  beforeEach(() => setCliqClientRegistry(null));
  afterEach(() => setCliqClientRegistry(null));

  it("listUsers hits /api/v2/users (never /api/v3/) even when apiVersion==='v3'", async () => {
    const { CliqClient } = await import("./client.js");
    const client = new CliqClient(
      "id", "secret", "bot",
      undefined, undefined,
      { maxAttempts: 1, baseDelayMs: 1, maxDelayMs: 1, sleep: async () => {}, random: () => 0 },
      undefined, undefined, "v3",
    );
    const seen: string[] = [];
    const original = globalThis.fetch;
    globalThis.fetch = (async (url: URL | string) => {
      const urlStr = typeof url === "string" ? url : url.toString();
      seen.push(urlStr);
      if (urlStr.includes("/oauth/v2/token")) {
        return new Response(
          JSON.stringify({ access_token: "tok", expires_in: 3600 }),
          { status: 200 },
        );
      }
      if (urlStr.includes("/api/v2/users")) {
        return new Response(JSON.stringify({ users: [] }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      return new Response("", { status: 404 });
    }) as typeof fetch;
    try {
      await client.listUsers(10);
    } finally {
      globalThis.fetch = original;
    }
    const usersCall = seen.find((u) => u.includes("/api/v2/users"));
    expect(usersCall).toBeDefined();
    expect(seen.some((u) => u.includes("/api/v3/"))).toBe(false);
  });

  it("listChannels hits /api/v2/channels (never /api/v3/) even when apiVersion==='v3'", async () => {
    const { CliqClient } = await import("./client.js");
    const client = new CliqClient(
      "id", "secret", "bot",
      undefined, undefined,
      { maxAttempts: 1, baseDelayMs: 1, maxDelayMs: 1, sleep: async () => {}, random: () => 0 },
      undefined, undefined, "v3",
    );
    const seen: string[] = [];
    const original = globalThis.fetch;
    globalThis.fetch = (async (url: URL | string) => {
      const urlStr = typeof url === "string" ? url : url.toString();
      seen.push(urlStr);
      if (urlStr.includes("/oauth/v2/token")) {
        return new Response(
          JSON.stringify({ access_token: "tok", expires_in: 3600 }),
          { status: 200 },
        );
      }
      if (urlStr.includes("/api/v2/channels")) {
        return new Response(JSON.stringify({ channels: [] }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      return new Response("", { status: 404 });
    }) as typeof fetch;
    try {
      await client.listChannels(10);
    } finally {
      globalThis.fetch = original;
    }
    const channelsCall = seen.find((u) => u.includes("/api/v2/channels"));
    expect(channelsCall).toBeDefined();
    expect(seen.some((u) => u.includes("/api/v3/"))).toBe(false);
  });
});
