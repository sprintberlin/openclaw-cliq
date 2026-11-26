import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { CliqClient } from "./client.js";
import { setCliqDefaultLogger, truncateForLog, type CliqLogger } from "./logger.js";

/**
 * Outbound send observability (issue #25). The outbound Cliq API call must be
 * visible in the gateway log: target kind + resolved id + text length on send,
 * HTTP status + message id on success, HTTP status + truncated body on a
 * non-2xx. None of the log lines may carry the OAuth token, clientSecret, or
 * webhook secret, and never the full message text.
 */
describe("CliqClient outbound logging (issue #25)", () => {
  let restoreFetch: (() => void) | null = null;

  beforeEach(() => {
    // The default logger is the console fallback; reset it so a prior test's
    // `setCliqDefaultLogger(null)` cannot leak into these cases. The tests
    // below pass an explicit logger to the constructor, so the default is not
    // consulted — but resetting keeps the surface clean.
    setCliqDefaultLogger(null);
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
  }): void {
    const original = globalThis.fetch;
    const oauthStatus = opts.oauthStatus ?? 200;
    const oauthBody = opts.oauthBody ?? { access_token: "ACCESS_TOKEN_VALUE_xyz", expires_in: 3600 };
    const sendStatus = opts.sendStatus ?? 200;
    const sendBody = opts.sendBody ?? JSON.stringify({ id: "msg-1" });
    globalThis.fetch = (async (url: URL | string) => {
      const urlStr = typeof url === "string" ? url : url.toString();
      if (urlStr.includes("/oauth/v2/token")) {
        return new Response(JSON.stringify(oauthBody), { status: oauthStatus });
      }
      return new Response(sendBody, { status: sendStatus });
    }) as typeof fetch;
    restoreFetch = () => {
      globalThis.fetch = original;
    };
  }

  it("logs target kind + resolved id + text length on send, then status + messageId on 2xx", async () => {
    const logger = {
      debug: () => {},
      info: () => {},
      warn: () => {},
      error: () => {},
    };
    const calls: { level: keyof typeof logger; msg: string }[] = [];
    for (const level of ["debug", "info", "warn", "error"] as const) {
      (logger as Record<string, (m: string) => void>)[level] = (msg: string) => {
        calls.push({ level, msg });
      };
    }
    mockFetch({ sendBody: JSON.stringify({ id: "msg-xyz" }) });

    const client = new CliqClient("id", "secret", "bot", undefined, undefined, {
      maxAttempts: 1,
      baseDelayMs: 1,
      maxDelayMs: 1,
      sleep: async () => {},
      random: () => 0,
    }, logger);

    const result = await client.sendMessage({ to: "user-7", isDm: true, text: "hello world" });
    expect(result.messageId).toBe("msg-xyz");

    // Pre-send log carries kind + id + text length (NOT the text itself).
    const sendLog = calls.find((c) => c.level === "info" && c.msg.includes("[cliq] send:"));
    expect(sendLog).toBeDefined();
    expect(sendLog!.msg).toContain("dm");
    expect(sendLog!.msg).toContain("id=user-7");
    expect(sendLog!.msg).toContain("textLen=11");
    expect(sendLog!.msg).not.toContain("hello world");

    // Success log carries status + messageId.
    const okLog = calls.find((c) => c.level === "info" && c.msg.includes("[cliq] send ok:"));
    expect(okLog).toBeDefined();
    expect(okLog!.msg).toContain("status=200");
    expect(okLog!.msg).toContain("messageId=msg-xyz");

    // The access token value must NEVER appear in any log line (only the
    // word "token" in the oauth flow labels is permitted).
    for (const c of calls) {
      expect(c.msg).not.toContain("ACCESS_TOKEN_VALUE_xyz");
    }
  });

  it("logs status + truncated body on a non-2xx send response", async () => {
    const calls: { level: string; msg: string }[] = [];
    const logger = {
      debug: (m: string) => calls.push({ level: "debug", msg: m }),
      info: (m: string) => calls.push({ level: "info", msg: m }),
      warn: (m: string) => calls.push({ level: "warn", msg: m }),
      error: (m: string) => calls.push({ level: "error", msg: m }),
    };
    // 400 format_rejected → CliqSendError thrown, but the warn line is
    // emitted inside the retry attempt callback before the throw.
    const longBody = "invalid markdown format: " + "x".repeat(800);
    mockFetch({ sendStatus: 400, sendBody: longBody });

    const client = new CliqClient("id", "secret", "bot", undefined, undefined, {
      maxAttempts: 1,
      baseDelayMs: 1,
      maxDelayMs: 1,
      sleep: async () => {},
      random: () => 0,
    }, logger);

    await expect(
      client.sendMessage({ to: "chan-1", isDm: false, text: "**bad**" }),
    ).rejects.toThrow(/cliq: send failed/);

    const warnLog = calls.find((c) => c.level === "warn" && c.msg.includes("[cliq] send non-2xx:"));
    expect(warnLog).toBeDefined();
    expect(warnLog!.msg).toContain("status=400");
    expect(warnLog!.msg).toContain("channel");
    expect(warnLog!.msg).toContain("id=chan-1");
    // Body must be present but truncated (the full 820-byte body must not
    // appear verbatim — it should carry the truncation marker).
    expect(warnLog!.msg).not.toContain("x".repeat(800));
    expect(warnLog!.msg).toContain("…(");
  });

  it("logs OAuth token fetch failures with status + body, without the secret", async () => {
    const calls: { level: string; msg: string }[] = [];
    const logger = {
      debug: (m: string) => calls.push({ level: "debug", msg: m }),
      info: (m: string) => calls.push({ level: "info", msg: m }),
      warn: (m: string) => calls.push({ level: "warn", msg: m }),
      error: (m: string) => calls.push({ level: "error", msg: m }),
    };
    mockFetch({ oauthStatus: 401, oauthBody: { error: "invalid_client" } });

    const client = new CliqClient("id", "CLIENT_SECRET_VALUE_xyz", "bot", undefined, undefined, {
      maxAttempts: 1,
      baseDelayMs: 1,
      maxDelayMs: 1,
      sleep: async () => {},
      random: () => 0,
    }, logger);

    await expect(
      client.sendMessage({ to: "user-1", isDm: true, text: "hi" }),
    ).rejects.toThrow(/OAuth token request failed/);

    const errLog = calls.find((c) => c.level === "error" && c.msg.includes("[cliq] oauth:"));
    expect(errLog).toBeDefined();
    expect(errLog!.msg).toContain("status=401");
    // The client_secret must never appear in any log line.
    for (const c of calls) {
      expect(c.msg).not.toContain("CLIENT_SECRET_VALUE_xyz");
    }
  });

  it("logs edit send/edit status with chatId + messageId", async () => {
    const calls: { level: string; msg: string }[] = [];
    const logger = {
      debug: (m: string) => calls.push({ level: "debug", msg: m }),
      info: (m: string) => calls.push({ level: "info", msg: m }),
      warn: (m: string) => calls.push({ level: "warn", msg: m }),
      error: (m: string) => calls.push({ level: "error", msg: m }),
    };
    mockFetch({
      sendBody: JSON.stringify({ message_id: "m-1", chat_id: "CT_x" }),
    });

    const client = new CliqClient("id", "secret", "bot", undefined, undefined, {
      maxAttempts: 1,
      baseDelayMs: 1,
      maxDelayMs: 1,
      sleep: async () => {},
      random: () => 0,
    }, logger);

    await client.editMessage({ chatId: "CT_chat1", messageId: "m-1", text: "*updated*" });

    const editLog = calls.find((c) => c.level === "info" && c.msg.includes("[cliq] edit:"));
    expect(editLog).toBeDefined();
    expect(editLog!.msg).toContain("chatId=CT_chat1");
    expect(editLog!.msg).toContain("messageId=m-1");
    expect(editLog!.msg).toContain("textLen=9");

    const okLog = calls.find((c) => c.level === "info" && c.msg.includes("[cliq] edit ok:"));
    expect(okLog).toBeDefined();
    expect(okLog!.msg).toContain("status=200");
  });
});

describe("CliqClient transport diagnostics (issue #353)", () => {
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

  const retry = {
    maxAttempts: 3,
    baseDelayMs: 500,
    maxDelayMs: 8_000,
    sleep: async () => {},
    random: () => 0.5,
  };

  function captureLogger(): { logger: CliqLogger; calls: { level: string; msg: string }[] } {
    const calls: { level: string; msg: string }[] = [];
    const logger: CliqLogger = {};
    for (const level of ["debug", "info", "warn", "error"] as const) {
      logger[level] = (msg: string) => calls.push({ level, msg });
    }
    return { logger, calls };
  }

  function mockFetch(send: (url: string, init: RequestInit | undefined, n: number) => Response | Promise<Response>): {
    calls: number;
  } {
    const original = globalThis.fetch;
    const state = { calls: 0 };
    globalThis.fetch = (async (url: URL | string, init?: RequestInit) => {
      const urlStr = typeof url === "string" ? url : url.toString();
      if (urlStr.includes("/oauth/v2/token")) {
        return new Response(JSON.stringify({ access_token: "ACCESS_TOKEN_VALUE_xyz", expires_in: 3600 }), {
          status: 200,
        });
      }
      state.calls++;
      return await send(urlStr, init, state.calls);
    }) as typeof fetch;
    restoreFetch = () => {
      globalThis.fetch = original;
    };
    return state;
  }

  function nestedFetchFailed(code: string, syscall: string): TypeError {
    return Object.assign(new TypeError("fetch failed"), {
      cause: { code, syscall, message: "connect https://cliq.zoho.eu token=ACCESS_TOKEN_VALUE_xyz" },
    });
  }

  function tokenResponse(token = "ACCESS_TOKEN_VALUE_xyz"): Response {
    return new Response(JSON.stringify({ access_token: token, expires_in: 3600 }), { status: 200 });
  }

  function mockOAuthFetch(
    oauth: (n: number) => Response | Promise<Response>,
  ): { oauth: number; sends: number; grants: string[] } {
    const original = globalThis.fetch;
    const state = { oauth: 0, sends: 0, grants: [] as string[] };
    globalThis.fetch = (async (url: URL | string) => {
      const urlStr = typeof url === "string" ? url : url.toString();
      if (urlStr.includes("/oauth/v2/token")) {
        state.oauth++;
        state.grants.push(urlStr.includes("grant_type=refresh_token") ? "refresh_token" : "client_credentials");
        return await oauth(state.oauth);
      }
      state.sends++;
      return new Response(JSON.stringify({ id: "msg-1" }), { status: 200 });
    }) as typeof fetch;
    restoreFetch = () => {
      globalThis.fetch = original;
    };
    return state;
  }

  it("recovers a send after a nested ECONNRESET and logs the retry without secrets", async () => {
    const { logger, calls } = captureLogger();
    const state = mockFetch((_url, _init, n) => {
      if (n === 1) throw nestedFetchFailed("ECONNRESET", "read");
      return new Response(JSON.stringify({ id: "msg-recovered" }), { status: 200 });
    });
    const client = new CliqClient("id", "CLIENT_SECRET_VALUE_xyz", "bot", undefined, undefined, retry, logger);

    const result = await client.sendMessage({ to: "user-7", isDm: true, text: "hello world" });

    expect(result.messageId).toBe("msg-recovered");
    expect(state.calls).toBe(2);
    const retryLog = calls.find((c) => c.level === "warn" && c.msg.includes("transport retry"));
    expect(retryLog?.msg).toContain("op=send");
    expect(retryLog?.msg).toContain("attempt=1/2");
    expect(retryLog?.msg).toContain("code=ECONNRESET");
    expect(retryLog?.msg).toContain("syscall=read");
    expect(retryLog?.msg).toContain("dm id=user-7");
    expect(retryLog?.msg).toContain("delivery=ambiguous duplicateRisk=yes");
    const okLog = calls.find((c) => c.level === "info" && c.msg.includes("[cliq] send ok:"));
    expect(okLog?.msg).toContain("attempt=2");
    for (const c of calls) {
      expect(c.msg).not.toContain("ACCESS_TOKEN_VALUE_xyz");
      expect(c.msg).not.toContain("CLIENT_SECRET_VALUE_xyz");
      expect(c.msg).not.toContain("hello world");
      expect(c.msg).not.toContain("cliq.zoho.eu");
      expect(c.msg).not.toContain("fetch failed");
    }
  });

  it("exhausts an edit and preserves the nested cause", async () => {
    const { logger, calls } = captureLogger();
    const state = mockFetch(() => {
      throw nestedFetchFailed("ETIMEDOUT", "connect");
    });
    const client = new CliqClient("id", "secret", "bot", undefined, undefined, retry, logger, "refresh-token");

    const caught = await client
      .editMessage({ chatId: "CT_chat1", messageId: "m-1", text: "*updated*" })
      .catch((err: unknown) => err);

    expect(state.calls).toBe(3);
    expect(caught).toBeInstanceOf(TypeError);
    const err = caught as TypeError & { cause?: { code?: string } };
    expect(err.cause?.code).toBe("ETIMEDOUT");
    const transport = calls.filter((c) => c.msg.includes("transport"));
    expect(transport.map((c) => c.level)).toEqual(["warn", "warn", "error"]);
    expect(transport.at(-1)?.msg).toContain("op=edit");
    expect(transport.at(-1)?.msg).toContain("attempt=3/3");
    expect(transport.at(-1)?.msg).toContain("transport exhausted");
    expect(transport.at(-1)?.msg).toContain("code=ETIMEDOUT");
    expect(transport.at(-1)?.msg).toContain("syscall=connect");
    expect(transport.at(-1)?.msg).toContain("chatId=CT_chat1");
    expect(transport.at(-1)?.msg).toContain("messageId=m-1");
    expect(transport.at(-1)?.msg).toContain("duplicateRisk=no");
    expect(transport.at(-1)?.msg).not.toContain("*updated*");
  });

  it("stops at the send cap after a transport failure is followed by an HTTP 5xx", async () => {
    const { logger, calls } = captureLogger();
    const state = mockFetch((_url, _init, n) => {
      if (n === 1) throw nestedFetchFailed("ECONNRESET", "read");
      return new Response("down https://cliq.zoho.eu", { status: 503 });
    });
    const client = new CliqClient("id", "secret", "bot", undefined, undefined, retry, logger);

    await expect(
      client.sendMessage({ to: "user-7", isDm: true, text: "hello world" }),
    ).rejects.toMatchObject({ kind: "transient", status: 503 });

    expect(state.calls).toBe(2);
    const transport = calls.filter((c) => c.msg.includes("transport"));
    expect(transport).toHaveLength(1);
    expect(transport[0]?.msg).toContain("attempt=1/2");
    const non2xx = calls.filter((c) => c.msg.includes("[cliq] send non-2xx:"));
    expect(non2xx.map((c) => c.msg.match(/attempt=(\d+)/)?.[1])).toEqual(["2"]);
    for (const c of calls) {
      expect(c.msg).not.toContain("ACCESS_TOKEN_VALUE_xyz");
      expect(c.msg).not.toContain("hello world");
    }
  });

  it("logs an unrecognized fetch failed cause without retrying it or leaking the message", async () => {
    const { logger, calls } = captureLogger();
    const state = mockFetch(() => {
      throw nestedFetchFailed("ERR_SOMETHING_NEW", "connect");
    });
    const client = new CliqClient("id", "secret", "bot", undefined, undefined, retry, logger);

    const caught = await client
      .sendMessage({ to: "user-7", isDm: true, text: "hello world" })
      .catch((err: unknown) => err);

    expect(state.calls).toBe(1);
    expect(caught).toBeInstanceOf(TypeError);
    expect((caught as TypeError & { cause?: { code?: string } }).cause?.code).toBe("ERR_SOMETHING_NEW");
    const transport = calls.filter((c) => c.msg.includes("transport"));
    expect(transport.map((c) => c.level)).toEqual(["error"]);
    expect(transport[0]?.msg).toContain("transport not_retryable");
    expect(transport[0]?.msg).toContain("attempt=1/2");
    expect(transport[0]?.msg).toContain("code=ERR_SOMETHING_NEW");
    expect(transport[0]?.msg).toContain("syscall=connect");
    expect(transport[0]?.msg).toContain("cause=unrecognized");
    expect(transport[0]?.msg).toContain("delivery=ambiguous duplicateRisk=yes");
    for (const c of calls) {
      expect(c.msg).not.toContain("ACCESS_TOKEN_VALUE_xyz");
      expect(c.msg).not.toContain("CLIENT_SECRET_VALUE_xyz");
      expect(c.msg).not.toContain("hello world");
      expect(c.msg).not.toContain("cliq.zoho.eu");
      expect(c.msg).not.toContain("fetch failed");
    }
  });

  it("logs an unknown send exception as not-retrying without its message", async () => {
    const { logger, calls } = captureLogger();
    const state = mockFetch(() => {
      throw new Error("programmer error token=ACCESS_TOKEN_VALUE_xyz https://cliq.zoho.eu");
    });
    const client = new CliqClient("id", "secret", "bot", undefined, undefined, retry, logger);

    await expect(
      client.sendMessage({ to: "user-1", isDm: true, text: "hi" }),
    ).rejects.toThrow("programmer error");

    expect(state.calls).toBe(1);
    const transport = calls.filter((c) => c.msg.includes("transport"));
    expect(transport.map((c) => c.level)).toEqual(["error"]);
    expect(transport[0]?.msg).toContain("[cliq] send transport not_retryable: op=send");
    expect(transport[0]?.msg).toContain("attempt=1/2");
    expect(transport[0]?.msg).toContain("error=Error");
    expect(transport[0]?.msg).toContain("cause=unrecognized");
    for (const c of calls) {
      expect(c.msg).not.toContain("programmer error");
      expect(c.msg).not.toContain("ACCESS_TOKEN_VALUE_xyz");
      expect(c.msg).not.toContain("cliq.zoho.eu");
    }
  });

  it("omits a target id that is not a safe opaque identifier", async () => {
    const { logger, calls } = captureLogger();
    mockFetch(() => {
      throw nestedFetchFailed("ECONNRESET", "read");
    });
    const client = new CliqClient("id", "secret", "bot", undefined, undefined, retry, logger);

    await expect(
      client.sendMessage({ to: "user-7\n[cliq] send ok: forged", isDm: true, text: "hi" }),
    ).rejects.toThrow("fetch failed");

    const transport = calls.filter((c) => c.msg.includes("transport"));
    expect(transport).toHaveLength(2);
    for (const c of transport) {
      expect(c.msg).not.toContain("forged");
      expect(c.msg).not.toContain("\n");
      expect(c.msg).toContain("op=send");
      expect(c.msg).toContain("attempt=");
    }
  });

  it("recovers a client_credentials token fetch from a transient transport failure", async () => {
    const { logger, calls } = captureLogger();
    const state = mockOAuthFetch((n) => {
      if (n === 1) throw nestedFetchFailed("ECONNRESET", "read");
      return tokenResponse();
    });
    const client = new CliqClient("id", "CLIENT_SECRET_VALUE_xyz", "bot", undefined, undefined, retry, logger);

    const token = await client.getAccessToken();

    expect(token).toBe("ACCESS_TOKEN_VALUE_xyz");
    expect(state.oauth).toBe(2);
    const transport = calls.filter((c) => c.msg.includes("transport"));
    expect(transport.map((c) => c.level)).toEqual(["warn"]);
    expect(transport[0]?.msg).toBe("[cliq] oauth transport retry: op=oauth oauth attempt=1/3 error=TypeError code=ECONNRESET syscall=read delayMs=250");
    expect(transport[0]?.msg).not.toContain("ZohoCliq.");
    expect(transport[0]?.msg).not.toContain("accounts.zoho.eu");
    for (const c of calls) {
      expect(c.msg).not.toContain("ACCESS_TOKEN_VALUE_xyz");
      expect(c.msg).not.toContain("CLIENT_SECRET_VALUE_xyz");
      expect(c.msg).not.toContain("client_secret");
      expect(c.msg).not.toContain("fetch failed");
    }
  });

  it("recovers a refresh-token grant from a transient transport failure", async () => {
    const { logger, calls } = captureLogger();
    const state = mockOAuthFetch((n) => {
      if (n === 1) throw nestedFetchFailed("ECONNRESET", "read");
      return tokenResponse();
    });
    const client = new CliqClient("id", "secret", "bot", undefined, undefined, retry, logger, "rt-secret");

    const token = await client.getRefreshedAccessToken();

    expect(token).toBe("ACCESS_TOKEN_VALUE_xyz");
    expect(state.oauth).toBe(2);
    expect(state.grants).toEqual(["refresh_token", "refresh_token"]);
    const transport = calls.filter((c) => c.msg.includes("transport"));
    expect(transport.map((c) => c.level)).toEqual(["warn"]);
    expect(transport[0]?.msg).toContain("op=oauth");
    expect(transport[0]?.msg).toContain("attempt=1/3");
    for (const c of calls) {
      expect(c.msg).not.toContain("ACCESS_TOKEN_VALUE_xyz");
      expect(c.msg).not.toContain("rt-secret");
    }
  });

  it("exhausts a client_credentials token fetch at its cap and keeps the cause", async () => {
    const { logger, calls } = captureLogger();
    const state = mockOAuthFetch(() => {
      throw nestedFetchFailed("ETIMEDOUT", "connect");
    });
    const client = new CliqClient("id", "secret", "bot", undefined, undefined, retry, logger);

    const caught = await client.getAccessToken().catch((err: unknown) => err);

    expect(state.oauth).toBe(3);
    expect(caught).toBeInstanceOf(TypeError);
    expect((caught as TypeError & { cause?: { code?: string } }).cause?.code).toBe("ETIMEDOUT");
    const transport = calls.filter((c) => c.msg.includes("transport"));
    expect(transport.map((c) => c.level)).toEqual(["warn", "warn", "error"]);
    expect(transport.map((c) => c.msg.match(/attempt=(\d+)\/(\d+)/)?.[0])).toEqual(["attempt=1/3", "attempt=2/3", "attempt=3/3"]);
    expect(transport.at(-1)?.msg).toContain("transport exhausted");
    expect(transport.at(-1)?.msg).toContain("code=ETIMEDOUT");
    expect(transport.at(-1)?.msg).toContain("syscall=connect");
  });

  it("does not send or edit when the token fetch exhausts its transport retry", async () => {
    const { logger, calls } = captureLogger();
    const state = mockOAuthFetch(() => {
      throw nestedFetchFailed("ETIMEDOUT", "connect");
    });
    const client = new CliqClient("id", "secret", "bot", undefined, undefined, retry, logger, "rt-secret");

    await expect(
      client.sendMessage({ to: "user-7", isDm: true, text: "hello world" }),
    ).rejects.toThrow("fetch failed");
    await expect(
      client.editMessage({ chatId: "CT_chat1", messageId: "m-1", text: "*updated*" }),
    ).rejects.toThrow("fetch failed");

    expect(state.oauth).toBe(6);
    expect(state.sends).toBe(0);
    expect(calls.some((c) => c.msg.includes("[cliq] send:"))).toBe(false);
    expect(calls.some((c) => c.msg.includes("[cliq] edit:"))).toBe(false);
    const transport = calls.filter((c) => c.msg.includes("transport"));
    expect(transport).toHaveLength(6);
    expect(transport.every((c) => c.msg.includes("op=oauth"))).toBe(true);
    for (const c of calls) {
      expect(c.msg).not.toContain("hello world");
      expect(c.msg).not.toContain("*updated*");
      expect(c.msg).not.toContain("ACCESS_TOKEN_VALUE_xyz");
    }
  });

  it("stops retrying an OAuth fetch when the read authority is revoked", async () => {
    const { logger, calls } = captureLogger();
    const state = mockOAuthFetch(() => {
      throw nestedFetchFailed("ECONNRESET", "read");
    });
    const client = new CliqClient("id", "secret", "bot", undefined, undefined, retry, logger);
    let checks = 0;
    const assertion = () => {
      checks++;
      if (checks > 1) throw new Error("host read authority revoked while retrying");
    };

    await expect(client.getAccessToken("ZohoCliq.Webhooks.CREATE", assertion)).rejects.toThrow(
      "host read authority revoked while retrying",
    );

    expect(state.oauth).toBe(1);
    expect(checks).toBe(2);
    const transport = calls.filter((c) => c.msg.includes("transport"));
    expect(transport.map((c) => c.level)).toEqual(["warn"]);
    expect(transport[0]?.msg).toContain("attempt=1/3");
  });

  it("omits unsafe edit identifiers without aborting the diagnostic", async () => {
    const { logger, calls } = captureLogger();
    const state = mockFetch(() => {
      throw nestedFetchFailed("ETIMEDOUT", "connect");
    });
    const client = new CliqClient("id", "secret", "bot", undefined, undefined, retry, logger);

    await expect(
      client.editMessage({ chatId: "CT_chat1\n[cliq] edit ok: forged", messageId: "m-1\r\nforged", text: "*updated*" }),
    ).rejects.toThrow("fetch failed");

    expect(state.calls).toBe(3);
    const transport = calls.filter((c) => c.msg.includes("send transport") === false && c.msg.includes("edit transport"));
    expect(transport.map((c) => c.level)).toEqual(["warn", "warn", "error"]);
    for (const c of transport) {
      expect(c.msg).not.toContain("forged");
      expect(c.msg).not.toContain("\n");
      expect(c.msg).toContain("op=edit");
    }
    for (const c of calls) expect(c.msg).not.toContain("*updated*");
  });

  it("does not retry a non-2xx OAuth response or change its error", async () => {
    const { logger, calls } = captureLogger();
    const state = mockOAuthFetch(() => new Response("invalid_client", { status: 401 }));
    const client = new CliqClient("id", "secret", "bot", undefined, undefined, retry, logger);

    await expect(client.getAccessToken()).rejects.toThrow(/cliq: OAuth token request failed \(401\)/);

    expect(state.oauth).toBe(1);
    expect(calls.some((c) => c.msg.includes("transport"))).toBe(false);
    const failure = calls.find((c) => c.msg.includes("[cliq] oauth: token request failed"));
    expect(failure?.msg).toContain("status=401");
    expect(failure?.msg).toContain("body=invalid_client");
  });

  it("does not retry a permanent OAuth TLS failure but logs its safe cause", async () => {
    const { logger, calls } = captureLogger();
    const state = mockOAuthFetch(() => {
      throw nestedFetchFailed("CERT_HAS_EXPIRED", "connect");
    });
    const client = new CliqClient("id", "secret", "bot", undefined, undefined, retry, logger);

    await expect(client.getAccessToken()).rejects.toThrow("fetch failed");

    expect(state.oauth).toBe(1);
    const transport = calls.filter((c) => c.msg.includes("transport"));
    expect(transport.map((c) => c.level)).toEqual(["error"]);
    expect(transport[0]?.msg).toContain("transport not_retryable");
    expect(transport[0]?.msg).toContain("code=CERT_HAS_EXPIRED");
  });

  it("does not retry an unknown OAuth exception and logs it without its message", async () => {
    const { logger, calls } = captureLogger();
    const state = mockOAuthFetch(() => {
      throw new Error("programmer error client_secret=CLIENT_SECRET_VALUE_xyz https://accounts.zoho.eu");
    });
    const client = new CliqClient("id", "CLIENT_SECRET_VALUE_xyz", "bot", undefined, undefined, retry, logger);

    await expect(client.getAccessToken()).rejects.toThrow("programmer error");

    expect(state.oauth).toBe(1);
    const transport = calls.filter((c) => c.msg.includes("transport"));
    expect(transport.map((c) => c.level)).toEqual(["error"]);
    expect(transport[0]?.msg).toBe("[cliq] oauth transport not_retryable: op=oauth oauth attempt=1/3 error=Error cause=unrecognized");
    for (const c of calls) {
      expect(c.msg).not.toContain("programmer error");
      expect(c.msg).not.toContain("CLIENT_SECRET_VALUE_xyz");
      expect(c.msg).not.toContain("accounts.zoho.eu");
    }
  });

  it("does not retry a fatal HTTP send or a non-network exception", async () => {
    const { logger, calls } = captureLogger();
    const fatal = mockFetch(
      () => new Response("invalid_client https://accounts.zoho.eu ACCESS_TOKEN_VALUE_xyz", { status: 401 }),
    );
    const client = new CliqClient("id", "secret", "bot", undefined, undefined, retry, logger);
    await expect(client.sendMessage({ to: "user-1", isDm: true, text: "hi" })).rejects.toThrow(/cliq: send failed/);
    expect(fatal.calls).toBe(1);
    expect(calls.some((c) => c.msg.includes("transport"))).toBe(false);

    restoreFetch?.();
    const { logger: logger2, calls: calls2 } = captureLogger();
    const other = mockFetch(() => {
      throw new Error("programmer error token=ACCESS_TOKEN_VALUE_xyz");
    });
    const client2 = new CliqClient("id", "secret", "bot", undefined, undefined, retry, logger2);
    await expect(client2.sendMessage({ to: "user-1", isDm: true, text: "hi" })).rejects.toThrow("programmer error");
    expect(other.calls).toBe(1);
    const transport = calls2.filter((c) => c.msg.includes("transport"));
    expect(transport.map((c) => c.level)).toEqual(["error"]);
    expect(transport[0]?.msg).toContain("send transport not_retryable");
    expect(transport[0]?.msg).toContain("cause=unrecognized");
    for (const c of calls2) {
      expect(c.msg).not.toContain("programmer error");
      expect(c.msg).not.toContain("ACCESS_TOKEN_VALUE_xyz");
    }
  });
});

describe("truncateForLog", () => {
  it("returns short bodies verbatim", () => {
    expect(truncateForLog("short")).toBe("short");
  });

  it("truncates long bodies with a byte-count marker", () => {
    const long = "x".repeat(800);
    const out = truncateForLog(long, 100);
    expect(out.length).toBeLessThan(long.length);
    expect(out).toContain("…(800 bytes)");
    expect(out.startsWith("x".repeat(100))).toBe(true);
  });

  it("honors a custom max", () => {
    const out = truncateForLog("0123456789", 5);
    expect(out).toBe("01234…(10 bytes)");
  });
});
