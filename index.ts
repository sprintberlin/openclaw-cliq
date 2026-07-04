import { defineChannelPluginEntry } from "openclaw/plugin-sdk/channel-core";
import { cliqPlugin } from "./src/channel.js";

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
      handler: async (_req, res) => {
        res.statusCode = 200;
        res.end("ok");
        return true;
      },
    });
  },
});
