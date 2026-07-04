import { defineSetupPluginEntry } from "openclaw/plugin-sdk/channel-core";
import { cliqPlugin } from "./src/channel.js";

export default defineSetupPluginEntry(cliqPlugin);
