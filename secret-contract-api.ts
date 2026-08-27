/**
 * Channel secret-contract artifact discovered by OpenClaw (issue #95).
 *
 * `openclaw secrets audit` / `apply` load this file directly from the plugin
 * root (or `dist/`) — see the SDK's `loadExternalChannelSecretContractFromRecord`.
 * It only accepts a module that exports `secretTargetRegistryEntries` and/or
 * `collectRuntimeConfigAssignments` under exactly those names; a differently
 * named export is silently ignored, which makes the audit report a config
 * full of plaintext secrets as "clean".
 *
 * The contract itself is NOT redefined here — this re-exports the single
 * canonical definition in `src/secret-contract.ts` under the names the
 * loader looks for.
 */
export {
  cliqSecretTargetRegistryEntries as secretTargetRegistryEntries,
  collectCliqRuntimeConfigAssignments as collectRuntimeConfigAssignments,
} from "./src/secret-contract.js";
