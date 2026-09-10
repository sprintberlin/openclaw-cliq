import { describe, expect, it, vi } from "vitest";
import {
  CLIQ_AUTH_CODE_ENV,
  runCliqOAuthExchangeCommand,
  type CliqOAuthExchangeCommandDeps,
} from "./oauth-exchange-command.js";
import { FULL_SCOPE_STRING } from "./capabilities.js";

const TOKEN_VAL = "1000.refresh-token-secret-value-must-never-be-printed";

function createDeps(params: {
  fetch?: typeof fetch;
  mutateConfigFile?: CliqOAuthExchangeCommandDeps["mutateConfigFile"];
} = {}) {
  const lines: string[] = [];
  const errors: string[] = [];
  const deps: CliqOAuthExchangeCommandDeps = {
    fetch: params.fetch ?? (async () => new Response(JSON.stringify({ refresh_token: TOKEN_VAL, scope: FULL_SCOPE_STRING }), { status: 200 })) as typeof fetch,
    mutateConfigFile: params.mutateConfigFile
      ?? (async ({ mutate }) => {
        // The real SDK helper always runs the mutator; a mock that does not
        // would make an accepted write look like a lost race.
        mutate({ channels: { cliq: {} } } as never);
      }),
    writeLine: (line) => lines.push(line),
    writeError: (line) => errors.push(line),
  };
  return { deps, lines, errors };
}

describe("cliq oauth-exchange command (issue #248)", () => {
  it("exchanges an authorization code and records the refresh token without printing it", async () => {
    let capturedDraft: Record<string, unknown> | null = null;
    const { deps, lines, errors } = createDeps({
      mutateConfigFile: async ({ mutate }) => {
        const draft = { channels: { cliq: { clientId: "cid" } } } as never;
        mutate(draft);
        capturedDraft = draft;
      },
    });

    const code = await runCliqOAuthExchangeCommand(
      {
        cfg: { channels: { cliq: { clientId: "cid", clientSecret: "csec" } } } as never,
        code: "1000.auth-code-value",
      },
      deps,
    );
    expect(code).toBe(0);
    expect(errors).toEqual([]);
    expect(capturedDraft).toEqual({
      channels: { cliq: { clientId: "cid", refreshToken: TOKEN_VAL } },
    });
    const output = `${lines.join("\n")}\n${errors.join("\n")}`;
    expect(output).not.toContain(TOKEN_VAL);
    expect(output).toContain("Refresh token stored in channels.cliq.refreshToken.");
    expect(output).toContain("Restart the OpenClaw gateway");
  });

  it("reads the authorization code from OPENCLAW_CLIQ_AUTH_CODE when not given explicitly", async () => {
    const original = process.env[CLIQ_AUTH_CODE_ENV];
    process.env[CLIQ_AUTH_CODE_ENV] = "env-code";
    try {
      const fetchMock = vi.fn(async (url: URL | Parameters<typeof fetch>[0]) => {
        expect(url.toString()).toContain("code=env-code");
        return new Response(JSON.stringify({ refresh_token: TOKEN_VAL, scope: FULL_SCOPE_STRING }), { status: 200 });
      });
      const { deps } = createDeps({ fetch: fetchMock as never });
      const code = await runCliqOAuthExchangeCommand(
        { cfg: { channels: { cliq: { clientId: "cid", clientSecret: "csec" } } } as never },
        deps,
      );
      expect(code).toBe(0);
      expect(fetchMock).toHaveBeenCalled();
    } finally {
      if (original === undefined) delete process.env[CLIQ_AUTH_CODE_ENV];
      else process.env[CLIQ_AUTH_CODE_ENV] = original;
    }
  });

  it("warns when granted scopes are missing entries from the combined 14-scope profile", async () => {
    const { deps, lines } = createDeps({
      fetch: (async () =>
        new Response(
          JSON.stringify({ refresh_token: TOKEN_VAL, scope: "ZohoCliq.Webhooks.CREATE" }),
          { status: 200 },
        )) as typeof fetch,
    });
    const code = await runCliqOAuthExchangeCommand(
      {
        cfg: { channels: { cliq: { clientId: "cid", clientSecret: "csec" } } } as never,
        code: "code",
      },
      deps,
    );
    expect(code).toBe(0);
    const text = lines.join("\n");
    expect(text).toContain("Warning: the combined Cliq profile is missing");
    expect(text).toContain("ZohoCliq.Channels.UPDATE");
  });

  it("offers --check to verify an already-configured token without writing config", async () => {
    const fetchMock = vi.fn(async (url: URL | Parameters<typeof fetch>[0]) => {
      expect(url.toString()).toContain("grant_type=refresh_token");
      expect(url.toString()).toContain("refresh_token=stored-rt");
      return new Response(
        JSON.stringify({ access_token: "temp-access-token", scope: FULL_SCOPE_STRING }),
        { status: 200 },
      );
    });
    const mutateMock = vi.fn(async () => {});
    const { deps, lines } = createDeps({
      fetch: fetchMock as never,
      mutateConfigFile: mutateMock,
    });
    const code = await runCliqOAuthExchangeCommand(
      {
        cfg: {
          channels: { cliq: { clientId: "cid", clientSecret: "csec", refreshToken: "stored-rt" } },
        } as never,
        check: true,
      },
      deps,
    );
    expect(code).toBe(0);
    expect(mutateMock).not.toHaveBeenCalled();
    expect(lines.join("\n")).toContain("Refresh-token check succeeded; no config was changed.");
  });

  it("maps invalid_code to a helpful actionable troubleshooting message", async () => {
    const { deps, errors } = createDeps({
      fetch: (async () =>
        new Response(JSON.stringify({ error: "invalid_code" }), { status: 400 })) as typeof fetch,
    });
    const code = await runCliqOAuthExchangeCommand(
      {
        cfg: { channels: { cliq: { clientId: "cid", clientSecret: "csec" } } } as never,
        code: "expired-code",
      },
      deps,
    );
    expect(code).toBe(1);
    expect(errors.join("\n")).toMatch(/invalid, expired, or already used/i);
  });

  it("aggregates missing inputs into a single diagnostic line", async () => {
    const { deps, errors } = createDeps();
    const code = await runCliqOAuthExchangeCommand({ cfg: { channels: { cliq: {} } } as never }, deps);
    expect(code).toBe(2);
    expect(errors.join("\n")).toContain("Missing required inputs: clientId, clientSecret, authorization code");
  });

  it("leaves the previous config intact when atomic mutation fails", async () => {
    const { deps, errors } = createDeps({
      mutateConfigFile: async () => {
        throw new Error("disk full");
      },
    });
    const code = await runCliqOAuthExchangeCommand(
      {
        cfg: { channels: { cliq: { clientId: "cid", clientSecret: "csec" } } } as never,
        code: "code",
      },
      deps,
    );
    expect(code).toBe(1);
    expect(errors.join("\n")).toMatch(/previous config was left unchanged/i);
  });
});
