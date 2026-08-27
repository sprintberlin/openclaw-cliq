import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { CLIQ_SECRET_FIELDS } from "./secret-contract.js";

/**
 * SecretRef schema compatibility (issue #95).
 *
 * The plugin's own manifest is the schema OpenClaw validates a Cliq config
 * against. While the sensitive fields were typed as bare `string`, a
 * canonical structured SecretRef — the exact shape `openclaw secrets apply`
 * writes — was rejected with `invalid config for plugin cliq: must be
 * string`, while `$ENV_VAR` interpolation passed. That is the reported
 * defect: environment interpolation worked where a structured object failed.
 *
 * The accepted shape is not invented here; it mirrors the construct the
 * bundled Slack channel uses for `botToken` / `signingSecret` / `relay.authToken`,
 * so no version-gated fallback is required — both supported OpenClaw
 * versions accept the same representation.
 */

const here = dirname(fileURLToPath(import.meta.url));
const manifest = JSON.parse(
  readFileSync(resolve(here, "..", "openclaw.plugin.json"), "utf8"),
) as Record<string, any>;

/** Every schema location that types a Cliq secret field. */
function secretFieldSchemas(): { where: string; field: string; schema: any }[] {
  const roots: { where: string; schema: any }[] = [
    { where: "configSchema", schema: manifest.configSchema },
    {
      where: "configSchema.accounts",
      schema: manifest.configSchema?.properties?.accounts?.additionalProperties,
    },
    {
      where: "channelConfigs.cliq.schema",
      schema: manifest.channelConfigs?.cliq?.schema,
    },
    {
      where: "channelConfigs.cliq.schema.accounts",
      schema:
        manifest.channelConfigs?.cliq?.schema?.properties?.accounts
          ?.additionalProperties,
    },
  ];
  const out: { where: string; field: string; schema: any }[] = [];
  for (const root of roots) {
    expect(root.schema, `${root.where} must exist`).toBeTruthy();
    for (const field of CLIQ_SECRET_FIELDS) {
      const schema = root.schema.properties?.[field];
      if (schema) out.push({ where: root.where, field, schema });
    }
  }
  return out;
}

function acceptsPlainString(schema: any): boolean {
  if (schema.type === "string") return true;
  return Boolean(schema.anyOf?.some((entry: any) => entry.type === "string"));
}

function secretRefBranches(schema: any): any[] {
  const anyOf = schema.anyOf ?? [];
  const withOneOf = anyOf.find((entry: any) => Array.isArray(entry.oneOf));
  return withOneOf?.oneOf ?? [];
}

describe("manifest SecretRef schema (issue #95)", () => {
  it("covers every sensitive field in all four schema locations", () => {
    const found = secretFieldSchemas();
    // 3 secret fields x 4 locations.
    expect(found.length).toBe(CLIQ_SECRET_FIELDS.length * 4);
  });

  it("accepts a canonical structured SecretRef for every sensitive field", () => {
    for (const { where, field, schema } of secretFieldSchemas()) {
      const branches = secretRefBranches(schema);
      const sources = branches
        .map((branch: any) => branch.properties?.source?.const)
        .filter(Boolean);
      expect(sources, `${where}.${field} must accept env/file/exec refs`).toEqual(
        expect.arrayContaining(["env", "file", "exec"]),
      );
    }
  });

  it("still accepts a plain string so $ENV interpolation keeps working", () => {
    for (const { where, field, schema } of secretFieldSchemas()) {
      expect(acceptsPlainString(schema), `${where}.${field}`).toBe(true);
    }
  });

  it("requires source, provider, and id on every SecretRef branch", () => {
    for (const { where, field, schema } of secretFieldSchemas()) {
      for (const branch of secretRefBranches(schema)) {
        expect(branch.required, `${where}.${field}`).toEqual(
          expect.arrayContaining(["source", "provider", "id"]),
        );
        // A malformed ref must not be silently accepted as an open object.
        expect(branch.additionalProperties, `${where}.${field}`).toBe(false);
      }
    }
  });

  it("matches the bundled-channel provider and env-id patterns", () => {
    for (const { where, field, schema } of secretFieldSchemas()) {
      const branches = secretRefBranches(schema);
      const env = branches.find((b: any) => b.properties?.source?.const === "env");
      expect(env, `${where}.${field}`).toBeTruthy();
      expect(env.properties.provider.pattern).toBe("^[a-z][a-z0-9_-]{0,63}$");
      expect(env.properties.id.pattern).toBe("^[A-Z][A-Z0-9_]{0,127}$");
    }
  });

  it("never types a sensitive field as a bare string alone", () => {
    // The regression that shipped: `{"type":"string"}` with no ref branch
    // rejects the very shape `openclaw secrets apply` writes.
    for (const { where, field, schema } of secretFieldSchemas()) {
      const bareString =
        schema.type === "string" && !schema.anyOf && !schema.oneOf;
      expect(bareString, `${where}.${field} must not be a bare string`).toBe(false);
    }
  });
});
