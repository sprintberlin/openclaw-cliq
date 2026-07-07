import { defineChannelPluginEntry } from "openclaw/plugin-sdk/channel-core";
import type { OpenClawConfig } from "openclaw/plugin-sdk/channel-core";
import { cliqPlugin } from "./src/channel.js";
import { resolveCliqConfig } from "./src/client.js";
import { getCliqClientRegistry } from "./src/runtime-api.js";
import { resolveCliqDmAdmission } from "./src/admission.js";
import {
  handleCliqPairingApprovalAction,
  issueCliqPairingChallenge,
} from "./src/pairing.js";
import {
  dispatchCliqInbound,
  isCliqSessionConflictError,
  parseCliqWebhookPayload,
  readJsonBody,
  resolveCliqMentionDecision,
  type CliqRuntime,
} from "./src/inbound.js";
import {
  createFailedAuthRateLimiter,
  rejectUnauthedWebhook,
  verifyWebhookSecret,
  type FailedAuthRateLimiter,
} from "./src/webhook-security.js";
import { claimCliqMessage, commitCliqMessage, releaseCliqMessage } from "./src/dedupe.js";
import { isCliqSelfMessage } from "./src/self-message.js";
import { cliqSecurityAuditCollector } from "./src/security-audit.js";
import {
  isCliqWelcomePayload,
  parseCliqWelcomePayload,
  handleCliqWelcome,
  buildCliqWelcomeInbound,
} from "./src/welcome.js";
import { resolveCliqClient } from "./src/runtime-api.js";

/**
 * Per-IP fixed-window limiter for *failed* webhook authentications. Legit
 * Cliq delivery (which passes the secret check) never touches this — only
 * the 401 path records a hit — so this cannot throttle real traffic. Reset
 * only happens on process restart; the window is short (60s) so the bucket
 * memory is bounded by distinct attacker IPs within one window.
 */
let failAuthLimiter: FailedAuthRateLimiter | null = null;
function getFailAuthLimiter(): FailedAuthRateLimiter {
  if (!failAuthLimiter) failAuthLimiter = createFailedAuthRateLimiter();
  return failAuthLimiter;
}

export default defineChannelPluginEntry({
  id: "cliq",
  name: "Zoho Cliq",
  description:
    "Native Zoho Cliq channel for OpenClaw — reply to DMs and channel @mentions as a bot, with streaming previews, cards, and message actions.",
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
    // Route outbound Cliq send logs (OAuth token fetch, bot-message POST,
    // HTTP status, errors) to the gateway logger so the outbound hop is
    // diagnosable. The registry threads this into every CliqClient it
    // creates; the outbound sendText / inbound deliver paths resolve their
    // client through the registry, so all sends flow through this sink.
    getCliqClientRegistry().setLogger(api.logger);
    // Contribute Cliq-specific findings to `openclaw security audit`:
    // missing webhook secret (critical), wildcard allowFrom (critical), open
    // DM policy (warn), and plaintext secret storage (warn). The collector
    // is pure (config reads only) and never throws.
    api.registerSecurityAuditCollector(cliqSecurityAuditCollector);
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
          rejectUnauthedWebhook({
            req,
            res,
            limiter: getFailAuthLimiter(),
            logger: api.logger,
          });
          return true;
        }

        const body = await readJsonBody(req);
        if (!body.ok) {
          res.statusCode = body.error === "payload too large" ? 413 : 400;
          res.end(body.error ?? "invalid payload");
          return true;
        }

        // Welcome-on-subscribe (issue #52): the Cliq Welcome Handler forwards a
        // subscribe event with `handler: "welcome"` (or `"subscribe"`) and no
        // message body. The regular parser rejects no-text payloads, so we
        // detect + route the welcome event BEFORE the message path. When
        // `welcome.enabled` is set, the bot posts a configurable greeting DM
        // to the subscriber (honoring `dmPolicy` / `allowFrom`); the event is
        // always acknowledged so Cliq does not redeliver it. A redelivery of
        // the same subscribe event is deduped by the synthetic
        // `welcome:<userId>` message id so the user is not greeted twice.
        if (isCliqWelcomePayload(body.value)) {
          const welcome = parseCliqWelcomePayload(body.value);
          if (!welcome) {
            res.statusCode = 400;
            res.end("invalid welcome payload");
            return true;
          }
          const claim = await claimCliqMessage(
            buildCliqWelcomeInbound(welcome),
            account,
          );
          if (claim && claim.kind !== "claimed") {
            api.logger.debug?.(
              `[cliq] welcome for ${welcome.senderId} skipped as ${claim.kind}`,
            );
            res.statusCode = 200;
            res.end("ok");
            return true;
          }
          try {
            await handleCliqWelcome({
              account,
              welcome,
              client: resolveCliqClient(account),
              onError: (err, info) => {
                api.logger.error?.(
                  `[cliq] ${info.kind} failed: ${String(err)}`,
                );
              },
            });
            void commitCliqMessage(claim?.key ?? null);
          } catch (err) {
            releaseCliqMessage(claim?.key ?? null, err);
            api.logger.error?.(
              `[cliq] welcome greeting to ${welcome.senderId} failed: ${String(err)}`,
            );
          }
          res.statusCode = 200;
          res.end("ok");
          return true;
        }

        const parsed = parseCliqWebhookPayload(body.value);
        if (!parsed) {
          res.statusCode = 400;
          res.end("invalid payload");
          return true;
        }

        // Self-message / bot-loop protection: the bot must never answer its
        // own messages (or those of another Cliq bot the operator marked as
        // ignorable via `selfSenderIds`). Match case-insensitively across
        // senderId, senderName, and senderEmail against {botId, botName,
        // selfSenderIds}. The configured `botId`/`botName` always count as
        // self; `selfSenderIds` adds the bot's alternate identity (e.g. its
        // Zoho user id when the webhook delivers a zuid) and any other bots
        // that must not trigger this agent.
        const selfMatch = isCliqSelfMessage(parsed, account);
        if (selfMatch.self) {
          api.logger.debug?.(
            `[cliq] inbound ${parsed.messageId} dropped as self-message (matched ${selfMatch.matchedField}="${selfMatch.matchedValue}")`,
          );
          res.statusCode = 200;
          res.end("ok");
          return true;
        }

        // Form-driven pairing approval (Phase 3, sub-part b): an approval-
        // card button click arrives as an inbound message carrying a
        // pairing sentinel (`__cliq_pairing_approve__ <code>` /
        // `__cliq_pairing_deny__ <code>`). Short-circuit the dispatch path
        // BEFORE the mention / admission gates — the owner clicking the
        // card may not themselves be on the allowlist, and this is a
        // control message, not an agent turn. Approve admits the sender
        // via the SDK pairing store + notifies them; deny replies to the
        // owner. The owner target comes from `pairing.notifyOwnerTarget`
        // (the card originator); when unset the sentinel is ignored
        // (treated as ordinary text and dispatched normally, so a stray
        // sentinel is harmless).
        if (parsed.pairingAction) {
          const ownerTarget = account.pairing?.notifyOwnerTarget ?? null;
          if (ownerTarget) {
            try {
              await handleCliqPairingApprovalAction({
                account,
                action: parsed.pairingAction,
                ownerTarget,
                onError: (err, info) => {
                  api.logger.error?.(
                    `[cliq] ${info.kind} failed: ${String(err)}`,
                  );
                },
              });
            } catch (err) {
              api.logger.error?.(
                `[cliq] pairing ${parsed.pairingAction.kind} failed: ${String(err)}`,
              );
            }
            res.statusCode = 200;
            res.end("ok");
            return true;
          }
          // No owner target configured — fall through to normal dispatch
          // (the sentinel text will reach the agent as ordinary input,
          // which is benign — a user manually crafting the sentinel
          // merely sends that text to the agent).
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
            onOwnerCardError: (err) => {
              api.logger.error?.(
                `[cliq] pairing approval card to owner failed: ${String(err)}`,
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
          // A "reply session initialization conflicted" error is transient
          // (a Cliq redelivery racing the first dispatch's session init).
          // Ack 200 so Cliq stops retrying instead of 5xx → retry → same
          // conflict storm. The dedupe layer already serialized the
          // redeliveries; a genuine concurrent-turn conflict is rare and
          // best left to the SDK's own queue (issue #84).
          if (isCliqSessionConflictError(err)) {
            api.logger.warn?.(
              `[cliq] inbound dispatch conflicted (session init) — acking to stop retry: ${String(err)}`,
            );
            res.statusCode = 200;
            res.end("ok");
            return true;
          }
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
