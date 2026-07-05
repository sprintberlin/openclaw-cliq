import { defineChannelPluginEntry } from "openclaw/plugin-sdk/channel-core";
import type { OpenClawConfig } from "openclaw/plugin-sdk/channel-core";
import { cliqPlugin } from "./src/channel.js";
import { resolveCliqConfig } from "./src/client.js";
import { resolveCliqDmAdmission } from "./src/admission.js";
import { issueCliqPairingChallenge } from "./src/pairing.js";
import {
  dispatchCliqInbound,
  parseCliqWebhookPayload,
  readJsonBody,
  resolveCliqMentionDecision,
  verifyWebhookSecret,
  type CliqRuntime,
} from "./src/inbound.js";
import { claimCliqMessage, commitCliqMessage, releaseCliqMessage } from "./src/dedupe.js";

export default defineChannelPluginEntry({
  id: "cliq",
  name: "Zoho Cliq",
  description: "Zoho Cliq channel plugin for OpenClaw",
  plugin: cliqPlugin,
  registerCliMetadata(api) {
    api.registerCli(
      ({ program }) => {
        program.command("cliq").description("Zoho Cliq channel management");
      },
      {
        descriptors: [
          {
            name: "cliq",
            description: "Zoho Cliq channel management",
            hasSubcommands: false,
          },
        ],
      },
    );
  },
  registerFull(api) {
    api.registerHttpRoute({
      path: "/cliq/webhook",
      auth: "plugin",
      handler: async (req, res) => {
        if (req.method !== "POST") {
          res.statusCode = 405;
          res.setHeader("Allow", "POST");
          res.end("Method Not Allowed");
          return true;
        }

        const cfg: OpenClawConfig = api.config;
        let account;
        try {
          account = resolveCliqConfig(cfg, null);
        } catch (err) {
          api.logger.error?.(
            `[cliq] webhook received but channel is not configured: ${String(err)}`,
          );
          res.statusCode = 503;
          res.end("cliq not configured");
          return true;
        }

        if (!verifyWebhookSecret(req, account.webhookSecret)) {
          api.logger.warn?.("[cliq] webhook rejected: invalid secret");
          res.statusCode = 401;
          res.end("unauthorized");
          return true;
        }

        const body = await readJsonBody(req);
        if (!body.ok) {
          res.statusCode = body.error === "payload too large" ? 413 : 400;
          res.end(body.error ?? "invalid payload");
          return true;
        }

        const parsed = parseCliqWebhookPayload(body.value);
        if (!parsed) {
          res.statusCode = 400;
          res.end("invalid payload");
          return true;
        }

        if (parsed.senderId === account.botId || parsed.senderName === account.botName) {
          res.statusCode = 200;
          res.end("ok");
          return true;
        }

        const decision = resolveCliqMentionDecision(parsed, account, {
          requireMention: parsed.isGroup,
          allowTextCommands: false,
        });
        if (decision.shouldSkip) {
          res.statusCode = 200;
          res.end("ok");
          return true;
        }

        const admission = resolveCliqDmAdmission(parsed, account);
        const runtime = (api as unknown as { runtime: CliqRuntime }).runtime;
        if (admission.decision === "deny") {
          api.logger.warn?.(
            `[cliq] inbound from ${parsed.senderId} denied: ${admission.reason}`,
          );
          res.statusCode = 200;
          res.end("ok");
          return true;
        }
        if (admission.decision === "pairing") {
          // Issue a pairing challenge for unknown senders under the `pairing`
          // DM policy: upsert a pending pairing request and, when a new
          // request is created, reply with the approval code + instructions.
          issueCliqPairingChallenge({
            runtime,
            account,
            parsed,
            onReplyError: (err) => {
              api.logger.error?.(
                `[cliq] pairing reply to ${parsed.senderId} failed: ${String(err)}`,
              );
            },
          }).catch((err) => {
            api.logger.error?.(
              `[cliq] pairing challenge for ${parsed.senderId} failed: ${String(err)}`,
            );
          });
          res.statusCode = 200;
          res.end("ok");
          return true;
        }

        // Idempotency / de-dup: claim the message before dispatching so a
        // Cliq redelivery of an already-processed (or in-flight) `messageId`
        // is acknowledged without re-running the agent + side effects. On
        // successful dispatch we `commit` (record the tombstone); on a
        // retryable failure we `release` so the next redelivery can retry.
        const claim = await claimCliqMessage(parsed, account);
        if (claim && claim.kind !== "claimed") {
          api.logger.debug?.(
            `[cliq] inbound ${parsed.messageId} skipped as ${claim.kind}`,
          );
          res.statusCode = 200;
          res.end("ok");
          return true;
        }

        // Durable-before-ack: by default await the inbound pipeline before
        // acknowledging Cliq so a crash mid-dispatch triggers redelivery
        // instead of a lost message. `ackPolicy: "immediate"` opts out
        // (legacy fire-and-forget) for setups whose Cliq/Deluge timeout is
        // tighter than the agent round-trip.
        const dispatchPromise = dispatchCliqInbound({
          runtime,
          cfg,
          account,
          parsed,
          onError: (err, info) => {
            api.logger.error?.(`[cliq] ${info.kind} failed: ${String(err)}`);
          },
        }).then((result) => {
          // Commit the dedupe tombstone once dispatch resolves so a later
          // redelivery within the TTL is dropped instead of re-processed.
          void commitCliqMessage(claim?.key ?? null);
          return result;
        }, (err) => {
          // Retryable failure: release the claim so the next redelivery can
          // re-enter the pipeline (the tombstone is not recorded).
          releaseCliqMessage(claim?.key ?? null, err);
          throw err;
        });

        if (account.ackPolicy === "immediate") {
          dispatchPromise.catch((err) => {
            api.logger.error?.(
              `[cliq] inbound dispatch failed: ${String(err)}`,
            );
          });
          res.statusCode = 200;
          res.setHeader("Content-Type", "application/json");
          res.end(JSON.stringify({ status: "received" }));
          return true;
        }

        try {
          await dispatchPromise;
          res.statusCode = 200;
          res.setHeader("Content-Type", "application/json");
          res.end(JSON.stringify({ status: "received" }));
        } catch (err) {
          api.logger.error?.(
            `[cliq] inbound dispatch failed: ${String(err)}`,
          );
          res.statusCode = 500;
          res.end("dispatch failed");
        }
        return true;
      },
    });
  },
});
