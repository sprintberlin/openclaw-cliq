/**
 * Shared test harness for the openclaw-cliq plugin — a local equivalent of the
 * SDK's (unpublished, repo-local) `openclaw/plugin-sdk/plugin-test-api` +
 * `openclaw/plugin-sdk/test-env` helpers. Consolidates the mock plugin API,
 * the mock HTTP request/response shapes, and the channel-section config
 * builder that were previously duplicated across `*.test.ts` files, so the
 * plugin is exercised through one consistent contract surface.
 *
 * This module is test-only: it is excluded from the published `dist/` build
 * (see `tsconfig.build.json` `exclude`) and MUST NOT be imported by
 * production source. It deliberately avoids importing `vitest` so it stays a
 * pure, framework-agnostic fixture layer.
 */

import { EventEmitter } from "node:events";
import type { OpenClawConfig } from "openclaw/plugin-sdk/channel-core";
import cliqEntry from "../index.js";

/** A captured `api.registerHttpRoute(...)` registration. */
export interface CliqCapturedRoute {
  path: string;
  auth: string;
  handler: (req: any, res: any) => Promise<boolean | void> | boolean | void;
}

/** Minimal mutable plugin-API mock captured by `createTestPluginApi`. */
export interface CliqTestPluginApi {
  registrationMode: "full" | "setup";
  config: Record<string, unknown>;
  logger: {
    warn: (m: string) => void;
    error: (m: string) => void;
    info: (m: string) => void;
    debug?: (m: string) => void;
  };
  runtime: Record<string, unknown>;
  registerChannel: () => void;
  registerCli: () => void;
  registerHttpRoute: (params: CliqCapturedRoute) => void;
  registerSecurityAuditCollector: (collector: (ctx: unknown) => unknown) => void;
}

/** Captured side-effects of registering the plugin against a mock API. */
export interface CliqTestPluginRegistration {
  api: CliqTestPluginApi;
  routes: CliqCapturedRoute[];
  registeredChannel: () => boolean;
  cliRegistered: () => boolean;
  securityAuditCollectors: Array<(ctx: unknown) => unknown>;
  webhook: CliqCapturedRoute;
}

/** Minimal `IncomingMessage`-like shape for the webhook handler. */
export interface CliqMockIncomingRequest {
  method?: string;
  headers?: Record<string, string | string[] | undefined>;
  on(
    event: "data" | "end" | "error",
    listener: (...args: any[]) => void,
  ): this;
  removeAllListeners(): this;
  destroy(): void;
}

/** Minimal `ServerResponse`-like shape capturing status + body + headers. */
export interface CliqMockServerResponse {
  statusCode: number;
  headers: Record<string, string | string[]>;
  body: string;
  ended: boolean;
  setHeader(name: string, value: string | string[]): void;
  end(chunk?: string): void;
}

/** A configurable runtime.channel mock used by the durable-ack tests. */
export interface CliqTestRuntimeChannel {
  inboundRun: () => Promise<unknown>;
}

/**
 * Build an `OpenClawConfig` with the `cliq` channel section set to `section`.
 * Drop-in replacement for the `cfgWith` helper previously copy-pasted across
 * `*.test.ts` files.
 */
export function createCliqTestConfig(
  section: Record<string, unknown>,
): OpenClawConfig {
  return { channels: { cliq: section } } as unknown as OpenClawConfig;
}

/**
 * Build a mock `ServerResponse` capturing `statusCode`, `headers`, `body`,
 * and `ended`. Drop-in replacement for the `makeRes` helper.
 */
export function createMockServerResponse(): CliqMockServerResponse {
  return {
    statusCode: 0,
    headers: {},
    body: "",
    ended: false,
    setHeader(name, value) {
      this.headers[name] = value;
    },
    end(chunk) {
      if (chunk !== undefined) this.body += chunk;
      this.ended = true;
    },
  };
}

/**
 * Build a mock `IncomingMessage` that emits `data` + `end` (microtask-delayed)
 * with the JSON-serialized `body`. Drop-in replacement for the `makeReq`
 * helper. Keeps the native `EventEmitter` `on`/`removeAllListeners` so the
 * SDK's `readJsonBody` (which relies on them) works without infinite
 * recursion.
 */
export function createMockIncomingRequest(
  method: string,
  body: unknown,
  headers: Record<string, string | string[] | undefined> = {},
): CliqMockIncomingRequest {
  const ee = new EventEmitter() as EventEmitter &
    CliqMockIncomingRequest & { destroy(): void };
  ee.method = method;
  ee.headers = headers;
  ee.destroy = () => {
    /* no-op */
  };
  queueMicrotask(() => {
    const raw = typeof body === "string" ? body : JSON.stringify(body);
    ee.emit("data", Buffer.from(raw, "utf8"));
    ee.emit("end");
  });
  return ee as CliqMockIncomingRequest;
}

export interface CreateTestPluginApiOptions {
  /** Initial `api.config` (mutated in place by some tests). */
  config?: Record<string, unknown>;
  /** Initial `api.runtime` (the `channel` surface used by the dispatch path). */
  runtime?: Record<string, unknown>;
  /** Logger override; defaults to a silent sink. */
  logger?: Partial<CliqTestPluginApi["logger"]>;
}

/**
 * Build a minimal plugin-API mock that captures `registerHttpRoute` +
 * `registerSecurityAuditCollector` calls and tracks channel / CLI
 * registration. Drop-in replacement for the `buildMockApi` helper.
 */
export function createTestPluginApi(
  options: CreateTestPluginApiOptions = {},
): CliqTestPluginRegistration {
  const routes: CliqCapturedRoute[] = [];
  let registeredChannel = false;
  let cliRegistered = false;
  const securityAuditCollectors: Array<(ctx: unknown) => unknown> = [];
  const api: CliqTestPluginApi = {
    registrationMode: "full",
    config: options.config ?? ({} as Record<string, unknown>),
    logger: {
      warn: () => {},
      error: () => {},
      info: () => {},
      debug: () => {},
      ...options.logger,
    } as CliqTestPluginApi["logger"],
    runtime: options.runtime ?? ({} as Record<string, unknown>),
    registerChannel: () => {
      registeredChannel = true;
    },
    registerCli: () => {
      cliRegistered = true;
    },
    registerHttpRoute: (params) => {
      routes.push(params);
    },
    registerSecurityAuditCollector: (collector) => {
      securityAuditCollectors.push(collector);
    },
  };
  return {
    api,
    routes,
    registeredChannel: () => registeredChannel,
    cliRegistered: () => cliRegistered,
    securityAuditCollectors,
    webhook: undefined as unknown as CliqCapturedRoute,
  };
}

export interface RegisterCliqPluginForTestOptions extends CreateTestPluginApiOptions {
  /** Whether to actually invoke `entry.register(api)` (default `true`). */
  register?: boolean;
}

/**
 * Build the mock API, register the cliq plugin entry against it, and resolve
 * the captured `/cliq/webhook` route. The canonical "wire the plugin for a
 * test" entry point — tests that previously called `cliqEntry.register(api)`
 * then looked up `routes.find(...)` now call this and read `.webhook`.
 */
export function registerCliqPluginForTest(
  options: RegisterCliqPluginForTestOptions = {},
): CliqTestPluginRegistration {
  const registration = createTestPluginApi(options);
  if (options.register !== false) {
    cliqEntry.register(registration.api as unknown as Parameters<typeof cliqEntry.register>[0]);
  }
  const webhook = registration.routes.find((r) => r.path === "/cliq/webhook");
  registration.webhook = webhook as CliqCapturedRoute;
  return registration;
}

/**
 * Build a `runtime.channel` mock sufficient for the durable-ack webhook path
 * (the dispatch path that resolves `runtime.channel.inbound.run` + the
 * routing/session/reply surfaces). Used by tests that drive the full
 * `/cliq/webhook` handler.
 */
export function createTestRuntimeChannel(
  inboundRun: () => Promise<unknown>,
): Record<string, unknown> {
  return {
    channel: {
      routing: {
        resolveAgentRoute: () => ({ agentId: "agent-1", sessionKey: "sess-1" }),
      },
      session: {
        resolveStorePath: () => "/store/agent-1",
        readSessionUpdatedAt: () => undefined,
        recordInboundSession: () => undefined,
      },
      reply: {
        resolveEnvelopeFormatOptions: () => ({}),
        formatAgentEnvelope: () => "envelope text",
        finalizeInboundContext: () => ({}),
        dispatchReplyWithBufferedBlockDispatcher: async () => undefined,
      },
      inbound: { run: inboundRun },
    },
  };
}

/** A canonical mention Deluge payload used across webhook-handler tests. */
export function createMentionDelugePayload(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    message: { text: "@openclaw-bot hello", id: "m1", time: "2026-07-04T10:00:00Z" },
    user: { id: "user-123", name: "Alice", email: "alice@example.com" },
    chat: { id: "chat-1-B", type: "channel" },
    channel: { unique_name: "general" },
    mentions: [{ id: "bot", type: "bot" }],
    handler: "mention",
    ...overrides,
  };
}

/** A canonical DM Deluge payload used across webhook-handler tests. */
export function createDmDelugePayload(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    message: { text: "hello", id: "m1", time: "2026-07-04T10:00:00Z" },
    user: { id: "user-123", name: "Alice", email: "alice@example.com" },
    chat: { id: "chat-1-B", type: "single" },
    handler: "dm",
    ...overrides,
  };
}
