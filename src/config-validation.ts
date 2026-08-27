import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { buildJsonChannelConfigSchema } from "openclaw/plugin-sdk/channel-config-schema";

type JsonSchemaDocument = Parameters<typeof buildJsonChannelConfigSchema>[0];

/**
 * Real config-schema validation for a generated Cliq section (issue #95).
 *
 * Setup used to report success for a config OpenClaw would later reject: the
 * manifest typed the sensitive fields as bare strings, so the canonical
 * structured SecretRef that `openclaw secrets apply` writes failed validation
 * with `invalid config for plugin cliq: must be string` while `$ENV_VAR`
 * interpolation passed. Generating config is therefore not enough — it has to
 * be checked against the same schema the gateway enforces.
 *
 * The public channel config-schema builder supplies the runtime parser used by
 * the gateway, so setup validation follows the same defaults and issue shape.
 */

/** Structural result type retained for injectable setup validation tests. */
export type JsonSchemaValidatorFn = (params: {
  schema: unknown;
  value: unknown;
}) => { ok: boolean; errors?: { path?: string; message?: string }[] };

let validatorResolution: Promise<JsonSchemaValidatorFn | null> | undefined;

async function loadJsonSchemaValidator(): Promise<JsonSchemaValidatorFn | null> {
  return ({ schema, value }) => {
    const runtime = buildJsonChannelConfigSchema(
      schema as JsonSchemaDocument,
      { cacheKey: "openclaw-cliq:generated-config" },
    ).runtime;
    if (!runtime) {
      throw new Error("OpenClaw channel schema runtime is unavailable");
    }
    const result = runtime.safeParse(value);
    if (result.success) return { ok: true };
    return {
      ok: false,
      errors: result.issues.map((issue) => ({
        path: issue.path?.map(String).join("."),
        message: issue.message,
      })),
    };
  };
}

/** Resolve OpenClaw's own JSON-schema validator, or `null` when unavailable. */
export function resolveJsonSchemaValidator(): Promise<JsonSchemaValidatorFn | null> {
  validatorResolution ??= loadJsonSchemaValidator();
  return validatorResolution;
}

let cachedSchema: unknown;

/**
 * The `channels.cliq` schema exactly as shipped in the plugin manifest.
 *
 * The manifest lives at the package root and is NOT copied into `dist/`, so
 * the location differs between layouts: from `src/` it is one level up, but
 * from the built `dist/src/` it is two. Resolving only the source-relative
 * path made this throw `ENOENT` in exactly the layout that ships.
 */
export function readCliqChannelSchema(): unknown {
  if (cachedSchema !== undefined) return cachedSchema;
  const here = dirname(fileURLToPath(import.meta.url));
  for (const candidate of [
    resolve(here, "..", "openclaw.plugin.json"),
    resolve(here, "..", "..", "openclaw.plugin.json"),
  ]) {
    try {
      const manifest = JSON.parse(readFileSync(candidate, "utf8")) as {
        channelConfigs?: { cliq?: { schema?: unknown } };
      };
      const schema = manifest.channelConfigs?.cliq?.schema;
      if (schema) {
        cachedSchema = schema;
        return cachedSchema;
      }
    } catch {
      // Try the next layout.
    }
  }
  cachedSchema = null;
  return cachedSchema;
}

export interface CliqConfigValidationResult {
  valid: boolean;
  /** False when no validator was available, so `valid` is not evidence. */
  checked: boolean;
  /** Redacted, path-only issue descriptions. Never contains a value. */
  issues: string[];
}

/**
 * Validate a generated `channels.cliq` section against the real schema.
 *
 * Issues are reported as `path: message` only. A JSON-schema error can carry
 * the offending value, and these fields hold live credentials, so the value
 * is never included.
 */
export async function validateGeneratedCliqConfig(
  section: unknown,
  schema: unknown = readCliqChannelSchema(),
  resolveValidator: () => Promise<JsonSchemaValidatorFn | null> = resolveJsonSchemaValidator,
): Promise<CliqConfigValidationResult> {
  const validate = await resolveValidator();
  if (!validate || !schema) {
    return {
      valid: false,
      checked: false,
      issues: ["OpenClaw schema validation is unavailable"],
    };
  }
  let outcome: ReturnType<JsonSchemaValidatorFn>;
  try {
    outcome = validate({ schema, value: section });
  } catch (error) {
    // Only the validator's own failure reason, never the value it inspected.
    const reason = error instanceof Error ? error.message : "unknown error";
    return {
      valid: false,
      checked: false,
      issues: [`OpenClaw schema validation could not run: ${reason}`],
    };
  }
  if (outcome?.ok) return { valid: true, checked: true, issues: [] };
  const errors = outcome?.errors ?? [];
  // Only `path` + `message`. The SDK's `text` field can embed the offending
  // value, and these paths hold live credentials.
  const issues = [
    ...new Set(
      errors.map((error) => {
        const path = error.path?.trim() || "channels.cliq";
        return `channels.cliq.${path}: ${error.message ?? "did not match the Cliq schema"}`;
      }),
    ),
  ];
  return {
    valid: false,
    checked: true,
    issues: issues.length > 0 ? issues : ["channels.cliq: did not match the Cliq schema"],
  };
}
