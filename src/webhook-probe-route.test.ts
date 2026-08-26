import { describe, it, expect, beforeEach } from "vitest";
import { resetCliqDedupeForTest } from "./dedupe.js";
import {
  createCliqTestConfig,
  createMockIncomingRequest,
  createMockServerResponse,
  createTestRuntimeChannel,
  registerCliqPluginForTest,
  createDmDelugePayload,
} from "./test-api.js";
import { CLIQ_PROBE_HANDLER, buildCliqProbeBody } from "./webhook-probe.js";

/**
 * The preflight probe must terminate BEFORE inbound dispatch. These tests
 * drive the real registered `/cliq/webhook` handler and assert the
 * no-dispatch guarantee from the outside: an authenticated probe answers 200
 * and never reaches `runtime.channel.inbound.run`.
 */
describe("/cliq/webhook probe handling (issue #96)", () => {
  const SECRET = "s3cr3t";

  beforeEach(() => {
    resetCliqDedupeForTest();
  });

  function wire() {
    let dispatches = 0;
    const registration = registerCliqPluginForTest();
    registration.api.config = createCliqTestConfig({
      clientId: "id",
      clientSecret: "***",
      botId: "laura",
      botName: "Laura",
      webhookSecret: SECRET,
      dmPolicy: "open",
      allowFrom: ["*"],
    });
    registration.api.runtime = createTestRuntimeChannel(async () => {
      dispatches += 1;
    });
    return { registration, dispatches: () => dispatches };
  }

  async function post(
    registration: ReturnType<typeof registerCliqPluginForTest>,
    body: unknown,
    headers: Record<string, string> = {},
  ) {
    const res = createMockServerResponse();
    await registration.webhook.handler(
      createMockIncomingRequest("POST", body, headers),
      res as unknown as any,
    );
    return res;
  }

  it("answers an authenticated probe with 200 and never dispatches an agent turn", async () => {
    const { registration, dispatches } = wire();
    const res = await post(registration, buildCliqProbeBody("nonce-1"), {
      "x-cliq-webhook-secret": SECRET,
    });
    expect(res.statusCode).toBe(200);
    expect(dispatches()).toBe(0);
  });

  it("echoes the nonce and reports dispatched:false", async () => {
    const { registration } = wire();
    const res = await post(registration, buildCliqProbeBody("nonce-2"), {
      "x-cliq-webhook-secret": SECRET,
    });
    const payload = JSON.parse(res.body);
    expect(payload.probe).toBe("nonce-2");
    expect(payload.dispatched).toBe(false);
    expect(payload.channel).toBe("cliq");
    expect(payload.botId).toBe("laura");
  });

  it("rejects an unauthenticated probe with 401 without dispatching", async () => {
    const { registration, dispatches } = wire();
    const res = await post(registration, buildCliqProbeBody("nonce-3"));
    expect(res.statusCode).toBe(401);
    expect(dispatches()).toBe(0);
  });

  it("rejects a wrong-secret probe with 401 without dispatching", async () => {
    const { registration, dispatches } = wire();
    const res = await post(registration, buildCliqProbeBody("nonce-4"), {
      "x-cliq-webhook-secret": "wrong",
    });
    expect(res.statusCode).toBe(401);
    expect(dispatches()).toBe(0);
  });

  it("fails closed with 503 when no webhookSecret is configured", async () => {
    const registration = registerCliqPluginForTest();
    let dispatches = 0;
    registration.api.config = createCliqTestConfig({
      clientId: "id",
      clientSecret: "***",
      botId: "laura",
      botName: "Laura",
    });
    registration.api.runtime = createTestRuntimeChannel(async () => {
      dispatches += 1;
    });
    const res = await post(registration, buildCliqProbeBody("nonce-5"), {
      "x-cliq-webhook-secret": SECRET,
    });
    expect(res.statusCode).toBe(503);
    expect(dispatches).toBe(0);
  });

  it("never leaks the webhook secret in the probe response", async () => {
    const { registration } = wire();
    const res = await post(registration, buildCliqProbeBody("nonce-6"), {
      "x-cliq-webhook-secret": SECRET,
    });
    expect(res.body).not.toContain(SECRET);
  });

  it("still dispatches a normal authenticated DM (the probe path does not swallow real traffic)", async () => {
    const { registration, dispatches } = wire();
    const res = await post(registration, createDmDelugePayload(), {
      "x-cliq-webhook-secret": SECRET,
    });
    expect(res.statusCode).toBe(200);
    expect(dispatches()).toBe(1);
  });

  it("does not treat a message whose TEXT contains the probe marker as a probe", async () => {
    const { registration, dispatches } = wire();
    const res = await post(
      registration,
      createDmDelugePayload({ message: { text: CLIQ_PROBE_HANDLER, id: "m9" } }),
      { "x-cliq-webhook-secret": SECRET },
    );
    expect(res.statusCode).toBe(200);
    expect(dispatches()).toBe(1);
  });
});
