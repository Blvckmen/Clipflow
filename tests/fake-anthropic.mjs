// A local stand-in for the Claude Messages API, for end-to-end tests of post captions. It answers every
// request with a structured caption built from the request's text. GET /__log returns the requests it got;
// POST /__refuse?on=1 makes it decline (stop_reason "refusal") until turned off.
import { createServer } from "node:http";

export function startFakeAnthropic({ port = 0 } = {}) {
  const log = [];
  let refuse = false, seq = 0;
  const send = (res, status, body) => { res.writeHead(status, { "content-type": "application/json", "request-id": "req_fake_" + seq }); res.end(JSON.stringify(body)); };
  const server = createServer((req, res) => {
    let raw = "";
    req.on("data", c => raw += c);
    req.on("end", () => {
      const url = new URL(req.url, "http://fake");
      if (url.pathname === "/__log") return send(res, 200, log);
      if (url.pathname === "/__refuse") { refuse = url.searchParams.get("on") === "1"; return send(res, 200, { ok: true }); }
      if (url.pathname !== "/v1/messages" || req.method !== "POST") return send(res, 404, { type: "error", error: { type: "not_found_error", message: "unknown path " + url.pathname } });
      // The SDK sends the key as x-api-key or as an Authorization bearer token, depending on its version.
      const key = req.headers["x-api-key"] ?? String(req.headers.authorization ?? "").replace(/^Bearer /, "");
      if (key !== "test-anthropic-key") return send(res, 401, { type: "error", error: { type: "authentication_error", message: "invalid API key" } });
      const body = JSON.parse(raw), text = body.messages.map(m => typeof m.content === "string" ? m.content : m.content.map(c => c.text ?? "").join(" ")).join("\n");
      log.push({ model: body.model, beta: req.headers["anthropic-beta"] ?? null, effort: body.output_config?.effort ?? null, format: body.output_config?.format?.type ?? null, fallbacks: body.fallbacks ?? null, system: body.system, text });
      seq++;
      const base = { id: "msg_fake_" + seq, type: "message", role: "assistant", model: body.model, stop_sequence: null, usage: { input_tokens: 200, output_tokens: 60 } };
      if (refuse) return send(res, 200, { ...base, content: [], stop_reason: "refusal", stop_details: { type: "refusal", category: null, explanation: "declined by test" } });
      const streamer = /Streamer: (.*)/.exec(text)?.[1] ?? "someone";
      const spoken = /<transcript>(.*?)<\/transcript>/.exec(text)?.[1] ?? "";
      const caption = { title: streamer + " did NOT see that coming", body: spoken ? "\"" + spoken.split(" ").slice(0, 6).join(" ") + "…\"" : "Pure chaos on stream.", hashtags: ["#" + streamer, "clips", "#fyp"] };
      send(res, 200, { ...base, content: [{ type: "text", text: JSON.stringify(caption) }], stop_reason: "end_turn" });
    });
  });
  return new Promise(resolve => server.listen(port, "127.0.0.1", () => resolve({ server, port: server.address().port, log })));
}
