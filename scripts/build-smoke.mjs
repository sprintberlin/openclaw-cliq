// Headless smoke test against the COMPILED dist/ output (no tsx required).
// Mirrors scripts/load-smoke.ts but imports from ../dist/index.js to prove the
// built artifact loads and the /cliq/webhook route responds — i.e. the exact
// payload a real gateway would install locally.
//
// Run: node scripts/build-smoke.js   (after `npm run build`)
import { EventEmitter } from "node:events";
import { createServer } from "node:http";
import cliqEntry from "../dist/index.js";

const routes = [];
const api = {
  registrationMode: "full",
  config: {
    channels: {
      cliq: {
        clientId: "id",
        clientSecret: "secret",
        botId: "openclaw-bot",
        botName: "openclaw-bot",
        webhookSecret: "s3cr3t",
      },
    },
  },
  logger: { warn() {}, error() {}, info() {}, debug() {} },
  runtime: {
    channel: {
      routing: { resolveAgentRoute: () => ({ agentId: "agent-1", sessionKey: "sess-1" }) },
      session: {
        resolveStorePath: () => "/store/agent-1",
        readSessionUpdatedAt: () => undefined,
        recordInboundSession: () => undefined,
      },
      reply: {
        resolveEnvelopeFormatOptions: () => ({}),
        formatAgentEnvelope: () => "envelope",
        finalizeInboundContext: () => ({}),
        dispatchReplyWithBufferedBlockDispatcher: async () => undefined,
      },
      inbound: { run: async () => undefined },
    },
  },
  registerChannel() {},
  registerCli() {},
  registerHttpRoute(params) {
    routes.push(params);
  },
};

cliqEntry.register(api);

const webhook = routes.find((r) => r.path === "/cliq/webhook");

const req = new EventEmitter();
req.method = "POST";
req.headers = { "x-cliq-webhook-secret": "s3cr3t" };
req.destroy = () => {};
const res = {
  headers: {},
  body: "",
  ended: false,
  statusCode: undefined,
  setHeader(name, value) { this.headers[name] = value; },
  end(chunk) { if (chunk !== undefined) this.body += chunk; this.ended = true; },
};

const payload = {
  message: { text: "@openclaw-bot hello", id: "m1", time: "2026-07-04T10:00:00Z" },
  user: { id: "user-123", name: "Alice", email: "alice@example.com" },
  chat: { id: "chat-1-B", type: "channel" },
  channel: { unique_name: "general" },
  mentions: [{ id: "openclaw-bot", type: "bot" }],
  handler: "mention",
};

const handlerPromise = webhook.handler(req, res);
queueMicrotask(() => {
  req.emit("data", Buffer.from(JSON.stringify(payload), "utf8"));
  req.emit("end");
});

const result = await handlerPromise;
await new Promise((r) => setTimeout(r, 50));

const report = {
  entryId: cliqEntry.id,
  entryName: cliqEntry.name,
  channelPluginId: cliqEntry.channelPlugin?.id,
  routesRegistered: routes.map((r) => ({ path: r.path, auth: r.auth })),
  webhookHandlerReturnedTrue: result === true,
  resStatusCode: res.statusCode,
  resHeaders: res.headers,
  resBody: res.body,
  resEnded: res.ended,
};
console.log("[in-process]", JSON.stringify(report));

const server = createServer((httpReq, httpRes) => {
  webhook.handler(httpReq, httpRes);
});
await new Promise((r) => server.listen(0, r));
const port = server.address().port;
const curlRes = await fetch(`http://127.0.0.1:${port}/cliq/webhook`, {
  method: "POST",
  headers: { "x-cliq-webhook-secret": "s3cr3t", "content-type": "application/json" },
  body: JSON.stringify(payload),
});
const curlBody = await curlRes.text();
console.log("[http-curl]", JSON.stringify({
  url: `/cliq/webhook`,
  method: "POST",
  status: curlRes.status,
  contentType: curlRes.headers.get("content-type"),
  body: curlBody,
}));
server.close();

if (cliqEntry.id !== "cliq" || curlRes.status !== 200 || curlBody !== '{"status":"received"}') {
  console.error("[build-smoke] FAILED acceptance checks");
  process.exit(1);
}
console.log("[build-smoke] OK");
process.exit(0);
