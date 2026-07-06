// Stage-4b mock HTTP server for the openclaw-cliq gateway smoke.
//
// Stands in for THREE upstream services at once, all on one loopback port:
//
//   1. Zoho OAuth (accounts.zoho.eu):
//        POST /oauth/v2/token  -> { access_token, expires_in, scope }
//      (handles both client_credentials and refresh_token grants; ignores
//      the scope param — a single stub token is returned for every request.)
//
//   2. Zoho Cliq REST API (cliq.zoho.eu):
//        POST /api/v2/bots/{botId}/message
//          -> records { botId, to (userids), text } to the sends log file,
//             responds { message_details: { "<userId>": { chat_id, message_id } } }
//
//   3. An OpenAI-compatible stub chat model (api.openai.com/v1):
//        POST /v1/chat/completions
//          -> echoes the latest user message back as the assistant reply,
//             so the round-trip reply content is deterministic and
//             assertable from the smoke (the recorded bot send text will
//             contain the echo).
//
// Any other path returns 404 so a misconfigured base URL fails loudly.
//
// Usage: node scripts/stage4b-mock.mjs <port> <sendsLogFile>
//
// Headless: no real Zoho, no real model. Run as a background process from
// the Stage-4b smoke section of scripts/smoke-gateway.sh.
import { createServer } from "node:http";
import { writeFileSync, appendFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

const port = Number.parseInt(process.argv[2] ?? "", 10);
const sendsLogFile = process.argv[3];
if (!Number.isFinite(port) || !sendsLogFile) {
  console.error("usage: node scripts/stage4b-mock.mjs <port> <sendsLogFile>");
  process.exit(2);
}
mkdirSync(dirname(sendsLogFile), { recursive: true });
writeFileSync(sendsLogFile, ""); // reset on start

let messageCounter = 0;

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", `http://127.0.0.1:${port}`);
  const path = url.pathname;
  const chunks = [];
  for await (const c of req) chunks.push(c);
  const rawBody = Buffer.concat(chunks).toString("utf8");
  const log = (line) => console.log(`[mock] ${line}`);

  try {
    // --- Zoho OAuth token endpoint (accounts.zoho.eu) ---------------------
    if (req.method === "POST" && path === "/oauth/v2/token") {
      log(`oauth token grant (qs=${url.search})`);
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({
        access_token: "stub-access-token",
        token_type: "Bearer",
        expires_in: 3600,
        scope: "ZohoCliq.Webhooks.CREATE",
      }));
      return;
    }

    // --- Zoho Cliq bot-message send (cliq.zoho.eu) ------------------------
    // POST /api/v2/bots/{botId}/message  (bot DM)
    const botMatch = req.method === "POST" && /^\/api\/v2\/bots\/([^/]+)\/message$/.exec(path);
    if (botMatch) {
      const botId = decodeURIComponent(botMatch[1]);
      let payload = {};
      try { payload = JSON.parse(rawBody || "{}"); } catch { payload = {}; }
      const to = typeof payload.userids === "string" ? payload.userids : "";
      const text = typeof payload.text === "string" ? payload.text : "";
      messageCounter += 1;
      const messageId = `stub-msg-${messageCounter}`;
      const chatId = "CT_stub_dm";
      const record = { botId, to, text, messageId, chatId, ts: Date.now() };
      try {
        appendFileSync(sendsLogFile, JSON.stringify(record) + "\n");
      } catch (err) {
        log(`WARN: failed to append sends log: ${err}`);
      }
      log(`bot send botId=${botId} to=${to} textLen=${text.length} -> messageId=${messageId}`);
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({
        message_details: {
          [to || "_"]: { chat_id: chatId, message_id: messageId },
        },
      }));
      return;
    }

    // --- OpenAI-compatible stub chat model --------------------------------
    if (req.method === "POST" && path === "/v1/chat/completions") {
      let payload = {};
      try { payload = JSON.parse(rawBody || "{}"); } catch { payload = {}; }
      const messages = Array.isArray(payload.messages) ? payload.messages : [];
      // Echo the latest user message back as the assistant reply, prefixed
      // with a fixed marker so the smoke can assert the round-trip content
      // reached the mock send endpoint verbatim.
      const lastUser = [...messages].reverse().find((m) => m && m.role === "user");
      const userText = typeof lastUser?.content === "string"
        ? lastUser.content
        : Array.isArray(lastUser?.content)
          ? lastUser.content.map((c) => c?.text ?? "").join("")
          : "";
      const replyText = `stub-reply: ${userText}`;
      log(`chat completion echo (userTextLen=${userText.length}) -> "${replyText.slice(0, 80)}"`);
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({
        id: "chatcmpl-stub",
        object: "chat.completion",
        created: Math.floor(Date.now() / 1000),
        model: payload.model ?? "stub-model",
        choices: [
          {
            index: 0,
            message: { role: "assistant", content: replyText },
            finish_reason: "stop",
          },
        ],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      }));
      return;
    }

    log(`404 ${req.method} ${path}`);
    res.writeHead(404, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: `no mock route for ${req.method} ${path}` }));
  } catch (err) {
    log(`500 ${req.method} ${path}: ${err}`);
    res.writeHead(500, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: String(err) }));
  }
});

server.listen(port, "127.0.0.1", () => {
  console.log(`[mock] Stage-4b mock listening on 127.0.0.1:${port} (sends log: ${sendsLogFile})`);
});

for (const sig of ["SIGTERM", "SIGINT"]) {
  process.on(sig, () => {
    server.close(() => process.exit(0));
  });
}
