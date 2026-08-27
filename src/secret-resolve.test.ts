import { describe, it, expect, afterEach } from "vitest";
import {
  resolveCliqSecretString,
  inspectCliqSecretFields,
} from "./secret-resolve.js";
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

describe("inspectCliqSecretFields — unresolved refs and unavailable providers (issue #95)", () => {
  const ENV_ID = "CLIQ_INSPECT_SECRET";
  afterEach(() => {
    delete process.env[ENV_ID];
  });

  it("reports a resolved env ref without revealing its value", () => {
    process.env[ENV_ID] = "super-secret-value";
    const cfg = cfgWith({
      clientSecret: { source: "env", provider: "default", id: ENV_ID },
    });
    const [finding] = inspectCliqSecretFields({ cfg }).filter(
      (entry) => entry.field === "clientSecret",
    );
    expect(finding.status).toBe("resolved");
    expect(JSON.stringify(finding)).not.toContain("super-secret-value");
  });

  it("reports an unresolved env ref as unresolved, naming the ref but not a value", () => {
    delete process.env[ENV_ID];
    const cfg = cfgWith({
      clientSecret: { source: "env", provider: "default", id: ENV_ID },
    });
    const finding = inspectCliqSecretFields({ cfg }).find(
      (entry) => entry.field === "clientSecret",
    )!;
    expect(finding.status).toBe("unresolved");
    expect(finding.ref).toBe(`env:default:${ENV_ID}`);
    expect(finding.detail).toMatch(/could not be resolved/i);
  });

  it("distinguishes an unresolved ref from an absent field", () => {
    const cfg = cfgWith({ clientSecret: "plain" });
    const webhook = inspectCliqSecretFields({ cfg }).find(
      (entry) => entry.field === "webhookSecret",
    )!;
    expect(webhook.status).toBe("absent");
    expect(webhook.ref).toBeUndefined();
  });

  it("reports an unavailable provider distinctly from an unresolved ref", () => {
    const cfg = cfgWith(
      { clientSecret: { source: "env", provider: "vaultish", id: ENV_ID } },
      { providers: { vaultish: { source: "file", path: "/tmp/s.json" } } },
    );
    const finding = inspectCliqSecretFields({ cfg }).find(
      (entry) => entry.field === "clientSecret",
    )!;
    expect(finding.status).toBe("provider_unavailable");
    expect(finding.detail).toMatch(/source "file" but ref requests "env"/);
  });

  it("treats an allowlist rejection as an unavailable provider, without the value", () => {
    process.env[ENV_ID] = "live-value";
    const cfg = cfgWith(
      { clientSecret: { source: "env", provider: "envp", id: ENV_ID } },
      { providers: { envp: { source: "env", allowlist: ["OTHER"] } } },
    );
    const finding = inspectCliqSecretFields({ cfg }).find(
      (entry) => entry.field === "clientSecret",
    )!;
    expect(finding.status).toBe("provider_unavailable");
    expect(JSON.stringify(finding)).not.toContain("live-value");
  });

  it("marks file and exec refs unresolvable at runtime rather than silently empty", () => {
    const cfg = cfgWith({
      clientSecret: { source: "file", provider: "mounted", id: "/cliq/cs" },
      refreshToken: { source: "exec", provider: "vault", id: "cliq/rt" },
    });
    const findings = inspectCliqSecretFields({ cfg });
    expect(findings.find((e) => e.field === "clientSecret")!.status).toBe(
      "unresolved",
    );
    expect(findings.find((e) => e.field === "refreshToken")!.status).toBe(
      "unresolved",
    );
  });

  it("flags a plaintext secret so the audit can offer a migration path", () => {
    const cfg = cfgWith({ clientSecret: "literal-secret" });
    const finding = inspectCliqSecretFields({ cfg }).find(
      (entry) => entry.field === "clientSecret",
    )!;
    expect(finding.status).toBe("plaintext");
    expect(JSON.stringify(finding)).not.toContain("literal-secret");
  });

  it("does not treat $ENV interpolation as plaintext", () => {
    const cfg = cfgWith({ clientSecret: "$CLIQ_CLIENT_SECRET" });
    const finding = inspectCliqSecretFields({ cfg }).find(
      (entry) => entry.field === "clientSecret",
    )!;
    expect(finding.status).not.toBe("plaintext");
  });
});
