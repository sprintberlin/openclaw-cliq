import {
  createChannelProgressDraftCompositor,
  resolveChannelStreamingPreviewCommandText,
  resolveChannelStreamingProgressNarration,
  type AgentPlanStep,
  type ChannelProgressDraftCompositorSnapshot,
} from "openclaw/plugin-sdk/channel-outbound";
import type { GetReplyOptions } from "openclaw/plugin-sdk/reply-runtime";
import type { CliqStreamingMode } from "./client.js";

type CompositorParams = Parameters<typeof createChannelProgressDraftCompositor>[0];
type Compositor = ReturnType<typeof createChannelProgressDraftCompositor>;
type ToolStartPayload = Parameters<NonNullable<GetReplyOptions["onToolStart"]>>[0];
type ItemEventPayload = Parameters<NonNullable<GetReplyOptions["onItemEvent"]>>[0];
type PlanUpdatePayload = Parameters<NonNullable<GetReplyOptions["onPlanUpdate"]>>[0];
type ApprovalEventPayload = Parameters<NonNullable<GetReplyOptions["onApprovalEvent"]>>[0];
type CommandOutputPayload = Parameters<NonNullable<GetReplyOptions["onCommandOutput"]>>[0];
type PatchSummaryPayload = Parameters<NonNullable<GetReplyOptions["onPatchSummary"]>>[0];
type ReasoningStreamPayload = Parameters<NonNullable<GetReplyOptions["onReasoningStream"]>>[0];

export type CliqProgressDraftSink = CompositorParams["update"];

export interface CliqProgressDraftControllerOptions {
  mode: CliqStreamingMode;
  entry: NonNullable<CompositorParams["entry"]>;
  seed: string;
  update: CliqProgressDraftSink;
  deleteCurrent?: CompositorParams["deleteCurrent"];
  active?: boolean;
  onPartialReply?: GetReplyOptions["onPartialReply"];
  reasoningVisible?: boolean;
  setTimeoutFn?: typeof setTimeout;
  clearTimeoutFn?: typeof clearTimeout;
}

export interface CliqProgressDraftReplyOptions
  extends Pick<
    GetReplyOptions,
    | "suppressDefaultToolProgressMessages"
    | "preserveProgressCallbackStartOrder"
    | "onVerboseProgressVisibility"
    | "onPartialReply"
    | "onReasoningStream"
    | "streamReasoningInNonStreamModes"
    | "onToolStart"
    | "onItemEvent"
    | "onPlanUpdate"
    | "onApprovalEvent"
    | "onCommandOutput"
    | "onPatchSummary"
    | "onNarrationUpdate"
    | "onProgressNarratorLifecycle"
    | "onQueuedFollowupAdmitted"
    | "onQueuedFollowupSettled"
    | "commentaryProgressEnabled"
    | "progressPreambleEnabled"
    | "commentaryPayloadsEnabled"
    | "isProgressDraftVisible"
    | "narrationHideCommandText"
  > {}

export interface CliqProgressDraftController {
  readonly hasStarted: boolean;
  buildReplyOptions(): CliqProgressDraftReplyOptions;
  getSnapshot(): ChannelProgressDraftCompositorSnapshot;
  start(): Promise<void>;
  markFinalReplyStarted(): void;
  markFinalReplyDelivered(): void;
  beginNewTurn(): boolean;
  cancel(): void;
}

export function createCliqProgressDraftController(
  options: CliqProgressDraftControllerOptions,
): CliqProgressDraftController {
  const progressMode = options.mode === "progress";
  const progressActive = progressMode && options.active !== false;
  let verboseProgressActive = () => false;
  let finalReplyStarted = false;
  let finalReplyDelivered = false;
  let narratorLifecycle: { beginTurn: () => void; stopTurn: () => void } | undefined;
  let compositor: Compositor;

  const canPushProgress = () =>
    progressActive &&
    !verboseProgressActive() &&
    !finalReplyStarted &&
    !finalReplyDelivered;

  compositor = createChannelProgressDraftCompositor({
    entry: options.entry,
    mode: options.mode,
    active: progressActive,
    seed: options.seed,
    reasoningGate: options.reasoningVisible === true,
    reasoningLinePrefix: "🧠 ",
    commentaryLinePrefix: "💬 ",
    commentaryItalics: false,
    update: async (text, updateOptions) => {
      if (!canPushProgress()) return false;
      return await options.update(text, updateOptions);
    },
    deleteCurrent: options.deleteCurrent,
    setTimeoutFn: options.setTimeoutFn,
    clearTimeoutFn: options.clearTimeoutFn,
  });

  const pushToolStart = async (payload: ToolStartPayload) =>
    canPushProgress() ? await compositor.pushToolEvent(payload) : false;

  const pushItemEvent = async (payload: ItemEventPayload) => {
    if (!canPushProgress()) return false;
    if (payload.kind !== "preamble") return await compositor.pushItemEvent(payload);
    let rendered = await compositor.pushPreambleHeadline(payload.progressText, {
      itemId: payload.itemId,
    });
    if (compositor.commentaryProgressEnabled) {
      rendered =
        (await compositor.pushCommentaryProgress(payload.progressText, {
          itemId: payload.itemId,
        })) || rendered;
    }
    return rendered;
  };

  const pushPlanUpdate = async (payload: PlanUpdatePayload) => {
    if (!canPushProgress() || payload.phase !== "update") return false;
    return await compositor.pushPlanProgress(payload.steps as AgentPlanStep[] | undefined, {
      explanation: payload.explanation,
    });
  };

  const pushApprovalEvent = async (payload: ApprovalEventPayload) =>
    canPushProgress() ? await compositor.pushApprovalEvent(payload) : false;

  const pushCommandOutput = async (payload: CommandOutputPayload) =>
    canPushProgress() ? await compositor.pushCommandOutputEvent(payload) : false;

  const pushPatchSummary = async (payload: PatchSummaryPayload) =>
    canPushProgress() ? await compositor.pushPatchEvent(payload) : false;

  const pushReasoning = async (payload: ReasoningStreamPayload) => {
    if (!canPushProgress() || options.reasoningVisible !== true) return false;
    return await compositor.pushReasoningProgress(payload.text, {
      snapshot: payload.isReasoningSnapshot === true,
    });
  };

  const narrationEnabled =
    progressMode && resolveChannelStreamingProgressNarration(options.entry);
  const cancel = () => {
    narratorLifecycle?.stopTurn();
    compositor.suppress();
    compositor.cancel();
  };

  const buildReplyOptions = (): CliqProgressDraftReplyOptions => ({
    suppressDefaultToolProgressMessages:
      progressMode && compositor.suppressDefaultToolProgressMessages,
    preserveProgressCallbackStartOrder: progressMode ? true : undefined,
    onVerboseProgressVisibility: progressMode
      ? (isActive) => {
          verboseProgressActive = isActive;
        }
      : undefined,
    onPartialReply:
      options.mode === "partial" ? options.onPartialReply : undefined,
    onReasoningStream:
      progressMode && options.reasoningVisible === true ? pushReasoning : undefined,
    streamReasoningInNonStreamModes:
      progressMode && options.reasoningVisible === true ? true : undefined,
    onToolStart: progressMode ? pushToolStart : undefined,
    onItemEvent: progressMode ? pushItemEvent : undefined,
    onPlanUpdate: progressMode ? pushPlanUpdate : undefined,
    onApprovalEvent: progressMode ? pushApprovalEvent : undefined,
    onCommandOutput: progressMode ? pushCommandOutput : undefined,
    onPatchSummary: progressMode ? pushPatchSummary : undefined,
    onNarrationUpdate: narrationEnabled
      ? async (payload) => {
          if (canPushProgress()) await compositor.pushNarrationProgress(payload.text);
        }
      : undefined,
    onProgressNarratorLifecycle: narrationEnabled
      ? (lifecycle) => {
          narratorLifecycle = lifecycle;
        }
      : undefined,
    onQueuedFollowupAdmitted: progressMode
      ? () => {
          finalReplyStarted = false;
          finalReplyDelivered = false;
          if (compositor.beginNewTurn({ force: true })) narratorLifecycle?.beginTurn();
        }
      : undefined,
    onQueuedFollowupSettled: progressMode ? cancel : undefined,
    commentaryProgressEnabled:
      progressMode && compositor.commentaryProgressEnabled ? true : undefined,
    progressPreambleEnabled: progressMode ? true : undefined,
    commentaryPayloadsEnabled:
      progressMode && compositor.commentaryProgressEnabled ? true : undefined,
    isProgressDraftVisible: progressMode ? () => compositor.isVisible : undefined,
    narrationHideCommandText:
      narrationEnabled &&
      resolveChannelStreamingPreviewCommandText(options.entry) === "status"
        ? true
        : undefined,
  });

  return {
    get hasStarted() {
      return compositor.hasStarted;
    },
    buildReplyOptions,
    getSnapshot: () => compositor.getSnapshot(),
    start: async () => {
      await compositor.start();
    },
    markFinalReplyStarted: () => {
      if (finalReplyStarted) return;
      finalReplyStarted = true;
      compositor.markFinalReplyStarted();
      narratorLifecycle?.stopTurn();
    },
    markFinalReplyDelivered: () => {
      if (finalReplyDelivered) return;
      finalReplyDelivered = true;
      compositor.markFinalReplyDelivered();
    },
    beginNewTurn: () => {
      finalReplyStarted = false;
      finalReplyDelivered = false;
      const began = compositor.beginNewTurn({ force: true });
      if (began) narratorLifecycle?.beginTurn();
      return began;
    },
    cancel,
  };
}
