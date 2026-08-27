import { describe, expect, it } from "vitest";
import { cliqPlugin } from "./channel.js";
import { inspectCliqAccount, isConfiguredCliqAccountShape } from "./account-inspect.js";
import { resolveCliqConfig } from "./client.js";
import { cliqStatusAdapter } from "./status.js";
import { createCliqTestConfig as cfgWith } from "./test-api.js";
import {
  CLIQ_WEBHOOK_ROUTE_PATH,
  cliqTransportStatusFields,
  describeCliqWebhookAccount,
} from "./webhook-account.js";

const CONFIGURED = cfgWith({
  clientId: "id",
  clientSecret: "secret",
  botId: "bot",
  botName: "MyBot",
});

describe("isConfiguredCliqAccountShape", () => {
  it("accepts the resolved runtime account shape", () => {
    expect(isConfiguredCliqAccountShape(resolveCliqConfig(CONFIGURED))).toBe(true);
  });

  it("accepts the redacted inspectAccount shape, which carries no clientSecret", () => {
    const inspected = inspectCliqAccount({ cfg: CONFIGURED, accountId: "default" });
    // Guard the premise: the redacted shape must not leak the secret, which is
    // exactly why a resolved-shape-only check misjudged it (issue #98).
    expect((inspected as { clientSecret?: unknown }).clientSecret).toBeUndefined();
    expect(isConfiguredCliqAccountShape(inspected)).toBe(true);
  });

  it("treats a SecretRef-backed clientSecret that cannot resolve synchronously as configured", () => {
    // `configured_unavailable` means the operator DID configure a secret (a
    // file/exec SecretRef); reporting it as unconfigured would hide a real,
    // intentionally configured account from the Health table.
    expect(
      isConfiguredCliqAccountShape({
        clientId: "id",
        botId: "bot",
        tokenStatus: "configured_unavailable",
      }),
    ).toBe(true);
  });

  it("rejects an inspected account whose credential is missing", () => {
    expect(
      isConfiguredCliqAccountShape({
        clientId: "id",
        botId: "bot",
        tokenStatus: "missing",
        configured: false,
      }),
    ).toBe(false);
  });

  it("rejects a resolved account missing any core credential", () => {
    expect(
      isConfiguredCliqAccountShape({ clientId: "id", clientSecret: "s", botId: "" }),
    ).toBe(false);
    expect(
      isConfiguredCliqAccountShape({ clientId: "", clientSecret: "s", botId: "b" }),
    ).toBe(false);
    expect(isConfiguredCliqAccountShape(null)).toBe(false);
  });
});

describe("config.isConfigured (gateway startup + health)", () => {
  it("agrees for the resolved and the inspected shape of the same account", async () => {
    const resolved = cliqPlugin.config.resolveAccount(CONFIGURED, "default");
    const inspected = cliqPlugin.config.inspectAccount!(CONFIGURED, "default");

    // The Channels table resolves; the Health table inspects. Both must reach
    // the same verdict, or one row calls a working account "not configured".
    expect(await cliqPlugin.config.isConfigured!(resolved, CONFIGURED)).toBe(true);
    expect(
      await cliqPlugin.config.isConfigured!(inspected as never, CONFIGURED),
    ).toBe(true);
  });

  it("reports an unconfigured account as unconfigured on both shapes", async () => {
    const empty = cfgWith({});
    const inspected = cliqPlugin.config.inspectAccount!(empty, "default");
    expect(
      await cliqPlugin.config.isConfigured!(inspected as never, empty),
    ).toBe(false);
  });
});

describe("describeCliqWebhookAccount", () => {
  it("describes the account as a configured webhook transport", () => {
    const snapshot = describeCliqWebhookAccount(
      resolveCliqConfig(CONFIGURED),
    ) as Record<string, unknown>;
    expect(snapshot).toMatchObject({
      accountId: "default",
      enabled: true,
      configured: true,
      mode: "webhook",
      webhookPath: CLIQ_WEBHOOK_ROUTE_PATH,
      botId: "bot",
    });
    expect(snapshot.name).toBe("MyBot");
  });

  it("is wired as config.describeAccount so gateway startup sees the transport", () => {
    const describe = cliqPlugin.config.describeAccount;
    expect(typeof describe).toBe("function");
    const snapshot = (describe as (a: unknown, c: unknown) => Record<string, unknown>)(
      resolveCliqConfig(CONFIGURED),
      CONFIGURED,
    );
    expect(snapshot.mode).toBe("webhook");
    expect(snapshot.configured).toBe(true);
  });

  it("keeps the transport fields identical to the ones status reports", () => {
    const described = describeCliqWebhookAccount(
      resolveCliqConfig(CONFIGURED),
    ) as Record<string, unknown>;
    const statusSnapshot = cliqStatusAdapter.buildAccountSnapshot!({
      account: resolveCliqConfig(CONFIGURED),
      cfg: CONFIGURED,
    }) as Record<string, unknown>;
    const transport = cliqTransportStatusFields();
    expect(described.mode).toBe(transport.mode);
    expect(statusSnapshot.mode).toBe(transport.mode);
    expect(described.webhookPath).toBe(transport.webhookPath);
    expect(statusSnapshot.webhookPath).toBe(transport.webhookPath);
  });
});
