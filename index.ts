import { defineChannelPluginEntry } from "openclaw/plugin-sdk/channel-core";
import type { OpenClawConfig } from "openclaw/plugin-sdk/channel-core";
import { cliqPlugin } from "./src/channel.js";
import { resolveCliqConfig } from "./src/client.js";
import {
  dispatchCliqInbound,
  parseCliqWebhookPayload,
  readJsonBody,
  resolveCliqMentionDecision,
  verifyWebhookSecret,
  type CliqRuntime,
} from "./src/inbound.js";

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

        const runtime = (api as unknown as { runtime: CliqRuntime }).runtime;
        dispatchCliqInbound({
          runtime,
          cfg,
          account,
          parsed,
          onError: (err, info) => {
            api.logger.error?.(`[cliq] ${info.kind} failed: ${String(err)}`);
          },
        }).catch((err) => {
          api.logger.error?.(`[cliq] inbound dispatch failed: ${String(err)}`);
        });

        res.statusCode = 200;
        res.setHeader("Content-Type", "application/json");
        res.end(JSON.stringify({ status: "received" }));
        return true;
      },
    });
  },
});
