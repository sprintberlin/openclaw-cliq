/** OpenClaw ships channel-activity-runtime without a .d.ts (2026.8.2 - 2026.10.2). */
declare module "openclaw/plugin-sdk/channel-activity-runtime" {
  export function recordChannelActivity(params: {
    channel: string;
    accountId?: string;
    direction: "inbound" | "outbound";
    at?: number;
  }): void;
}
