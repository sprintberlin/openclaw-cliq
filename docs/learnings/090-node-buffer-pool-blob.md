---
title: Node `Buffer` pool + `Blob`
category: General pitfalls
source: migrated from AGENTS.md
---
- **Node `Buffer` pool + `Blob`:** `Buffer.from("short")` is a *view* into Node's shared 8 KB pool. `new Blob([view])` is fine, but `new Uint8Array(buffer.buffer)` captures the whole 8192-byte pool (adjacent unrelated bytes) → spurious deep-equality failures in tests. Copy the view's bytes into a fresh `Uint8Array(byteLength)` before building a `Blob` or asserting on bytes.
