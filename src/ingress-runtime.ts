/**
 * Durable Core ingress for the Cliq webhook channel (issue #261).
 *
 * Adopts OpenClaw Core's public channel-ingress queue + monitor so an
 * inbound Cliq event is durably recorded BEFORE the webhook HTTP 200 is
 * written, and dispatch happens through `createChannelIngressMonitor`
 * with the turn-adoption lifecycle threaded into the existing reply
 * options.
 *
 * Module boundaries:
 *   - This file owns the monitor registry, the versioned secret-free
 *     payload codec, and the account lifecycle (create/start/stop).
 *   - `index.ts` (the HTTP route) only calls `admitCliqEvent` after the
 *     accept gates; before monitor readiness with a durable surface it
 *     answers `503`, never an unsafe ack-first dispatch.
 *   - `src/gateway.ts` owns monitor start/stop through the account
 *     lifecycle (`startAccount` / `stopAccount`).
 *   - `src/inbound.ts` receives the lifecycle through its optional
 *     `turnAdoptionLifecycle` parameter, so the reply pipeline is unchanged.
 *
 * SDK import policy: `createChannelIngressMonitor`,
 * `bindIngressLifecycleToReplyOptions` and `createChannelIngressError` are
 * static named imports from `openclaw/plugin-sdk/channel-outbound` — the
 * only public subpath that exports all three on EVERY supported OpenClaw
 * version (2026.8.2 / 2026.9.3 / 2026.9.8 / 2026.10.2). 2026.10.2 dropped
 * the `openclaw/plugin-sdk/channel-message` alias the issue text named
 * (CHANGELOG #302), so importing there would fail `check:sdk-compat`.
 *
 * Fallback contract: when the runtime exposes no
 * `runtime.state.openChannelIngressQueue` (unauthorized/path install), the
 * webhook keeps the pre-queue behaviour and this registry logs ONE
 * actionable diagnostic per process. There is no Cliq-local queue, no
 * retry loop, and no startup crash on that path.
 */

import {
  bindIngressLifecycleToReplyOptions,
  createChannelIngressError,
  createChannelIngressMonitor,
  type ChannelIngressMonitorDeliveryResult,
  type ChannelIngressMonitorLifecycle,
  type ChannelIngressQueue,
  type ChannelIngressQueueClaim,
} from "openclaw/plugin-sdk/channel-outbound";
import type { OpenClawConfig } from "openclaw/plugin-sdk/channel-core";
import type { CliqLogger } from "./logger.js";
import type { CliqRuntime, ParsedCliqInbound } from "./inbound.js";

const CLIQ_INGRESS_PAYLOAD_VERSION = 1;

/**
 * Stable identity extracted from a parsed Cliq inbound by the monitor's
 * `inspect` callback (`eventId` = parsed `messageId`, `laneKey` =
 * conversation).
 */
export interface CliqIngressFacts {
  eventId: string;
  laneKey: string;
}

/** Build the lane key from the conversation context. */
export function resolveCliqIngressLaneKey(parsed: ParsedCliqInbound): string {
  if (parsed.isGroup) {
    return `cliq:group:${parsed.channelUniqueName ?? parsed.channelId ?? parsed.chatId}`;
  }
  // DMs lane on a stable (sender, chat) tuple so parallel conversations
  // serialize per conversation instead of globally.
  return `cliq:dm:${parsed.chatId || "chat"}:${parsed.senderId || "anon"}`;
}

/**
 * Extract the queue identity for one parsed Cliq inbound. Returns `null`
 * when there is nothing stable to key on — the monitor then reports the
 * admission as "ignored" and the route falls back to the pre-queue path.
 */
export function resolveCliqIngressFacts(
  parsed: ParsedCliqInbound,
): CliqIngressFacts | null {
  const eventId = parsed.messageId?.trim() || "";
  if (!eventId) return null;
  return { eventId, laneKey: resolveCliqIngressLaneKey(parsed) };
}

/** Stored payload shape for `storage: "raw-event"` (Core wraps the body). */
export interface CliqIngressStoredPayload {
  version: number;
  rawEvent: string;
}

/**
 * Versioned, secret-free codec for {@link ParsedCliqInbound}.
 *
 * - `version` is the durable-record discriminator; a row written by a
 *   future/foreign schema is rejected through `createClaimError`
 *   ("invalid-version") and dead-letters as non-retryable instead of
 *   looping.
 * - The body is the parsed inbound deep-cloned through JSON with
 *   `Uint8Array` attachment bytes encoded as base64 (multipart deliveries
 *   forward raw file bytes; the agent turn needs them after a restart
 *   re-dispatch). `undefined` fields drop out naturally — every remaining
 *   field is protocol metadata or user text, no secrets: the webhook
 *   secret, OAuth tokens, and client credentials live on the account
 *   config, never on the parsed inbound.
 * - `identity-mismatch` is produced by the Core monitor itself when
 *   `inspect` on the claim path disagrees with the recorded id/lane; our
 *   `createClaimError` supplies the error for both kinds.
 */
const CliqIngressPayloadError = createChannelIngressError(
  "CliqIngressPayloadError",
  { withReason: true },
);

const BYTES_MARKER = "__cliqB64";

function bytesReplacer(_key: string, value: unknown): unknown {
  if (value instanceof Uint8Array) {
    return { [BYTES_MARKER]: Buffer.from(value).toString("base64") };
  }
  return value;
}

function bytesReviver(_key: string, value: unknown): unknown {
  if (
    value &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    typeof (value as Record<string, unknown>)[BYTES_MARKER] === "string"
  ) {
    const base64 = (value as Record<string, string>)[BYTES_MARKER]!;
    return new Uint8Array(Buffer.from(base64, "base64"));
  }
  return value;
}

/** Serialize the parsed inbound into the durable queue body. */
export function serializeCliqIngressEvent(parsed: ParsedCliqInbound): string {
  return JSON.stringify(parsed, bytesReplacer);
}

/** Parse + revive a durable queue body. Throws the codec claim error on corruption. */
export function deserializeCliqIngressEvent(
  body: string,
  claim: ChannelIngressQueueClaim<CliqIngressStoredPayload, unknown>,
  createClaimError: CliqIngressCodec["createClaimError"],
): ParsedCliqInbound {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body, bytesReviver);
  } catch {
    throw createClaimError("invalid-version", claim);
  }
  if (
    !parsed ||
    typeof parsed !== "object" ||
    Array.isArray(parsed) ||
    typeof (parsed as ParsedCliqInbound).messageId !== "string" ||
    typeof (parsed as ParsedCliqInbound).text !== "string" ||
    typeof (parsed as ParsedCliqInbound).chatId !== "string"
  ) {
    throw createClaimError("invalid-version", claim);
  }
  const candidate = parsed as ParsedCliqInbound;
  if (candidate.messageId !== claim.id) {
    throw createClaimError("identity-mismatch", claim);
  }
  return {
    ...candidate,
    attachments: Array.isArray(candidate.attachments) ? candidate.attachments : [],
    mentionIds: Array.isArray(candidate.mentionIds) ? candidate.mentionIds : [],
  };
}

/**
 * Non-retryable claim error factory used by the codec (Core error
 * contract: the drain dead-letters errors created this way instead of
 * retrying them).
 */
export function createCliqIngressClaimError(
  kind: "invalid-version" | "identity-mismatch",
  claim: ChannelIngressQueueClaim<CliqIngressStoredPayload, unknown>,
): Error {
  if (kind === "invalid-version") {
    return new CliqIngressPayloadError(
      kind,
      `cliq ingress payload at ${claim.id} is corrupt or has an unsupported payload version (expected ${CLIQ_INGRESS_PAYLOAD_VERSION}).`,
    );
  }
  return new CliqIngressPayloadError(
    kind,
    `cliq ingress identity changed after durable admission for ${claim.id}.`,
  );
}

export interface CliqIngressCodec {
  version: number;
  storage: "raw-event";
  serialize: (raw: CliqIngressRawEvent) => string;
  deserialize: (
    body: string,
    context: { claim: ChannelIngressQueueClaim<CliqIngressStoredPayload, unknown> },
  ) => CliqIngressRawEvent;
  createClaimError: (
    kind: "invalid-version" | "identity-mismatch",
    claim: ChannelIngressQueueClaim<CliqIngressStoredPayload, unknown>,
  ) => Error;
}

/** Build the monitor's versioned payload codec. */
export function createCliqIngressPayloadCodec(): CliqIngressCodec {
  return {
    version: CLIQ_INGRESS_PAYLOAD_VERSION,
    storage: "raw-event",
    serialize: (raw) => serializeCliqIngressEvent(raw.parsed),
    deserialize: (body, context) => ({
      parsed: deserializeCliqIngressEvent(
        body,
        context.claim,
        createCliqIngressClaimError,
      ),
      // Account + admission timestamp come from the durable record so a
      // post-restart re-dispatch keeps its original identity/ordering
      // instead of pretending to be a fresh request.
      accountId: context.claim.accountId,
      receivedAt: context.claim.receivedAt,
    }),
    createClaimError: createCliqIngressClaimError,
  };
}

/**
 * Raw event admitted through the monitor. `receivedAt` is the admission
 * timestamp so replays keep their original ordering.
 */
export interface CliqIngressRawEvent {
  parsed: ParsedCliqInbound;
  accountId: string;
  receivedAt: number;
}

/** Subset of the Core monitor's `admit` outcome the route reasons about. */
export type CliqIngressAdmitOutcome =
  | { kind: "ignored" }
  | {
      kind: "durable";
      queueResult:
        | { kind: "accepted"; duplicate: false; record: { id: string } }
        | { kind: "pending"; duplicate: true; record: { id: string } }
        | { kind: "claimed"; duplicate: true; record: { id: string } }
        | { kind: "completed"; duplicate: true; record: { id: string } }
        | {
            kind: "failed";
            duplicate: true;
            record: { id: string; message?: string };
          };
    };

/** Structural view of the Core monitor this plugin uses. */
export interface CliqIngressMonitor {
  admit: (raw: CliqIngressRawEvent) => Promise<CliqIngressAdmitOutcome>;
  start: () => void;
  stop: () => Promise<void>;
  waitForIdle: () => Promise<void>;
  isRunning: () => boolean;
  isStopped: () => boolean;
}

/** Turn-adoption lifecycle handed to `dispatchCliqInbound` via replyOptions. */
export type CliqTurnAdoptionLifecycle = ReturnType<
  typeof bindIngressLifecycleToReplyOptions
>["turnAdoptionLifecycle"];

/** Outcome the dispatch seam reports back to the Core drain. */
export type CliqDeliverOutcome =
  | { kind: "completed" }
  | { kind: "failed"; error: unknown };

/** Delivery seam: dispatch one admitted event with its adoption lifecycle. */
export type CliqIngressDeliverFn = (
  raw: CliqIngressRawEvent,
  turnAdoptionLifecycle: CliqTurnAdoptionLifecycle,
) => Promise<CliqDeliverOutcome>;

/**
 * Process-wide delivery callback. Installed once from `registerFull` so
 * the monitor's drain seam dispatches through the plugin's existing
 * `dispatchCliqInbound` pipeline. The registry reads it when a monitor is
 * created; tests can override it per case.
 */
let deliveryCallback: CliqIngressDeliverFn | null = null;

/** Install the process-wide deliver callback (called once from registerFull). */
export function setCliqIngressDeliveryCallback(fn: CliqIngressDeliverFn): void {
  deliveryCallback = fn;
}

/** Test hook: clear the deliver callback. */
export function resetCliqIngressDeliveryCallbackForTest(): void {
  deliveryCallback = null;
}

function resolveDeliveryCallback(): CliqIngressDeliverFn {
  return (
    deliveryCallback ??
    (async () => ({
      kind: "failed",
      error: new Error(
        "cliq ingress delivery callback is not installed (registerFull has not run).",
      ),
    }))
  );
}

/**
 * Runtime surface for opening account-scoped ingress queues. Built from
 * `runtime.state.openChannelIngressQueue` — the real PluginRuntime field —
 * without `unknown` casts: {@link createCliqIngressRuntimeSurface} takes
 * the plugin's typed {@link CliqRuntime} slice.
 */
export interface CliqIngressRuntimeSurface {
  isAvailable(): boolean;
  openQueue(
    accountId: string,
  ):
    | ChannelIngressQueue<CliqIngressStoredPayload, unknown>
    | undefined;
}

/** Build the surface from the plugin runtime slice. */
export function createCliqIngressRuntimeSurface(
  runtime: CliqRuntime,
): CliqIngressRuntimeSurface {
  const opener = runtime.state?.openChannelIngressQueue;
  if (typeof opener !== "function") {
    return { isAvailable: () => false, openQueue: () => undefined };
  }
  return {
    isAvailable: () => true,
    openQueue: (accountId: string) => {
      try {
        return opener({ accountId });
      } catch {
        return undefined;
      }
    },
  };
}

/** Start result reported to the account lifecycle. */
export type CliqIngressStartResult =
  | "started"
  | "already-running"
  | "unavailable";

interface CliqIngressStartOptions {
  /** Overrides the process-wide deliver callback (tests). */
  deliver?: CliqIngressDeliverFn;
  abortSignal?: AbortSignal;
}

/**
 * Account-keyed monitor registry shared by the gateway lifecycle and the
 * HTTP route.
 *
 * - The lifecycle calls `startAccount` (create + start + register) and
 *   `stopAccount` (stop + unregister).
 * - The route calls `admitEvent` only after `startAccount` succeeded; a
 *   request that arrives while a durable surface exists but no monitor is
 *   running gets `not_ready` and is answered `503`.
 * - A runtime without the durable queue surface gets `unavailable` and the
 *   route keeps the pre-queue behaviour (one diagnostic, no crash loop).
 */
export class CliqIngressMonitorRegistry {
  private readonly monitors = new Map<string, CliqIngressMonitor>();
  private readonly delivers = new Map<string, CliqIngressDeliverFn>();
  /** Accounts whose queue opener exists but failed to open (e.g. a runtime that still gates the queue to trusted installs). */
  private readonly unavailableAccounts = new Set<string>();
  private loggedFallback = false;

  constructor(private readonly surface: CliqIngressRuntimeSurface | null) {}

  /** True when the runtime offers the durable queue surface at all. */
  hasDurableSurface(): boolean {
    return this.surface?.isAvailable() === true;
  }

  /** True when an account's monitor is created and running. */
  isReady(accountId: string): boolean {
    const monitor = this.monitors.get(accountId);
    return Boolean(monitor && !monitor.isStopped());
  }

  /**
   * Create + start + register the account's monitor. Called by the account
   * lifecycle only; the route never spawns monitors.
   */
  async startAccount(
    accountId: string,
    options: CliqIngressStartOptions,
  ): Promise<CliqIngressStartResult> {
    if (!this.surface || !this.surface.isAvailable()) {
      this.logFallbackOnce(
        "runtime.state.openChannelIngressQueue is not available on this OpenClaw install",
      );
      return "unavailable";
    }
    const existing = this.monitors.get(accountId);
    if (existing && !existing.isStopped()) {
      this.delivers.set(accountId, options.deliver ?? resolveDeliveryCallback());
      return "already-running";
    }
    const queue = this.surface.openQueue(accountId);
    if (!queue) {
      this.unavailableAccounts.add(accountId);
      this.logFallbackOnce(
        `openChannelIngressQueue returned no queue for account ${accountId}`,
      );
      return "unavailable";
    }
    this.unavailableAccounts.delete(accountId);
    const codec = createCliqIngressPayloadCodec();
    const deliver = options.deliver ?? resolveDeliveryCallback();
    const monitor = createChannelIngressMonitor<
      CliqIngressRawEvent,
      string,
      CliqIngressStoredPayload
    >({
      queue,
      inspect: (raw): CliqIngressFacts | null =>
        resolveCliqIngressFacts(raw.parsed),
      payload: codec,
      deliver: async (
        raw,
        lifecycle: ChannelIngressMonitorLifecycle,
      ): Promise<ChannelIngressMonitorDeliveryResult | void> => {
        const bound = bindIngressLifecycleToReplyOptions(
          lifecycle,
        ).turnAdoptionLifecycle;
        try {
          const outcome = await deliver(raw, bound);
          if (outcome.kind === "failed") {
            return { kind: "failed-retryable", error: outcome.error };
          }
          return { kind: "completed" };
        } catch (err) {
          return { kind: "failed-retryable", error: err };
        }
      },
      pollIntervalMs: 250,
      retention: "standard",
      admissionMode: "while-running",
      abortSignal: options.abortSignal,
      createStoppedError: () =>
        new Error("cliq ingress monitor is stopped (account not ready)."),
    });
    try {
      monitor.start();
    } catch (err) {
      this.logFallbackOnce(
        `monitor start failed for account ${accountId}: ${String(err)}`,
      );
      return "unavailable";
    }
    this.monitors.set(accountId, monitor as CliqIngressMonitor);
    this.delivers.set(accountId, deliver);
    return "started";
  }

  /**
   * Stop + unregister the account's monitor. Idempotent; unknown accounts
   * resolve without error so lifecycle teardown stays crash-free.
   */
  async stopAccount(accountId: string): Promise<void> {
    const monitor = this.monitors.get(accountId);
    this.monitors.delete(accountId);
    this.delivers.delete(accountId);
    if (!monitor) return;
    try {
      await monitor.stop();
    } catch {
      /* already stopped / already disposed */
    }
  }

  /** Stop every monitor (process shutdown / tests). */
  async stopAll(): Promise<void> {
    const ids = [...this.monitors.keys()];
    for (const id of ids) await this.stopAccount(id);
  }

  /**
   * Admit one parsed event. Only meaningful after {@link startAccount};
   * returns `not_ready` when a durable surface exists but no monitor is
   * running, and `unavailable` when the install has no durable surface
   * (the caller then uses the pre-queue path).
   */
  async admitEvent(
    accountId: string,
    parsed: ParsedCliqInbound,
  ): Promise<
    | { kind: "admitted"; outcome: CliqIngressAdmitOutcome }
    | { kind: "duplicate"; queueKind: string }
    | { kind: "ignored" }
    | { kind: "not_ready" }
    | { kind: "unavailable" }
  > {
    if (!this.surface || !this.surface.isAvailable()) {
      this.logFallbackOnce(
        "runtime.state.openChannelIngressQueue is not available on this OpenClaw install",
      );
      return { kind: "unavailable" };
    }
    if (this.unavailableAccounts.has(accountId)) {
      // The opener exists but cannot open this account's queue (older
      // runtime that still gates the queue): treat like a missing surface so
      // the route keeps the pre-queue behaviour instead of failing 503.
      return { kind: "unavailable" };
    }
    const monitor = this.monitors.get(accountId);
    if (!monitor || monitor.isStopped()) return { kind: "not_ready" };
    const raw: CliqIngressRawEvent = {
      parsed,
      accountId,
      receivedAt: Date.now(),
    };
    const outcome = await monitor.admit(raw);
    if (outcome.kind === "ignored") return { kind: "ignored" };
    if (outcome.queueResult.duplicate) {
      return { kind: "duplicate", queueKind: outcome.queueResult.kind };
    }
    return { kind: "admitted", outcome };
  }

  /** Test hook: inject a fake monitor for an account. */
  setForAccount(
    accountId: string,
    monitor: CliqIngressMonitor | null,
    deliver?: CliqIngressDeliverFn,
  ): void {
    if (monitor === null) {
      this.monitors.delete(accountId);
      this.delivers.delete(accountId);
      return;
    }
    this.monitors.set(accountId, monitor);
    if (deliver) this.delivers.set(accountId, deliver);
  }

  /** Test hook: reset registry state between cases. */
  resetForTest(): void {
    this.monitors.clear();
    this.delivers.clear();
    this.unavailableAccounts.clear();
    this.loggedFallback = false;
  }

  private logFallbackOnce(reason: string): void {
    if (this.loggedFallback) return;
    this.loggedFallback = true;
    console.warn(
      `[cliq] durable ingress queue unavailable (${reason}); keeping the pre-queue webhook behaviour. Install/upgrade OpenClaw to a build exposing runtime.state.openChannelIngressQueue to enable durable-before-ack ingestion (issue #261).`,
    );
  }
}

/** Process-wide registry instance + dispatch context. */
interface CliqIngressGlobals {
  registry: CliqIngressMonitorRegistry;
  runtime: CliqRuntime | null;
  config: (() => OpenClawConfig) | null;
  logger: CliqLogger | null;
}

let globals: CliqIngressGlobals | null = null;

/**
 * Install the runtime surface + dispatch context. Called once from
 * `registerFull(api)` in `index.ts` (both the route and the gateway
 * lifecycle resolve through this instance).
 */
export function configureCliqIngress(params: {
  runtime: CliqRuntime;
  config: () => OpenClawConfig;
  logger?: CliqLogger;
}): CliqIngressMonitorRegistry {
  globals = {
    registry: new CliqIngressMonitorRegistry(
      createCliqIngressRuntimeSurface(params.runtime),
    ),
    runtime: params.runtime,
    config: params.config,
    logger: params.logger ?? null,
  };
  return globals.registry;
}

/**
 * The shared registry. Lazily created with no durable surface so tests
 * (and a process where `registerFull` has not run) see the fallback path
 * rather than a crash.
 */
export function getCliqIngressMonitorRegistry(): CliqIngressMonitorRegistry {
  if (!globals) {
    globals = {
      registry: new CliqIngressMonitorRegistry(null),
      runtime: null,
      config: null,
      logger: null,
    };
  }
  return globals.registry;
}

/** Dispatch context for the monitor's deliver seam (gateway lifecycle). */
export function getCliqIngressDispatchContext(): {
  runtime: CliqRuntime;
  config: OpenClawConfig;
  logger: CliqLogger | null;
} | null {
  if (!globals || !globals.runtime || !globals.config) return null;
  return {
    runtime: globals.runtime,
    config: globals.config(),
    logger: globals.logger,
  };
}

/** Test hook: replace or clear the globals (null restores lazy default). */
export function setCliqIngressGlobalsForTest(
  next: {
    registry: CliqIngressMonitorRegistry;
    runtime?: CliqRuntime | null;
    config?: (() => OpenClawConfig) | null;
    logger?: CliqLogger | null;
  } | null,
): void {
  if (next === null) {
    globals = null;
    return;
  }
  globals = {
    registry: next.registry,
    runtime: next.runtime ?? null,
    config: next.config ?? null,
    logger: next.logger ?? null,
  };
}

/**
 * Webhook-route admission helper. Distinguishes the three outcomes the
 * route must handle differently:
 *   - `unavailable` → pre-queue fallback (legacy ack-policy path);
 *   - `not_ready`   → durable surface exists but the monitor is not
 *     running yet → `503` (never an unsafe ack-first dispatch);
 *   - `admitted` / `duplicate` / `ignored` → ack `200` (the queue or the
 *     no-identity branch already decided replay safety).
 * Append failures throw — the route maps them to `503`.
 */
export async function admitCliqEvent(
  accountId: string,
  parsed: ParsedCliqInbound,
): Promise<
  | { kind: "admitted" }
  | { kind: "duplicate"; queueKind: string }
  | { kind: "ignored" }
  | { kind: "not_ready" }
  | { kind: "unavailable" }
> {
  const registry = getCliqIngressMonitorRegistry();
  const result = await registry.admitEvent(accountId, parsed);
  if (result.kind === "admitted") return { kind: "admitted" };
  if (result.kind === "duplicate") return result;
  return { kind: result.kind };
}
