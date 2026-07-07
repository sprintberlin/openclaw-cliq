---
title: Bold-before-italic pitfall
category: Zoho Cliq specifics
source: migrated from AGENTS.md
---
- **Bold-before-italic pitfall:** converting `**bold**`→`*bold*` and then `*italic*`→`_italic_` makes the italic pass eat the just-emitted `*bold*`. Fix: emit bold through NUL-delimited placeholders restored to `*…*` only *after* the italic pass (same technique the bernesto converter uses). Protect fenced/inline code with placeholders too.
