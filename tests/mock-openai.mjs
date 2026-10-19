// Tiny OpenAI-compatible mock. No real keys, no outbound network.
// CLI: node tests/mock-openai.mjs [port]
// Replies (last user message, first match wins):
//   instruction contains "slow"     → SSE for ~5s ("Slow…" then " done."), connection stays open
//   model name "missing"            → 404 JSON
//   instruction contains "polish"   → "Polished: <first 3 words of selection>…"
//   instruction contains "translate"→ "Bonjour le monde."
//   "/ai" generate (instruction is not one of the canned action verbs,
//     and the document is "(empty)" or the user asked to generate) →
//     "## Generated\n\n- item one\n- item two"
//   otherwise chat                  → "Chat reply." plus " (about <title>)" when a
//                                     document title line (`# …`) was included
import http from "node:http";

export const FAKE_KEY = "test-key-123";
// 1421 is the default because some sandboxes reject 4190 as a "bad port".
const DEFAULT_PORT = Number(process.env.MOCK_OPENAI_PORT) || 1421;

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

function sendJson(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, { "content-type": "application/json; charset=utf-8", "content-length": Buffer.byteLength(body) });
  res.end(body);
}

function lastUser(messages) {
  if (!Array.isArray(messages)) return "";
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i]?.role === "user") return String(messages[i].content ?? "");
  }
  return "";
}

/** Instruction is the text before the first <document> fence. */
function instructionOf(user) {
  const i = user.indexOf("<document>");
  return (i >= 0 ? user.slice(0, i) : user).trim();
}

/** Body inside the first <document>…</document> pair, if any. */
function documentOf(user) {
  const m = /<document>\n?([\s\S]*?)\n?<\/document>/.exec(user);
  return m ? m[1] : "";
}

function firstWords(text, n) {
  const words = text.trim().split(/\s+/).filter(Boolean);
  return words.slice(0, n).join(" ");
}

/**
 * Deterministic reply. `kind` is "polish" | "translate" | "generate" | "chat" | "slow".
 * Returns the full assistant text (split into SSE pieces by the caller).
 */
export function replyFor(user, model) {
  const src = /<sources>\n([\s\S]*?)\n<\/sources>/.exec(user);
  if (src) {
    // RAG: cite the first two sources by number, name the first one
    const labels = [...src[1].matchAll(/^\[(\d+)\] (.+?) \(lines/gm)].map((m) => m[2]);
    return { kind: "rag", text: `According to ${labels[0] ?? "your notes"} [1]` + (labels.length > 1 ? `, see also [2].` : ".") };
  }
  const instruction = instructionOf(user);
  const doc = documentOf(user);
  const lower = instruction.toLowerCase();
  if (/\bslow\b/.test(lower) || /\bslow\b/.test(user.toLowerCase())) {
    return { kind: "slow", text: "Slow… done." };
  }
  if (String(model) === "missing") return { kind: "missing", text: "" };
  // Screenshot/test hook: "REPLY: <text>" in the instruction returns <text> ("\\n" = newline).
  const rm = instruction.match(/REPLY:\s*([\s\S]*)$/);
  if (rm) return { kind: "reply", text: rm[1].trim().replace(/\\n/g, "\n") };
  // Match the instruction, not the document. A selection may itself contain "polish".
  if (/\bpolish\b/i.test(instruction) || instruction.toLowerCase().startsWith("polish ")) {
    const words = firstWords(doc, 3);
    return { kind: "polish", text: `Polished: ${words}…` };
  }
  if (lower.includes("translate")) return { kind: "translate", text: "Bonjour le monde." };
  // /ai generate: the instruction is the user's free text, and the document is the
  // nearby context (often "(empty)" on a blank paragraph). Action verbs are excluded
  // so polish/translate/chat keep their own replies.
  const looksGenerate = doc.trim() === "(empty)" || /\bgenerate\b/i.test(instruction);
  if (looksGenerate && !/polish|translate|summarize|continue/i.test(lower)) {
    return { kind: "generate", text: "## Generated\n\n- item one\n- item two" };
  }
  let text = "Chat reply.";
  const title = /^#\s+(.+)$/m.exec(doc);
  if (title) text += ` (about ${title[1].trim()})`;
  return { kind: "chat", text };
}

function chunk(delta) {
  return "data: " + JSON.stringify({ choices: [{ delta }] }) + "\n\n";
}

function piecesOf(text) {
  if (text.includes("\n\n")) {
    const i = text.indexOf("\n\n");
    return [text.slice(0, i + 2), text.slice(i + 2)];
  }
  const mid = Math.max(1, Math.ceil(text.length / 2));
  return [text.slice(0, mid), text.slice(mid)].filter((p) => p.length);
}

function sleep(ms, signal) {
  return new Promise((resolve) => {
    const t = setTimeout(resolve, ms);
    const onClose = () => { clearTimeout(t); resolve(); };
    signal?.addEventListener?.("close", onClose, { once: true });
    signal?.addEventListener?.("aborted", onClose, { once: true });
  });
}

const SYN = [["feline", "cat", "cats", "kitten", "purr"], ["canine", "dog", "dogs", "puppy", "bark"], ["money", "budget", "cost", "price", "expense"], ["sleep", "nap", "rest", "bed"]];
export function toyEmbed(text) {
  const v = new Array(64).fill(0);
  for (let w of String(text).toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []) {
    const g = SYN.findIndex((xs) => xs.includes(w));
    if (g >= 0) w = "syn" + g;
    else if (w.length > 4) w = w.slice(0, 5);
    let h = 2166136261;
    for (const c of w) h = Math.imul(h ^ c.codePointAt(0), 16777619) >>> 0;
    v[h % 64] += 1;
  }
  const n = Math.hypot(...v) || 1;
  return v.map((x) => x / n);
}

export function start(port = DEFAULT_PORT) {
  const requests = [];
  const sockets = new Set();
  let slowClosed = 0;

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url || "/", "http://127.0.0.1");
    if (req.method === "GET" && url.pathname === "/__requests") {
      sendJson(res, 200, { requests, slowClosed });
      return;
    }
    if (req.method === "DELETE" && url.pathname === "/__requests") {
      requests.length = 0;
      slowClosed = 0;
      sendJson(res, 200, { ok: true });
      return;
    }
    if (req.method === "GET" && url.pathname === "/health") {
      sendJson(res, 200, { ok: true });
      return;
    }
    if (req.method === "POST" && url.pathname === "/v1/embeddings") {
      // Deterministic toy embeddings: hashed bag of word stems in 64 dims (+ a few synonym groups),
      // L2-normalized. No auth required (local Ollama style); records requests like chat.
      let raw = ""; try { raw = await readBody(req); } catch { /* empty */ }
      let body = {}; try { body = JSON.parse(raw || "{}"); } catch { /* bad */ }
      const input = Array.isArray(body.input) ? body.input : [String(body.input ?? "")];
      requests.push({ method: "POST", path: url.pathname, model: body.model ?? null, count: input.length, authPresent: !!req.headers.authorization, user: input.join("\n---\n").slice(0, 2000), at: Date.now() });
      if (body.model === "missing") { sendJson(res, 404, { error: { message: "model missing", type: "not_found" } }); return; }
      sendJson(res, 200, { object: "list", model: body.model, data: input.map((t, index) => ({ object: "embedding", index, embedding: toyEmbed(t) })), usage: { prompt_tokens: input.reduce((n, t) => n + Math.ceil(t.length / 4), 0), total_tokens: 0 } });
      return;
    }
    if (req.method !== "POST" || url.pathname !== "/v1/chat/completions") {
      sendJson(res, 404, { error: { message: "not found", type: "not_found" } });
      return;
    }
    const auth = req.headers.authorization || "";
    const authPresent = auth.length > 0;
    const okAuth = auth === "Bearer " + FAKE_KEY;
    let raw = "";
    try { raw = await readBody(req); } catch { raw = ""; }
    let body = {};
    try { body = raw ? JSON.parse(raw) : {}; } catch { body = { _parseError: true }; }
    const user = lastUser(body.messages);
    const record = {
      method: req.method,
      path: url.pathname,
      authPresent,
      authorized: okAuth,
      model: body.model ?? null,
      stream: body.stream === true,
      user,
      at: Date.now(),
      closedEarly: false,
    };
    requests.push(record);
    if (!okAuth) {
      sendJson(res, 401, { error: { message: "invalid api key", type: "invalid_request_error" } });
      return;
    }
    if (body.model === "missing") {
      sendJson(res, 404, { error: { message: "model missing", type: "not_found" } });
      return;
    }
    const reply = replyFor(user, body.model);
    if (!body.stream) {
      sendJson(res, 200, { choices: [{ message: { role: "assistant", content: reply.text } }] });
      return;
    }
    res.writeHead(200, {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache",
      connection: "keep-alive",
    });
    let closed = false;
    const markClosed = () => {
      if (closed) return;
      closed = true;
      record.closedEarly = true;
      if (reply.kind === "slow") slowClosed += 1;
    };
    req.on("aborted", markClosed);
    // The request body is already consumed, so req "close" may have fired. A client cancel
    // during the response shows up on the response (socket destroyed, writableEnded still false).
    res.on("close", () => { if (!res.writableEnded) markClosed(); });
    res.on("error", markClosed);
    const write = (s) => { if (!closed && !res.writableEnded) res.write(s); };
    write(chunk({ role: "assistant" }));
    if (reply.kind === "slow") {
      write(chunk({ content: "Slow" }));
      // Stay open ~5s so a client can cancel mid-stream. 30 ms ticks keep the socket alive.
      for (let i = 0; i < 166 && !closed; i++) await sleep(30, req);
      if (!closed) {
        write(chunk({ content: "… done." }));
        write("data: [DONE]\n\n");
        closed = true;
        res.end();
      }
      return;
    }
    for (const piece of piecesOf(reply.text)) {
      if (closed) return;
      await sleep(30, req);
      write(chunk({ content: piece }));
    }
    if (!closed) {
      if (body.stream_options?.include_usage) {
        // OpenAI style: a final chunk with empty choices and the usage object.
        const promptChars = (body.messages ?? []).reduce((n, m) => n + String(m.content ?? "").length, 0);
        write(`data: ${JSON.stringify({ choices: [], usage: { prompt_tokens: Math.ceil(promptChars / 4), completion_tokens: piecesOf(reply.text).length, total_tokens: 0 } })}\n\n`);
      }
      write("data: [DONE]\n\n");
      closed = true;
      res.end();
    }
  });

  server.on("connection", (sock) => {
    sockets.add(sock);
    sock.on("close", () => sockets.delete(sock));
  });

  const ready = new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => resolve(server.address()));
  });

  return {
    server,
    port,
    url: `http://127.0.0.1:${port}/v1`,
    requests: () => requests.slice(),
    slowClosed: () => slowClosed,
    reset() { requests.length = 0; slowClosed = 0; },
    async ready() { await ready; return this; },
    close() {
      for (const s of sockets) s.destroy();
      return new Promise((resolve) => server.close(() => resolve()));
    },
  };
}

const isMain = process.argv[1] && import.meta.url.endsWith(process.argv[1].replace(/\\/g, "/").split("/").pop())
  || process.argv[1]?.endsWith("mock-openai.mjs");
if (isMain) {
  const port = Number(process.argv[2]) || DEFAULT_PORT;
  const mock = start(port);
  await mock.ready();
  console.log("mock-openai listening on http://127.0.0.1:" + port);
}
