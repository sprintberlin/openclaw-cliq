import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { resolveCliqConfig, resolveCliqApiVersion } from "./client.js";
import {
  DEFAULT_CLIQ_THINKING_ANIMATE_INTERVAL_MS,
  MIN_CLIQ_THINKING_ANIMATE_INTERVAL_MS,
} from "./client.js";
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
  default?: unknown;
  oneOf?: JsonSchema[];
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
  if (schema.oneOf) {
    // A value is valid against `oneOf` if it matches EXACTLY one sub-schema.
    const perBranch = schema.oneOf.map((sub) => validate(sub, value, path));
    const matches = perBranch.filter((e) => e.length === 0).length;
    if (matches === 1) return [];
    if (matches === 0) {
      // No branch matched — surface every branch's errors so the caller can
      // see WHY (e.g. "must not have additional properties: bogus").
      for (const errs of perBranch) errors.push(...errs);
      return errors;
    }
    errors.push(
      `${path}: value matched ${matches} of ${schema.oneOf.length} oneOf branches (must match exactly one)`,
    );
    return errors;
  }
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

describe("cliq replyToMode config schema", () => {
  const schema = manifest.channelConfigs.cliq.schema;
  const baseConfig = {
    clientId: "id",
    clientSecret: "sec",
    botId: "bot",
  };

  it("accepts replyToMode with each valid enum value", () => {
    for (const m of ["off", "first", "all", "batched"]) {
      const errors = validate(schema, { ...baseConfig, replyToMode: m });
      expect(errors).toEqual([]);
    }
  });

  it("rejects an unknown replyToMode value", () => {
    const errors = validate(schema, { ...baseConfig, replyToMode: "always" });
    expect(errors.some((e) => e.includes("not one of"))).toBe(true);
  });

  it("accepts replyToModeByChatType with valid chat-type keys + modes", () => {
    const errors = validate(schema, {
      ...baseConfig,
      replyToModeByChatType: {
        direct: "off",
        group: "first",
        channel: "all",
      },
    });
    expect(errors).toEqual([]);
  });

  it("rejects an unknown chat-type key in replyToModeByChatType", () => {
    const errors = validate(schema, {
      ...baseConfig,
      replyToModeByChatType: { forum: "all" },
    });
    expect(
      errors.some((e) => e.includes('must not have additional properties: "forum"')),
    ).toBe(true);
  });

  it("rejects extra keys inside replyToModeByChatType (additionalProperties:false)", () => {
    const errors = validate(schema, {
      ...baseConfig,
      replyToModeByChatType: { group: "first", extra: 1 },
    });
    expect(
      errors.some((e) => e.includes('must not have additional properties: "extra"')),
    ).toBe(true);
  });

  it("the top-level configSchema also declares replyToMode + replyToModeByChatType", () => {
    expect(manifest.configSchema.properties?.replyToMode).toBeDefined();
    expect(manifest.configSchema.properties?.replyToMode?.enum).toEqual([
      "off",
      "first",
      "all",
      "batched",
    ]);
    expect(
      manifest.configSchema.properties?.replyToModeByChatType,
    ).toBeDefined();
  });
});

describe("cliq thinking config schema (issue #47)", () => {
  const schema = manifest.channelConfigs.cliq.schema;
  const baseConfig = {
    clientId: "id",
    clientSecret: "sec",
    botId: "bot",
  };

  it("accepts thinking.mode with each valid enum value", () => {
    for (const m of ["off", "placeholder", "card"]) {
      const errors = validate(schema, {
        ...baseConfig,
        thinking: { mode: m, text: "💭 …" },
      });
      expect(errors).toEqual([]);
    }
  });

  it("rejects an unknown thinking.mode value", () => {
    const errors = validate(schema, {
      ...baseConfig,
      thinking: { mode: "status" },
    });
    expect(errors.some((e) => e.includes("not one of"))).toBe(true);
  });

  it("rejects extra keys inside thinking (additionalProperties:false)", () => {
    const errors = validate(schema, {
      ...baseConfig,
      thinking: { mode: "off", extra: 1 },
    });
    expect(
      errors.some((e) => e.includes('must not have additional properties: "extra"')),
    ).toBe(true);
  });

  it("accepts a custom thinking.text", () => {
    const errors = validate(schema, {
      ...baseConfig,
      thinking: { mode: "placeholder", text: "Working on it…" },
    });
    expect(errors).toEqual([]);
  });

  it("the top-level configSchema also declares thinking", () => {
    expect(manifest.configSchema.properties?.thinking).toBeDefined();
    expect(manifest.configSchema.properties?.thinking?.properties?.mode?.enum).toEqual([
      "off",
      "placeholder",
      "card",
    ]);
  });

  it("uiHints declare the thinking field", () => {
    const uiHints = (manifest as unknown as {
      channelConfigs: {
        cliq: {
          uiHints?: Record<string, { label?: string; options?: string[] }>;
        };
      };
    }).channelConfigs.cliq.uiHints;
    expect(uiHints?.thinking).toBeDefined();
    expect(uiHints?.thinking?.options).toEqual(["off", "placeholder", "card"]);
  });

  it("declares thinking.animate + animateFrames + animateIntervalMs (issue #86)", () => {
    const t = schema.properties?.thinking?.properties;
    expect(t?.animate?.enum).toEqual(["off", "dots", "spinner", "custom"]);
    expect(t?.animate?.default).toBe("dots");
    expect(t?.animateFrames?.type).toBe("array");
    expect(t?.animateIntervalMs?.type).toBe("number");
    const tt = manifest.configSchema.properties?.thinking?.properties;
    expect(tt?.animate?.enum).toEqual(["off", "dots", "spinner", "custom"]);
  });
});

describe("cliq resolveCliqConfig reads thinking (issue #47)", () => {
  it("resolves thinking.mode === 'placeholder' + custom text", () => {
    const cfg = cfgWith({
      clientId: "id",
      clientSecret: "s",
      botId: "b",
      thinking: { mode: "placeholder", text: "Thinking…" },
    });
    const account = resolveCliqConfig(cfg);
    expect(account.thinking.mode).toBe("placeholder");
    expect(account.thinking.text).toBe("Thinking…");
  });

  it("defaults thinking.mode to 'placeholder' and animate to 'dots' for new installs (issue #89)", () => {
    // Simulate what the OpenClaw runtime does: it injects manifest schema
    // defaults before handing config to the plugin. With the manifest defaults
    // flipped to placeholder+dots, the resolved config reflects them.
    const cfg = cfgWith({
      clientId: "id", clientSecret: "s", botId: "b",
      thinking: { mode: "placeholder", animate: "dots" },
    });
    const account = resolveCliqConfig(cfg);
    expect(account.thinking.mode).toBe("placeholder");
    expect(account.thinking.text).toBe("💭 …");
    expect(account.thinking.animate).toBe("dots");
  });

  it("falls back to the default text when only mode is set", () => {
    const cfg = cfgWith({
      clientId: "id",
      clientSecret: "s",
      botId: "b",
      thinking: { mode: "placeholder" },
    });
    const account = resolveCliqConfig(cfg);
    expect(account.thinking.mode).toBe("placeholder");
    expect(account.thinking.text).toBe("💭 …");
  });

  it("resolves thinking.mode === 'card' with the card default title", () => {
    const cfg = cfgWith({
      clientId: "id",
      clientSecret: "s",
      botId: "b",
      thinking: { mode: "card" },
    });
    const account = resolveCliqConfig(cfg);
    expect(account.thinking.mode).toBe("card");
    expect(account.thinking.text).toBe("Generating…");
  });

  it("resolves a custom thinking.text for card mode", () => {
    const cfg = cfgWith({
      clientId: "id",
      clientSecret: "s",
      botId: "b",
      thinking: { mode: "card", text: "Working…" },
    });
    const account = resolveCliqConfig(cfg);
    expect(account.thinking.mode).toBe("card");
    expect(account.thinking.text).toBe("Working…");
  });

  it("defaults thinking.animate to 'dots' and the interval to the default when unset (issue #89)", () => {
    // Simulate runtime-injected manifest defaults.
    const cfg = cfgWith({
      clientId: "id", clientSecret: "s", botId: "b",
      thinking: { mode: "placeholder", animate: "dots" },
    });
    const account = resolveCliqConfig(cfg);
    expect(account.thinking.animate).toBe("dots");
    expect(account.thinking.animateFrames).toEqual([]);
    expect(account.thinking.animateIntervalMs).toBe(DEFAULT_CLIQ_THINKING_ANIMATE_INTERVAL_MS);
  });

  it("resolves thinking.animate='dots' / 'spinner' / 'custom' and a floored interval (issue #86)", () => {
    for (const m of ["dots", "spinner", "custom"] as const) {
      const cfg = cfgWith({
        clientId: "id", clientSecret: "s", botId: "b",
        thinking: {
          mode: "placeholder",
          animate: m,
          animateFrames: m === "custom" ? ["a", "b", "c"] : undefined,
          animateIntervalMs: 100,
        },
      });
      const account = resolveCliqConfig(cfg);
      expect(account.thinking.animate).toBe(m);
      // 100 is below the 800 ms floor → clamped.
      expect(account.thinking.animateIntervalMs).toBe(MIN_CLIQ_THINKING_ANIMATE_INTERVAL_MS);
    }
    expect(
      resolveCliqConfig(cfgWith({
        clientId: "id", clientSecret: "s", botId: "b",
        thinking: { mode: "placeholder", animate: "custom", animateFrames: ["x", "y"] },
      })).thinking.animateFrames,
    ).toEqual(["x", "y"]);
  });

  it("drops non-string / empty custom animateFrames (issue #86)", () => {
    const cfg = cfgWith({
      clientId: "id", clientSecret: "s", botId: "b",
      thinking: { mode: "placeholder", animate: "custom", animateFrames: ["ok", "", 5, null] },
    });
    const account = resolveCliqConfig(cfg);
    expect(account.thinking.animateFrames).toEqual(["ok"]);
  });
});

describe("cliq thinking manifest defaults (issue #89)", () => {
  const channelSchema = manifest.channelConfigs.cliq.schema;
  const topLevelSchema = manifest.configSchema;

  it("declares thinking.mode default as 'placeholder' in both schemas", () => {
    expect(channelSchema.properties?.thinking?.properties?.mode?.default).toBe("placeholder");
    expect(topLevelSchema.properties?.thinking?.properties?.mode?.default).toBe("placeholder");
  });

  it("declares thinking.animate default as 'dots' in both schemas", () => {
    expect(channelSchema.properties?.thinking?.properties?.animate?.default).toBe("dots");
    expect(topLevelSchema.properties?.thinking?.properties?.animate?.default).toBe("dots");
  });

  it("omitted thinking block resolves to mode='placeholder' + animate='dots' through the full config-resolution path", () => {
    // Simulate what the OpenClaw runtime does: inject manifest schema defaults
    // before handing config to the plugin. With the defaults flipped, the
    // resolved config reflects placeholder+dots.
    const cfg = cfgWith({
      clientId: "id", clientSecret: "s", botId: "b",
      thinking: { mode: "placeholder", animate: "dots" },
    });
    const resolved = resolveCliqConfig(cfg);
    expect(resolved.thinking.mode).toBe("placeholder");
    expect(resolved.thinking.animate).toBe("dots");
  });
});

describe("cliq apiVersion manifest schema (issue #86)", () => {
  // The bug: the manifest declared `apiVersion` as a string with
  // `"default": "v2"`. OpenClaw injects manifest config-schema defaults at
  // runtime, so the resolved config got `apiVersion: "v2"` even when the
  // operator set nothing — which `normalizeCliqApiVersionConfig` then read as
  // a GLOBAL "v2" override, silently defeating the code's `dmPost: "v3"`
  // default. The fix: the schema accepts BOTH the string and the per-family
  // object, and declares NO default (so the code's per-family defaults apply).
  const channelSchema = manifest.channelConfigs.cliq.schema;
  const topLevelSchema = manifest.configSchema;

  it("does NOT declare a manifest `default` for apiVersion (so the runtime cannot inject v2)", () => {
    expect(channelSchema.properties?.apiVersion?.default).toBeUndefined();
    expect(topLevelSchema.properties?.apiVersion?.default).toBeUndefined();
  });

  it("accepts the string global override (v2 / v3)", () => {
    for (const v of ["v2", "v3"]) {
      const errors = validate(channelSchema, {
        clientId: "id", clientSecret: "s", botId: "b",
        apiVersion: v,
      });
      expect(errors).toEqual([]);
    }
  });

  it("accepts the per-family object form", () => {
    const errors = validate(channelSchema, {
      clientId: "id", clientSecret: "s", botId: "b",
      apiVersion: { dmPost: "v3", channelPost: "v2", channelCard: "v2", delete: "v2" },
    });
    expect(errors).toEqual([]);
  });

  it("accepts a partial per-family object (only one family set)", () => {
    const errors = validate(channelSchema, {
      clientId: "id", clientSecret: "s", botId: "b",
      apiVersion: { channelPost: "v3" },
    });
    expect(errors).toEqual([]);
  });

  it("rejects an unknown family key in the per-family object (additionalProperties:false)", () => {
    const errors = validate(channelSchema, {
      clientId: "id", clientSecret: "s", botId: "b",
      apiVersion: { dmPost: "v3", bogus: "v2" },
    });
    expect(
      errors.some((e) => e.includes('must not have additional properties: "bogus"')),
    ).toBe(true);
  });

  it("rejects an unknown apiVersion string value", () => {
    const errors = validate(channelSchema, {
      clientId: "id", clientSecret: "s", botId: "b",
      apiVersion: "v4",
    });
    expect(errors.some((e) => e.includes("not one of"))).toBe(true);
  });

  it("omitted apiVersion resolves dmPost→v3 and the rest→v2 through the full config-resolution path", () => {
    // This is the regression that was broken when the manifest injected a "v2"
    // default: the runtime-resolved config differed from the raw one. With the
    // manifest `default` removed, an omitted `apiVersion` stays `undefined`
    // through resolution → the code's CLIQ_API_FAMILY_DEFAULTS apply.
    const cfg = cfgWith({ clientId: "id", clientSecret: "s", botId: "b" });
    const resolved = resolveCliqConfig(cfg);
    expect(resolved.apiVersion).toBeUndefined();
    expect(resolveCliqApiVersion(resolved.apiVersion, "dmPost")).toBe("v3");
    expect(resolveCliqApiVersion(resolved.apiVersion, "channelPost")).toBe("v2");
    expect(resolveCliqApiVersion(resolved.apiVersion, "channelCard")).toBe("v2");
    expect(resolveCliqApiVersion(resolved.apiVersion, "delete")).toBe("v2");
  });
});

