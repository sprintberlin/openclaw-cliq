---
title: `collectRuntimeConfigAssignments` collects EXISTING SecretRef assignments for resolution, NOT plaintext
category: Secrets (`openclaw secrets audit/apply/reload`)
source: migrated from AGENTS.md
---
- **`collectRuntimeConfigAssignments` collects EXISTING SecretRef assignments for resolution, NOT plaintext.** `collectSecretInputAssignment` calls `coerceSecretRef(value)` first and returns early when the value is plaintext (no ref → no assignment). So a test that feeds plaintext values gets zero assignments; feed SecretRef objects (`{source:"env",provider,id}`) and assert `context.assignments` (an array on the `ResolverContext`) receives `{ ref, path, expected, apply }` entries. The `ResolverContext` shape (`runtime-shared-DoAXKQzg.js`): `{ assignments: [], warnings: [], warningKeys: Set }`; `pushAssignment(ctx,a)` does `ctx.assignments.push(a)`; `pushWarning`/`pushInactiveSurfaceWarning` dedupe via `ctx.warningKeys`.
