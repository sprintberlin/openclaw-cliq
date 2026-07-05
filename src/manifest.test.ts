import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { resolveCliqConfig } from "./client.js";
import type { OpenClawConfig } from "openclaw/plugin-sdk/channel-core";

const here = dirname(fileURLToPath(import.meta.url));
const manifest = JSON.parse(
  readFileSync(resolve(here, "..", "openclaw.plugin.json"), "utf8"),
) as {
  configSchema: JsonSchema;
  channelConfigs: { cliq: { schema: JsonSchema } };
};

interface JsonSchema {
  type?: string;
  additionalProperties?: boolean;
  properties?: Record<string, JsonSchema>;
  enum?: unknown[];
  required?: string[];
}

function cfgWith(section: Record<string, unknown>): OpenClawConfig {
  return { channels: { cliq: section } } as unknown as OpenClawConfig;
}

/**
 * Minimal JSON-schema validator covering the subset our manifest uses:
 * `type`, `additionalProperties`, `properties`, `enum`, `required`.
 * Avoids pulling in `ajv` as a dependency just for this one test.
 */
function validate(
  schema: JsonSchema,
  value: unknown,
  path = "$",
): string[] {
  const errors: string[] = [];
  if (schema.type === "object") {
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      errors.push(`${path}: expected object, got ${Array.isArray(value) ? "array" : typeof value}`);
      return errors;
    }
    const obj = value as Record<string, unknown>;
    if (schema.additionalProperties === false && schema.properties) {
      for (const key of Object.keys(obj)) {
        if (!(key in schema.properties)) {
          errors.push(`${path}: must not have additional properties: "${key}"`);
        }
      }
    }
    for (const [key, sub] of Object.entries(schema.properties ?? {})) {
      if (key in obj) {
        errors.push(...validate(sub, obj[key], `${path}.${key}`));
      }
    }
  } else if (schema.type === "array") {
    if (!Array.isArray(value)) {
      errors.push(`${path}: expected array, got ${typeof value}`);
    }
  } else if (schema.type === "string") {
    if (typeof value !== "string") {
      errors.push(`${path}: expected string, got ${typeof value}`);
    }
  }
  if (schema.enum && !schema.enum.includes(value)) {
    errors.push(`${path}: "${String(value)}" is not one of [${schema.enum.map(String).join(", ")}]`);
  }
  return errors;
}

describe("cliq manifest DM policy schema (issue #9)", () => {
  const schema = manifest.channelConfigs.cliq.schema;
  const baseConfig = {
    clientId: "id",
    clientSecret: "sec",
    botId: "bot",
  };

  it("allows dmPolicy with each valid enum value", () => {
    for (const policy of ["open", "allowlist", "pairing", "disabled"]) {
      const errors = validate(schema, { ...baseConfig, dmPolicy: policy });
      expect(errors).toEqual([]);
    }
  });

  it("rejects dmPolicy with an unknown enum value", () => {
    const errors = validate(schema, { ...baseConfig, dmPolicy: "open-sesame" });
    expect(errors.some((e) => e.includes("not one of"))).toBe(true);
  });

  it("rejects the legacy mistyped field name dmSecurity (additionalProperties:false)", () => {
    const errors = validate(schema, { ...baseConfig, dmSecurity: "open" });
    expect(
      errors.some((e) => e.includes('must not have additional properties: "dmSecurity"')),
    ).toBe(true);
  });

  it("accepts allowFrom without dmPolicy (fallback path)", () => {
    const errors = validate(schema, { ...baseConfig, allowFrom: ["gregor"] });
    expect(errors).toEqual([]);
  });

  it("the top-level configSchema also allows dmPolicy", () => {
    expect(manifest.configSchema.properties?.dmPolicy).toBeDefined();
    expect(manifest.configSchema.properties?.dmPolicy?.enum).toEqual([
      "open",
      "allowlist",
      "pairing",
      "disabled",
    ]);
  });

  it("does not list dmSecurity anywhere in the manifest", () => {
    const json = JSON.stringify(manifest);
    expect(json).not.toContain("dmSecurity");
  });
});

describe("cliq resolveCliqConfig reads dmPolicy (issue #9)", () => {
  it("resolves dmPolicy from channels.cliq.dmPolicy", () => {
    const cfg = cfgWith({ ...{ clientId: "id", clientSecret: "s", botId: "b" }, dmPolicy: "open" });
    const account = resolveCliqConfig(cfg);
    expect(account.dmPolicy).toBe("open");
  });

  it("returns undefined dmPolicy when not set (falls back to allowlist downstream)", () => {
    const cfg = cfgWith({ clientId: "id", clientSecret: "s", botId: "b" });
    const account = resolveCliqConfig(cfg);
    expect(account.dmPolicy).toBeUndefined();
  });

  it("does NOT read the legacy dmSecurity field", () => {
    const cfg = cfgWith({ clientId: "id", clientSecret: "s", botId: "b", dmSecurity: "open" });
    const account = resolveCliqConfig(cfg);
    expect(account.dmPolicy).toBeUndefined();
  });
});

describe("cliq reactions config schema", () => {
  const schema = manifest.channelConfigs.cliq.schema;
  const baseConfig = {
    clientId: "id",
    clientSecret: "sec",
    botId: "bot",
  };

  it("accepts reactions.agentGuidance with each valid enum value", () => {
    for (const g of ["minimal", "extensive", "off"]) {
      const errors = validate(schema, {
        ...baseConfig,
        reactions: { agentGuidance: g },
      });
      expect(errors).toEqual([]);
    }
  });

  it("rejects an unknown agentGuidance value", () => {
    const errors = validate(schema, {
      ...baseConfig,
      reactions: { agentGuidance: "always" },
    });
    expect(errors.some((e) => e.includes("not one of"))).toBe(true);
  });

  it("rejects extra keys inside reactions (additionalProperties:false)", () => {
    const errors = validate(schema, {
      ...baseConfig,
      reactions: { agentGuidance: "minimal", extra: 1 },
    });
    expect(
      errors.some((e) => e.includes('must not have additional properties: "extra"')),
    ).toBe(true);
  });

  it("the top-level configSchema also declares reactions", () => {
    expect(manifest.configSchema.properties?.reactions).toBeDefined();
    const r = manifest.configSchema.properties?.reactions?.properties?.agentGuidance;
    expect(r?.enum).toEqual(["minimal", "extensive", "off"]);
  });
});
