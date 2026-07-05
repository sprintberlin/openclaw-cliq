import { describe, it, expect, afterEach } from "vitest";
import { resolveCliqSecretString } from "./secret-resolve.js";
import { resolveCliqConfig } from "./client.js";
import type { OpenClawConfig } from "openclaw/plugin-sdk/channel-core";

function cfgWith(
  section: Record<string, unknown> | null,
  secrets?: Record<string, unknown>,
): OpenClawConfig {
  const base: Record<string, unknown> = {};
  if (section !== null) base.channels = { cliq: section };
  if (secrets) base.secrets = secrets;
  return base as unknown as OpenClawConfig;
}

const ENV_KEY = "CLIQ_TEST_SECRET";

afterEach(() => {
  delete process.env[ENV_KEY];
});

describe("resolveCliqSecretString", () => {
  it("returns a plaintext string trimmed", () => {
    const cfg = cfgWith({ clientSecret: "  plaintext-secret  " });
    expect(
      resolveCliqSecretString({
        cfg,
        value: "  plaintext-secret  ",
        path: "channels.cliq.clientSecret",
      }),
    ).toBe("plaintext-secret");
  });

  it("returns '' for undefined / null / empty", () => {
    const cfg = cfgWith({});
    expect(
      resolveCliqSecretString({ cfg, value: undefined, path: "p" }),
    ).toBe("");
    expect(resolveCliqSecretString({ cfg, value: null, path: "p" })).toBe("");
    expect(resolveCliqSecretString({ cfg, value: "", path: "p" })).toBe("");
    expect(resolveCliqSecretString({ cfg, value: "   ", path: "p" })).toBe("");
  });

  it("resolves an env-backed SecretRef via process.env", () => {
    process.env[ENV_KEY] = "env-secret-value";
    const cfg = cfgWith({});
    const value = {
      source: "env",
      provider: "default",
      id: ENV_KEY,
    };
    expect(
      resolveCliqSecretString({ cfg, value, path: "channels.cliq.clientSecret" }),
    ).toBe("env-secret-value");
  });

  it("returns '' for an env-backed SecretRef whose env var is unset", () => {
    delete process.env[ENV_KEY];
    const cfg = cfgWith({});
    const value = {
      source: "env",
      provider: "default",
      id: ENV_KEY,
    };
    expect(
      resolveCliqSecretString({ cfg, value, path: "channels.cliq.clientSecret" }),
    ).toBe("");
  });

  it("resolves an env-backed SecretRef using a custom env override", () => {
    const cfg = cfgWith({});
    const value = {
      source: "env",
      provider: "default",
      id: ENV_KEY,
    };
    expect(
      resolveCliqSecretString({
        cfg,
        value,
        path: "p",
        env: { [ENV_KEY]: "from-custom-env" } as NodeJS.ProcessEnv,
      }),
    ).toBe("from-custom-env");
  });

  it("resolves an env-backed SecretRef honoring secrets.defaults.env alias", () => {
    process.env[ENV_KEY] = "aliased";
    const cfg = cfgWith({}, {
      defaults: { env: "myenv" },
    });
    const value = {
      source: "env",
      provider: "myenv",
      id: ENV_KEY,
    };
    expect(
      resolveCliqSecretString({ cfg, value, path: "p" }),
    ).toBe("aliased");
  });

  it("resolves an env-backed SecretRef honoring a configured env provider with allowlist", () => {
    process.env[ENV_KEY] = "allowed";
    const cfg = cfgWith({}, {
      providers: {
        myenv: { source: "env", allowlist: [ENV_KEY] },
      },
    });
    const value = {
      source: "env",
      provider: "myenv",
      id: ENV_KEY,
    };
    expect(
      resolveCliqSecretString({ cfg, value, path: "p" }),
    ).toBe("allowed");
  });

  it("throws when an env provider allowlist excludes the id", () => {
    process.env[ENV_KEY] = "x";
    const cfg = cfgWith({}, {
      providers: {
        myenv: { source: "env", allowlist: ["OTHER_VAR"] },
      },
    });
    const value = {
      source: "env",
      provider: "myenv",
      id: ENV_KEY,
    };
    expect(() =>
      resolveCliqSecretString({ cfg, value, path: "p" }),
    ).toThrow(/not allowlisted/);
  });

  it("throws when the named provider is not an env source", () => {
    const cfg = cfgWith({}, {
      providers: {
        myfile: { source: "file", path: "/tmp/secrets.json" },
      },
    });
    const value = {
      source: "env",
      provider: "myfile",
      id: ENV_KEY,
    };
    expect(() =>
      resolveCliqSecretString({ cfg, value, path: "p" }),
    ).toThrow(/has source "file" but ref requests "env"/);
  });

  it("returns '' for a file-backed SecretRef (not resolvable synchronously)", () => {
    const cfg = cfgWith({});
    const value = {
      source: "file",
      provider: "default",
      id: "/cliq/clientSecret",
    };
    expect(
      resolveCliqSecretString({ cfg, value, path: "p" }),
    ).toBe("");
  });

  it("returns '' for an exec-backed SecretRef (not resolvable synchronously)", () => {
    const cfg = cfgWith({});
    const value = {
      source: "exec",
      provider: "default",
      id: "cliq/clientSecret",
    };
    expect(
      resolveCliqSecretString({ cfg, value, path: "p" }),
    ).toBe("");
  });
});

describe("resolveCliqConfig with SecretRef credentials", () => {
  const ENV_SECRET = "CLIQ_TEST_CLIENT_SECRET";
  const ENV_WH = "CLIQ_TEST_WEBHOOK_SECRET";
  const ENV_RT = "CLIQ_TEST_REFRESH_TOKEN";

  afterEach(() => {
    delete process.env[ENV_SECRET];
    delete process.env[ENV_WH];
    delete process.env[ENV_RT];
  });

  it("resolves env-backed SecretRef fields to plaintext at resolve time", () => {
    process.env[ENV_SECRET] = "resolved-client-secret";
    process.env[ENV_WH] = "resolved-webhook-secret";
    process.env[ENV_RT] = "resolved-refresh-token";
    const cfg = cfgWith({
      clientId: "cid",
      botId: "bot",
      clientSecret: { source: "env", provider: "default", id: ENV_SECRET },
      webhookSecret: { source: "env", provider: "default", id: ENV_WH },
      refreshToken: { source: "env", provider: "default", id: ENV_RT },
    });
    const account = resolveCliqConfig(cfg, null);
    expect(account.clientSecret).toBe("resolved-client-secret");
    expect(account.webhookSecret).toBe("resolved-webhook-secret");
    expect(account.refreshToken).toBe("resolved-refresh-token");
  });

  it("throws on a required SecretRef whose env var is unset", () => {
    delete process.env[ENV_SECRET];
    const cfg = cfgWith({
      clientId: "cid",
      botId: "bot",
      clientSecret: { source: "env", provider: "default", id: ENV_SECRET },
    });
    expect(() => resolveCliqConfig(cfg, null)).toThrow(/clientSecret is required/);
  });

  it("leaves optional SecretRef fields undefined when the env var is unset", () => {
    delete process.env[ENV_WH];
    const cfg = cfgWith({
      clientId: "cid",
      botId: "bot",
      clientSecret: "plaintext",
      webhookSecret: { source: "env", provider: "default", id: ENV_WH },
    });
    const account = resolveCliqConfig(cfg, null);
    expect(account.webhookSecret).toBeUndefined();
  });
});
