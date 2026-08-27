import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const SRC_DIR = new URL(".", import.meta.url).pathname;

function readPluginSources(): { file: string; text: string }[] {
  return readdirSync(SRC_DIR)
    .filter((file) => file.endsWith(".ts") && !file.endsWith(".test.ts"))
    .map((file) => ({ file, text: readFileSync(join(SRC_DIR, file), "utf8") }));
}

function logCallLines(text: string): string[] {
  return text
    .split("\n")
    .filter((line) => /\b(logger|log)\??\.(debug|info|warn|error)\s*\??\.?\(/.test(line));
}

describe("handler script / provisioning response logging (issue #113)", () => {
  const sources = readPluginSources();

  it("has plugin sources to audit", () => {
    expect(sources.length).toBeGreaterThan(0);
  });

  it("never logs a Deluge handler script body", () => {
    const offenders: string[] = [];
    for (const { file, text } of sources) {
      for (const line of logCallLines(text)) {
        if (/\b(script|handlerScript|deluge|handlerBody)\b/i.test(line)) {
          offenders.push(`${file}: ${line.trim()}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  it("never logs a raw bot or handler provisioning API response body", () => {
    const offenders: string[] = [];
    for (const { file, text } of sources) {
      for (const line of logCallLines(text)) {
        const logsRawBody = /\$\{(res|r|response)?\.?body\}|\$\{await .*\.text\(\)\}/.test(line);
        if (logsRawBody) {
          offenders.push(`${file}: ${line.trim()}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  it("never logs the configured webhook secret value", () => {
    const offenders: string[] = [];
    for (const { file, text } of sources) {
      for (const line of logCallLines(text)) {
        if (/\$\{[^}]*\b(webhookSecret|clientSecret|refreshToken|accessToken)\b[^}]*\}/.test(line)) {
          offenders.push(`${file}: ${line.trim()}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  it("documents the handler-script exposure and rotation guidance in the README", () => {
    const readme = readFileSync(join(SRC_DIR, "..", "README.md"), "utf8");
    expect(readme).toMatch(/ZohoCliq\.Bots\.READ/);
    expect(readme).toMatch(/rotate/i);
    expect(readme).toMatch(/per-agent/i);
  });
});
