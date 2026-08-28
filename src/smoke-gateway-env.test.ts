import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(new URL(".", import.meta.url).pathname, "..");
const smoke = readFileSync(join(ROOT, "scripts/smoke-gateway.sh"), "utf8");

describe("gateway smoke isolates provider auto-enable env (issue #182)", () => {
  it("unsets OpenRouter / Perplexity keys inherited from the developer shell", () => {
    expect(smoke).toMatch(/unset OPENROUTER_API_KEY PERPLEXITY_API_KEY/);
  });
});
