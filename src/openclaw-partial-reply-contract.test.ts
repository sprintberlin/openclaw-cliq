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

/**
 * OpenClaw publishes this bundle minified, so source-file regions and original
 * local variable names are not part of the compatibility contract. Function
 * declarations and object-destructured definitions remain stable build anchors;
 * balance their outer block braces to inspect a local semantic unit.
 */
function workerFunction(signature: string): string {
  const start = worker.indexOf(signature);
  expect(start, `expected ${signature} in OpenClaw worker bundle`).toBeGreaterThan(-1);

  const parameterListEnd = worker.indexOf(")", start);
  expect(parameterListEnd, `expected parameter list end for ${signature}`).toBeGreaterThan(-1);

  const bodyStart = worker.indexOf("{", parameterListEnd);
  expect(bodyStart, `expected ${signature} body in OpenClaw worker bundle`).toBeGreaterThan(-1);

  let depth = 0;
  let quote: "'" | '"' | "`" | undefined;
  for (let index = bodyStart; index < worker.length; index += 1) {
    const character = worker[index];
    if (quote) {
      if (character === "\\") {
        index += 1;
      } else if (character === quote) {
        quote = undefined;
      }
      continue;
    }

    if (character === "'" || character === '"' || character === "`") {
      quote = character;
    } else if (character === "{") {
      depth += 1;
    } else if (character === "}" && --depth === 0) {
      return worker.slice(bodyStart + 1, index);
    }
  }

  throw new Error(`could not find the end of ${signature} in OpenClaw worker bundle`);
}

const identifier = "[A-Za-z_$][\\w$]*";

describe("OpenClaw onPartialReply contract (issue #195)", () => {
  it("pins the investigated OpenClaw floor", () => {
    expect(pkg.version).toBe("2026.8.2");
  });

  it("stamps textPhaseRequiresTerminal for OpenAI Completions reasoning", () => {
    const completionsStream = workerFunction("function processCompletionsStream(");

    // A reasoning batch enters beginReasoning, which records the terminal-only
    // text-phase marker on the assistant message. `!0` is the minified form of
    // true, deliberately asserted here rather than the unminified source text.
    expect(completionsStream).toMatch(
      /beginReasoning=\([^)]*\)=>\{[\s\S]{0,500}?openclawDelivery\?\.textPhaseRequiresTerminal\|\|\([\s\S]{0,500}?textPhaseRequiresTerminal:!0/,
    );
    expect(completionsStream).toMatch(
      /readOpenAICompletionsReasoningBatch\([^)]*\)[\s\S]{0,300}?\.hasThinking[\s\S]{0,300}?beginReasoning\([^)]*,!0\)/,
    );
  });

  it("returns before partial-reply emission when that marker is set", () => {
    const messageUpdate = workerFunction("function handleMessageUpdate(");
    const terminalGate = messageUpdate.match(
      new RegExp(
        `(${identifier})=${identifier}&&${identifier}\\.openclawDelivery\\?\\.textPhaseRequiresTerminal===!0`,
      ),
    );
    expect(terminalGate, "expected a completions terminal-text gate").not.toBeNull();

    const gateName = terminalGate?.[1];
    expect(gateName).toBeTruthy();
    const earlyReturn = messageUpdate.search(
      new RegExp(`if\\(${gateName}\\|\\|[\\s\\S]{0,1200}?\\)return;`),
    );
    const partialReplyEmission = messageUpdate.indexOf("emitPartialReply:");
    expect(earlyReturn).toBeGreaterThan(-1);
    expect(partialReplyEmission).toBeGreaterThan(-1);
    expect(earlyReturn).toBeLessThan(partialReplyEmission);
  });

  it("only forwards onPartialReply from emitAssistantStreamDataSafely", () => {
    const replyDelivery = workerFunction("function createReplyDelivery(");
    const safeEmitter = replyDelivery.indexOf("emitAssistantStreamDataSafely=");
    const partialReplyGuard = replyDelivery.search(
      new RegExp(
        `${identifier}\\.emitPartialReply&&${identifier}\\.onPartialReply&&${identifier}\\.shouldEmitPartialReplies`,
      ),
    );
    const callbackCalls = replyDelivery.match(/\.onPartialReply\(/g) ?? [];

    expect(safeEmitter).toBeGreaterThan(-1);
    expect(partialReplyGuard).toBeGreaterThan(safeEmitter);
    expect(replyDelivery).toMatch(
      /emitAssistantStreamData=\([^)]*\)=>\{[\s\S]{0,300}?emitAssistantStreamDataSafely\(/,
    );
    expect(callbackCalls).toHaveLength(1);
  });
});

describe("OpenClaw inbound processed-outcome contract (issue #204)", () => {
  it("records skipped:duplicate on an ALS sink, not the plugin-visible run result", () => {
    const execution = workerFunction("function runPreparedChannelTurnCoreInTrace(");
    const sink = execution.match(
      new RegExp(
        `\\{result:(${identifier}),processedOutcome:(${identifier})\\}=await withDispatchProcessedOutcomeSink\\(\\(\\)=>${identifier}\\.runDispatch\\(\\)\\)`,
      ),
    );
    expect(sink, "expected dispatch result and outcome to be separated by the ALS sink").not.toBeNull();

    const dispatchResult = sink?.[1];
    const processedOutcome = sink?.[2];
    expect(worker).toMatch(/dispatchProcessedOutcomeSink=.*new AsyncLocalStorage/);
    expect(execution).toMatch(
      new RegExp(
        `maybeWarnZeroCountVisibleDispatch\\(\\{[\\s\\S]{0,500}?dispatchResult:${dispatchResult},processedOutcome:${processedOutcome}\\}\\)`,
      ),
    );
    expect(execution).toMatch(
      new RegExp(
        `\\),\\{admission:${identifier},dispatched:!0,ctxPayload:${identifier}\\.ctxPayload,routeSessionKey:${identifier}\\.routeSessionKey,dispatchResult:${dispatchResult}\\}`,
      ),
    );
  });

  it("classifies a MessageSid dedupe hit as skipped:duplicate", () => {
    const prepareContext = workerFunction("function prepareDispatchOperationContext(");

    // The dedupe key derives from MessageSid, and both completed and in-flight
    // claims are reported through the same skipped:duplicate outcome.
    expect(workerFunction("function buildInboundDedupeKey(")).toContain(
      "normalizeOptionalString(Ot.MessageSid)",
    );
    expect(prepareContext).toMatch(
      new RegExp(
        `let (${identifier})=claimInboundDedupe\\(${identifier}\\);if\\(\\1\\.status===\`duplicate\`\\|\\|\\1\\.status===\`inflight\`\\)return ${identifier}\\(\`skipped\`,\\{reason:\`duplicate\`\\}\\)`,
      ),
    );
  });
});
