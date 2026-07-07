---
title: `g`-flagged `RegExp` is stateful
category: General pitfalls
source: migrated from AGENTS.md
---
- **`g`-flagged `RegExp` is stateful:** `lastIndex` advances between `.test()` calls, causing false negatives. Reset `re.lastIndex = 0` before reuse; `.replace` does not advance it, but be defensive.
