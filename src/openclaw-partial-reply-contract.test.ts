import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";

const require = createRequire(import.meta.url);
const openclawRoot = dirname(dirname(dirname(require.resolve("openclaw/plugin-sdk/channel-core"))));
const worker = readFileSync(join(openclawRoot, "dist/worker/worker.mjs"), "utf8");
const pkg = JSON.parse(readFileSync(join(openclawRoot, "package.json"), "utf8")) as {
  version?: string;
};

describe("OpenClaw onPartialReply contract (issue #195)", () => {
  it("pins the investigated OpenClaw floor", () => {
    expect(pkg.version).toBe("2026.8.1-beta.3");
  });

  it("stamps textPhaseRequiresTerminal on openai-completions reasoning streams", () => {
    expect(worker).toContain("//#region packages/ai/src/transports/openai-completions-stream.ts");
    expect(worker).toContain("textPhaseRequiresTerminal: true");
    expect(worker).toMatch(
      /if \(!output\.openclawDelivery\?\.textPhaseRequiresTerminal\) output\.openclawDelivery = \{[\s\S]{0,80}textPhaseRequiresTerminal: true/,
    );
  });

  it("returns before emitAssistantStreamData when that flag is set", () => {
    const updateRegion = worker.indexOf(
      "//#region src/agents/embedded-agent-subscribe.handlers.messages.update.ts",
    );
    expect(updateRegion).toBeGreaterThan(-1);
    const nextRegion = worker.indexOf("//#region", updateRegion + 1);
    const body = worker.slice(updateRegion, nextRegion === -1 ? undefined : nextRegion);
    expect(body).toContain(
      "const isReasoningCompletionsText = isCompletionsAssistant && partialAssistant.openclawDelivery?.textPhaseRequiresTerminal === true;",
    );
    const earlyReturn = body.indexOf("if (isReasoningCompletionsText) return;");
    const emit = body.indexOf("ctx.emitAssistantStreamData(data, { emitPartialReply:");
    expect(earlyReturn).toBeGreaterThan(-1);
    expect(emit).toBeGreaterThan(-1);
    expect(earlyReturn).toBeLessThan(emit);
  });

  it("only forwards onPartialReply from emitAssistantStreamDataSafely", () => {
    const deliveryRegion = worker.indexOf(
      "//#region src/agents/embedded-agent-subscribe.reply-delivery.ts",
    );
    expect(deliveryRegion).toBeGreaterThan(-1);
    const nextRegion = worker.indexOf("//#region", deliveryRegion + 1);
    const body = worker.slice(deliveryRegion, nextRegion === -1 ? undefined : nextRegion);
    expect(body).toContain(
      "if (delivery.emitPartialReply && params.onPartialReply && state.shouldEmitPartialReplies)",
    );
    expect(body).toContain("params.onPartialReply(data)");
  });
});

describe("OpenClaw inbound processed-outcome contract (issue #204)", () => {
  it("records skipped:duplicate on an ALS sink, not the plugin-visible run result", () => {
    const executionRegion = worker.indexOf("//#region src/channels/turn/execution.ts");
    expect(executionRegion).toBeGreaterThan(-1);
    const nextRegion = worker.indexOf("//#region", executionRegion + 1);
    const body = worker.slice(executionRegion, nextRegion === -1 ? undefined : nextRegion);
    expect(body).toContain("({result: dispatchResult, processedOutcome} = await withDispatchProcessedOutcomeSink(() => params.runDispatch()));");
    expect(body).toContain("maybeWarnZeroCountVisibleDispatch({");
    expect(body).toContain("processedOutcome");
    expect(body).toMatch(
      /return \{\s*admission,\s*dispatched: true,\s*ctxPayload: params\.ctxPayload,\s*routeSessionKey: params\.routeSessionKey,\s*dispatchResult\s*\};/,
    );
    const finalReturn = body.match(
      /return \{\s*admission,\s*dispatched: true,\s*ctxPayload: params\.ctxPayload,\s*routeSessionKey: params\.routeSessionKey,\s*dispatchResult\s*\};/,
    );
    expect(finalReturn?.[0]).not.toContain("processedOutcome");
  });

  it("classifies a content-derived MessageSid duplicate as skipped:duplicate", () => {
    const prepareRegion = worker.indexOf(
      "//#region src/auto-reply/reply/dispatch-from-config.prepare-context.ts",
    );
    expect(prepareRegion).toBeGreaterThan(-1);
    const nextRegion = worker.indexOf("//#region", prepareRegion + 1);
    const body = worker.slice(prepareRegion, nextRegion === -1 ? undefined : nextRegion);
    expect(body).toContain('recordProcessed("skipped", { reason: "duplicate" });');
    expect(body).toContain('inboundDedupeClaim.status === "duplicate"');
  });
});
