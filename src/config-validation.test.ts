import { describe, it, expect } from "vitest";
import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, resolve } from "node:path";
import {
  validateGeneratedCliqConfig,
  resolveJsonSchemaValidator,
} from "./config-validation.js";

const here = dirname(fileURLToPath(import.meta.url));
const manifest = JSON.parse(
  readFileSync(resolve(here, "..", "openclaw.plugin.json"), "utf8"),
) as Record<string, any>;

const BASE = {
  enabled: true,
  clientId: "1000.ABC",
  botId: "franzi",
};

const ENV_REF = { source: "env", provider: "default", id: "CLIQ_CLIENT_SECRET" };

describe("validateGeneratedCliqConfig (issue #95)", () => {
  it("resolves the real OpenClaw schema validator on this version", async () => {
    // Guards the whole feature: if the SDK stops exporting it, the tests
    // below would silently pass on a null validator.
    expect(await resolveJsonSchemaValidator()).toBeTypeOf("function");
  });

  it("accepts a canonical structured SecretRef", async () => {
    const result = await validateGeneratedCliqConfig({
      ...BASE,
      clientSecret: ENV_REF,
      webhookSecret: { source: "env", provider: "default", id: "CLIQ_WEBHOOK_SECRET" },
      refreshToken: { source: "file", provider: "mounted", id: "/cliq/refresh" },
    });
    expect(result.issues).toEqual([]);
    expect(result.valid).toBe(true);
  });

  it("accepts $ENV interpolation, which is what worked before the fix", async () => {
    const result = await validateGeneratedCliqConfig({
      ...BASE,
      clientSecret: "$CLIQ_CLIENT_SECRET",
      webhookSecret: "${CLIQ_WEBHOOK_SECRET}",
    });
    expect(result.valid).toBe(true);
  });

  it("rejects a malformed SecretRef instead of quietly accepting it", async () => {
    const result = await validateGeneratedCliqConfig({
      ...BASE,
      clientSecret: { source: "env", provider: "default" },
      webhookSecret: "wh",
    });
    expect(result.valid).toBe(false);
    expect(result.issues.join(" ")).toMatch(/clientSecret/);
  });

  it("rejects an unknown secret source", async () => {
    const result = await validateGeneratedCliqConfig({
      ...BASE,
      clientSecret: { source: "vault", provider: "default", id: "X" },
      webhookSecret: "wh",
    });
    expect(result.valid).toBe(false);
  });

  it("never echoes a secret value into the issue text", async () => {
    const result = await validateGeneratedCliqConfig({
      ...BASE,
      clientSecret: { source: "env", provider: "BAD PROVIDER", id: "super-secret-value" },
      webhookSecret: "another-live-secret",
    });
    expect(result.valid).toBe(false);
    const joined = result.issues.join(" ");
    expect(joined).not.toContain("super-secret-value");
    expect(joined).not.toContain("another-live-secret");
  });

  it("validates against the shipped manifest schema, not a copy", async () => {
    const ok = await validateGeneratedCliqConfig(
      { ...BASE, clientSecret: ENV_REF, webhookSecret: "wh" },
      manifest.channelConfigs.cliq.schema,
    );
    expect(ok.valid).toBe(true);
  });

  it("fails closed when no validator is available instead of claiming a pass", async () => {
    // Setup must never report success on the strength of a check that never
    // ran; both supported OpenClaw versions do expose the validator.
    const result = await validateGeneratedCliqConfig(
      { ...BASE, clientSecret: ENV_REF, webhookSecret: "wh" },
      undefined,
      async () => null,
    );
    expect(result.checked).toBe(false);
    expect(result.valid).toBe(false);
  });

  it("fails closed, without echoing the config, when the validator throws", async () => {
    const result = await validateGeneratedCliqConfig(
      { ...BASE, clientSecret: "live-secret-value", webhookSecret: "wh" },
      { type: "not-a-real-schema" },
      async () => () => {
        throw new Error("invalid schema: boom");
      },
    );
    expect(result).toMatchObject({ valid: false, checked: false });
    expect(result.issues.join(" ")).not.toContain("live-secret-value");
  });
});

describe("manifest resolution across layouts (issue #95)", () => {
  it("finds the schema from the built dist layout, not just from src", async () => {
    // `openclaw.plugin.json` is not copied into dist/, so dist/src/ has to
    // look two levels up. Getting this wrong threw ENOENT only in the
    // layout that actually ships.
    const built = resolve(here, "..", "dist", "src", "config-validation.js");
    if (!existsSync(built)) return;
    const mod = await import(pathToFileURL(built).href);
    expect(mod.readCliqChannelSchema()).toBeTruthy();
    const result = await mod.validateGeneratedCliqConfig({
      ...BASE,
      clientSecret: ENV_REF,
      webhookSecret: "wh",
    });
    expect(result).toMatchObject({ valid: true, checked: true });
  });
});
