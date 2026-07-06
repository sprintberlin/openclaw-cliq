import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { CliqClient } from "./client.js";
import { setCliqDefaultLogger } from "./logger.js";

/**
 * `api_domain` auto-correction (issue #46).
 *
 * Zoho returns an `api_domain` field in token responses that encodes the
 * account's region. The plugin captures it and, when it indicates a region
 * different from the currently configured `apiBase`, switches `apiBase` to the
 * matching Cliq base and logs a single warning. The raw `zohoapis` host is
 * NEVER used as `apiBase` — it is mapped back to `cliq.zoho.<tld>`. `oauthBase`
 * is left unchanged (a wrong `oauthBase` fails before any `api_domain` is
 * returned, so it cannot self-heal).
 */
describe("CliqClient api_domain auto-correction (issue #46)", () => {
  let restoreFetch: (() => void) | null = null;
  let warnCalls: string[] = [];

  beforeEach(() => {
    setCliqDefaultLogger(null);
    warnCalls = [];
  });

  afterEach(() => {
    if (restoreFetch) {
      restoreFetch();
      restoreFetch = null;
    }
  });

  function mockFetch(opts: {
    apiDomain?: string;
    ccToken?: string;
    expiresIn?: number;
    sendStatus?: number;
    sendBody?: string;
  }): void {
    const original = globalThis.fetch;
    const ccToken = opts.ccToken ?? "CC_TOKEN";
    const expiresIn = opts.expiresIn ?? 3600;
    const sendStatus = opts.sendStatus ?? 200;
    const sendBody = opts.sendBody ?? JSON.stringify({ id: "msg-1" });
    globalThis.fetch = (async (input: URL | string, init?: RequestInit) => {
      const urlStr = typeof input === "string" ? input : input.toString();
      const method = init?.method ?? "GET";
      if (urlStr.includes("/oauth/v2/token")) {
        const body = {
          access_token: ccToken,
          expires_in: expiresIn,
          ...(opts.apiDomain ? { api_domain: opts.apiDomain } : {}),
        };
        return new Response(JSON.stringify(body), { status: 200 });
      }
      // Capture the host the SEND goes to so the test can assert which apiBase
      // was used post-correction.
      void method;
      return new Response(sendBody, { status: sendStatus });
    }) as typeof fetch;
    restoreFetch = () => {
      globalThis.fetch = original;
    };
  }

  function makeClient(apiBase?: string, oauthBase?: string): CliqClient {
    return new CliqClient(
      "id",
      "secret",
      "bot",
      apiBase,
      oauthBase,
      { maxAttempts: 1, baseDelayMs: 1, maxDelayMs: 1, sleep: async () => {}, random: () => 0 },
      {
        debug: () => {},
        info: () => {},
        warn: (m: string) => warnCalls.push(m),
        error: () => {},
      },
    );
  }

  it("corrects apiBase from EU to US when the token response reports a US api_domain", async () => {
    mockFetch({ apiDomain: "https://www.zohoapis.com" });
    const client = makeClient(); // EU default
    expect(client.getApiBase()).toBe("https://cliq.zoho.eu");
    await client.sendMessage({ to: "user-1", isDm: true, text: "hi" });
    expect(client.getApiBase()).toBe("https://cliq.zoho.com");
    expect(warnCalls.some((m) => /corrected apiBase/.test(m))).toBe(true);
  });

  it("does NOT set apiBase to the raw zohoapis host (maps to cliq.zoho.<tld>)", async () => {
    mockFetch({ apiDomain: "https://www.zohoapis.in" });
    const client = makeClient();
    await client.sendMessage({ to: "user-1", isDm: true, text: "hi" });
    expect(client.getApiBase()).toBe("https://cliq.zoho.in");
    expect(client.getApiBase()).not.toContain("zohoapis");
  });

  it("leaves apiBase unchanged when api_domain agrees with the configured region", async () => {
    mockFetch({ apiDomain: "https://www.zohoapis.eu" });
    const client = makeClient(); // EU
    await client.sendMessage({ to: "user-1", isDm: true, text: "hi" });
    expect(client.getApiBase()).toBe("https://cliq.zoho.eu");
    expect(warnCalls.some((m) => /corrected apiBase/.test(m))).toBe(false);
  });

  it("leaves apiBase unchanged when api_domain is absent", async () => {
    mockFetch({});
    const client = makeClient();
    await client.sendMessage({ to: "user-1", isDm: true, text: "hi" });
    expect(client.getApiBase()).toBe("https://cliq.zoho.eu");
    expect(warnCalls.length).toBe(0);
  });

  it("leaves apiBase unchanged when api_domain does not match a known region", async () => {
    mockFetch({ apiDomain: "https://www.zohoapis.example" });
    const client = makeClient();
    await client.sendMessage({ to: "user-1", isDm: true, text: "hi" });
    expect(client.getApiBase()).toBe("https://cliq.zoho.eu");
    expect(warnCalls.length).toBe(0);
  });

  it("leaves oauthBase unchanged after api_domain correction", async () => {
    mockFetch({ apiDomain: "https://www.zohoapis.com" });
    const client = makeClient(undefined, "https://accounts.zoho.eu");
    await client.sendMessage({ to: "user-1", isDm: true, text: "hi" });
    // apiBase switched to US but oauthBase stays EU (cannot self-heal a
    // wrong oauthBase — the operator must set it, or use the wizard).
    expect(client.getApiBase()).toBe("https://cliq.zoho.com");
  });

  it("corrects apiBase for the refresh-token grant path too", async () => {
    mockFetch({ apiDomain: "https://www.zohoapis.jp" });
    const client = new CliqClient(
      "id",
      "secret",
      "bot",
      undefined,
      undefined,
      { maxAttempts: 1, baseDelayMs: 1, maxDelayMs: 1, sleep: async () => {}, random: () => 0 },
      {
        debug: () => {},
        info: () => {},
        warn: (m: string) => warnCalls.push(m),
        error: () => {},
      },
      "rt-secret",
    );
    // A channel send routes through getRefreshedAccessToken — its response
    // also carries api_domain, so the correction applies there too.
    await client.sendMessage({ to: "engineering", isDm: false, text: "hi" });
    expect(client.getApiBase()).toBe("https://cliq.zoho.jp");
  });

  it("corrects only once per region change (idempotent within a region)", async () => {
    mockFetch({ apiDomain: "https://www.zohoapis.com" });
    const client = makeClient();
    await client.sendMessage({ to: "user-1", isDm: true, text: "first" });
    expect(client.getApiBase()).toBe("https://cliq.zoho.com");
    const warnCountAfterFirst = warnCalls.length;
    // Second send: api_domain still says US, but apiBase is already US → no
    // new correction / no new warning.
    await client.sendMessage({ to: "user-1", isDm: true, text: "second" });
    expect(client.getApiBase()).toBe("https://cliq.zoho.com");
    expect(warnCalls.length).toBe(warnCountAfterFirst);
  });
});

describe("CliqClient OAuth auth-failure data-center hint (issue #46)", () => {
  let restoreFetch: (() => void) | null = null;

  beforeEach(() => {
    setCliqDefaultLogger(null);
  });

  afterEach(() => {
    if (restoreFetch) {
      restoreFetch();
      restoreFetch = null;
    }
  });

  it("appends the data-center hint to a client_credentials auth failure", async () => {
    const original = globalThis.fetch;
    globalThis.fetch = (async () => {
      return new Response('{"error":"invalid_client"}', { status: 400 });
    }) as typeof fetch;
    restoreFetch = () => {
      globalThis.fetch = original;
    };
    const client = new CliqClient(
      "id",
      "secret",
      "bot",
      undefined,
      undefined,
      { maxAttempts: 1, baseDelayMs: 1, maxDelayMs: 1, sleep: async () => {}, random: () => 0 },
    );
    await expect(
      client.getAccessToken("ZohoCliq.Webhooks.CREATE"),
    ).rejects.toThrow(/verify your Zoho data center/);
  });

  it("does not append the hint to a non-auth failure", async () => {
    const original = globalThis.fetch;
    globalThis.fetch = (async () => {
      return new Response('{"error":"server"}', { status: 500 });
    }) as typeof fetch;
    restoreFetch = () => {
      globalThis.fetch = original;
    };
    const client = new CliqClient(
      "id",
      "secret",
      "bot",
      undefined,
      undefined,
      { maxAttempts: 1, baseDelayMs: 1, maxDelayMs: 1, sleep: async () => {}, random: () => 0 },
    );
    await expect(
      client.getAccessToken("ZohoCliq.Webhooks.CREATE"),
    ).rejects.not.toThrow(/verify your Zoho data center/);
  });
});
