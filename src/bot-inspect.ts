import {
  checkCliqHandlerConsistency,
  CLIQ_INBOUND_HANDLER_TYPES,
  type CliqHandlerConsistencyResult,
  type CliqHandlerScriptRecord,
} from "./handler-consistency.js";
import type {
  CliqBotReadFailure,
  CliqBotRecord,
  CliqBotSubscriberPage,
  ResolvedCliqAccount,
} from "./client.js";
import { isCliqBotReadFailure } from "./client.js";
import { resolveCliqInternalBotId } from "./bot-id.js";
export type {
  CliqBotReadFailure,
  CliqBotRecord,
  CliqBotSubscriberPage,
} from "./client.js";

export type CliqKnown<T> =
  | { state: "known"; value: T }
  | { state: "unknown"; reason: string };

export type CliqBotActiveState = "active" | "inactive";
export type CliqBotVisibility = "organization" | "team" | "personal";
export type CliqSubscriptionState = "subscribed" | "not_subscribed";

export interface CliqBotSubscriberSnapshot {
  userIds: string[];
  complete: boolean;
}

export interface CliqBotInspection {
  configuredUniqueName: string;
  botId: CliqKnown<string>;
  exists: CliqKnown<boolean>;
  active: CliqKnown<CliqBotActiveState>;
  visibility: CliqKnown<CliqBotVisibility>;
  teamIds: CliqKnown<string[]>;
  channelParticipation: CliqKnown<string[]>;
  handlerTypes: CliqKnown<string[]>;
  executionType: CliqKnown<"deluge" | "webhook">;
  subscriberCount: CliqKnown<number>;
  subscribers: CliqKnown<CliqBotSubscriberSnapshot>;
  handlerConsistency: CliqHandlerConsistencyResult;
}

export interface CliqBotReader {
  listBots(maxItems?: number): Promise<CliqBotRecord[] | CliqBotReadFailure>;
  getBot(botId: string): Promise<CliqBotRecord | CliqBotReadFailure>;
  listSubscribers(botIdOrUniqueName: string, maxItems?: number): Promise<CliqBotSubscriberPage | CliqBotReadFailure>;
  readHandlerScript(handlerType: string, botId?: string): Promise<{ script?: string; error?: string }>;
}

export interface CliqDoctorBotInspectionView {
  status: "pass" | "warn" | "fail";
  evidence: string[];
  remediation?: string[];
}

function unknown<T>(reason: string): CliqKnown<T> {
  return { state: "unknown", reason };
}

function known<T>(value: T): CliqKnown<T> {
  return { state: "known", value };
}

function failureReason(failure: CliqBotReadFailure): string {
  if (failure.kind === "missing_scope") {
    return "unknown because ZohoCliq.Bots.READ is unavailable or was not consented";
  }
  if (failure.kind === "forbidden") {
    return "unknown because Zoho limits subscriber reads to the bot creator or an organization administrator";
  }
  if (failure.kind === "url_invalid") {
    return "unknown because the bot metadata route requires the internal b-… bot id, not its unique name";
  }
  return `unknown because ${failure.detail}`;
}

function emptyInspection(uniqueName: string, reason: string): CliqBotInspection {
  return {
    configuredUniqueName: uniqueName,
    botId: unknown(reason),
    exists: unknown(reason),
    active: unknown(reason),
    visibility: unknown(reason),
    teamIds: unknown(reason),
    channelParticipation: unknown(reason),
    handlerTypes: unknown(reason),
    executionType: unknown(reason),
    subscriberCount: unknown(reason),
    subscribers: unknown(reason),
    handlerConsistency: { status: "skipped", detail: reason },
  };
}

function activeState(value: unknown): CliqKnown<CliqBotActiveState> {
  if (value === "enabled") return known("active");
  if (value === "disabled") return known("inactive");
  return unknown("unknown because Zoho returned an unrecognised bot status");
}

function visibilityState(value: unknown): CliqKnown<CliqBotVisibility> {
  if (value === "organization" || value === "team" || value === "personal") {
    return known(value);
  }
  return unknown("unknown because Zoho returned no recognised bot scope");
}

function stringArray(value: unknown, reason: string): CliqKnown<string[]> {
  if (!Array.isArray(value)) return unknown(reason);
  return known(value.filter((entry): entry is string => typeof entry === "string"));
}

function executionState(value: unknown): CliqKnown<"deluge" | "webhook"> {
  return value === "deluge" || value === "webhook"
    ? known(value)
    : unknown("unknown because Zoho returned no recognised execution type");
}

async function readHandlers(
  reader: CliqBotReader,
  botId: string,
): Promise<CliqHandlerScriptRecord[]> {
  const handlers: CliqHandlerScriptRecord[] = [];
  for (const type of CLIQ_INBOUND_HANDLER_TYPES) {
    try {
      const result = await reader.readHandlerScript(type, botId);
      handlers.push({ type, script: result.script, error: result.error });
    } catch {
      handlers.push({ type, error: "the handler read threw an unexpected error" });
    }
  }
  return handlers;
}

export async function inspectCliqBot(params: {
  account: Pick<ResolvedCliqAccount, "botId" | "botName" | "webhookSecret">;
  publicWebhookUrl?: string;
  reader: CliqBotReader;
}): Promise<CliqBotInspection> {
  const uniqueName = params.account.botId.trim();
  const resolved = await resolveCliqInternalBotId({
    configuredId: uniqueName,
    listBots: (maxItems) => params.reader.listBots(maxItems),
  });
  if (!resolved.ok) {
    const base = emptyInspection(uniqueName, resolved.reason);
    return resolved.kind === "not_found" ? { ...base, exists: known(false) } : base;
  }
  const internalId = resolved.botId;
  let record: CliqBotRecord | CliqBotReadFailure;
  try {
    record = await params.reader.getBot(internalId);
  } catch {
    record = { kind: "transport", detail: "the bot metadata read threw an unexpected error" };
  }
  if (isCliqBotReadFailure(record)) {
    const reason = failureReason(record);
    return {
      ...emptyInspection(uniqueName, reason),
      botId: known(internalId),
      exists: record.kind === "not_found" ? known(false) : known(true),
    };
  }
  let subscriberResult: CliqBotSubscriberPage | CliqBotReadFailure;
  try {
    subscriberResult = await params.reader.listSubscribers(internalId);
  } catch {
    subscriberResult = { kind: "transport", detail: "the subscriber listing threw an unexpected error" };
  }
  const subscribers: CliqKnown<CliqBotSubscriberSnapshot> = isCliqBotReadFailure(subscriberResult)
    ? unknown(failureReason(subscriberResult))
    : known({
        userIds: subscriberResult.subscribers
          .map((subscriber) => subscriber.user_id)
          .filter((id): id is string => typeof id === "string" && id.length > 0),
        complete: subscriberResult.complete,
      });
  const handlers = await readHandlers(params.reader, internalId);
  const handlerConsistency = checkCliqHandlerConsistency({
    handlers,
    configSecret: params.account.webhookSecret,
    expectedWebhookUrl: params.publicWebhookUrl,
  });
  const handlerTypes = Array.isArray(record.handlers)
    ? known(
        record.handlers
          .map((handler) => handler.type)
          .filter((type): type is string => typeof type === "string"),
      )
    : unknown<string[]>("unknown because Zoho returned no handler summary");
  return {
    configuredUniqueName: uniqueName,
    botId: known(internalId),
    exists: known(true),
    active: activeState(record.status),
    visibility: visibilityState(record.scope),
    teamIds: stringArray(record.team_ids, "unknown because Zoho returned no team scope details"),
    channelParticipation: stringArray(
      record.channel_participation,
      "unknown because Zoho returned no channel participation details",
    ),
    handlerTypes,
    executionType: executionState(record.execution_type),
    subscriberCount:
      typeof record.subscriber_count === "number"
        ? known(record.subscriber_count)
        : unknown("unknown because Zoho returned no subscriber count"),
    subscribers,
    handlerConsistency,
  };
}

export function resolveCliqSubscriptionState(
  inspection: CliqBotInspection,
  userId: string,
): CliqKnown<CliqSubscriptionState> {
  if (inspection.subscribers.state === "unknown") return inspection.subscribers;
  if (inspection.subscribers.value.userIds.includes(userId)) return known("subscribed");
  if (!inspection.subscribers.value.complete) {
    return unknown("unknown because the subscriber page walk was truncated before completion");
  }
  return known("not_subscribed");
}

function describeKnown<T>(value: CliqKnown<T>, render: (knownValue: T) => string): string {
  return value.state === "known" ? render(value.value) : value.reason;
}

export function describeCliqBotInspection(inspection: CliqBotInspection): string[] {
  return [
    `bot existence: ${describeKnown(inspection.exists, (value) => (value ? "present" : "absent"))}`,
    `bot active state: ${describeKnown(inspection.active, String)}`,
    `bot visibility: ${describeKnown(inspection.visibility, String)}`,
    `subscriber count: ${describeKnown(inspection.subscriberCount, String)}`,
    `subscriber list: ${
      inspection.subscribers.state === "known"
        ? inspection.subscribers.value.complete
          ? "available and complete"
          : "available but incomplete"
        : inspection.subscribers.reason
    }`,
    `handler consistency: ${inspection.handlerConsistency.detail}`,
  ];
}

export function toCliqDoctorBotInspection(
  inspection: CliqBotInspection,
): CliqDoctorBotInspectionView {
  const evidence = describeCliqBotInspection(inspection);
  const absent = inspection.exists.state === "known" && inspection.exists.value === false;
  const inactive = inspection.active.state === "known" && inspection.active.value === "inactive";
  if (absent || inactive || inspection.handlerConsistency.status === "fail") {
    return {
      status: "fail",
      evidence,
      remediation: absent
        ? ["Verify channels.cliq.botId and confirm the bot is visible to the OAuth client."]
        : inactive
          ? ["Activate the configured bot in Zoho Cliq before testing first contact."]
          : ["Review the redacted handler conflict and require confirmation before changing Zoho-held code."],
    };
  }
  const unknownFacet = [
    inspection.exists,
    inspection.active,
    inspection.visibility,
    inspection.subscriberCount,
    inspection.subscribers,
  ].some((value) => value.state === "unknown");
  const narrowerScope =
    inspection.visibility.state === "known" && inspection.visibility.value !== "organization";
  if (unknownFacet || narrowerScope || inspection.handlerConsistency.status === "skipped") {
    return {
      status: "warn",
      evidence,
      remediation: [
        "Grant and re-consent ZohoCliq.Bots.READ; subscriber details additionally require the bot creator or an organization administrator.",
      ],
    };
  }
  return { status: "pass", evidence };
}
