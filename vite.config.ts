import { defineConfig, Plugin } from "vite";
import fs from "node:fs";
import http from "node:http";
import https from "node:https";
import path from "node:path";

// Dev/preview-only file API so the frontend runs in a plain browser (used for Playwright tests).
// Sandboxed to dev-data/workspace; themes served from dev-data/themes (falls back to ./themes).
const ROOT = path.resolve(__dirname, "dev-data/workspace");
const THEMES = fs.existsSync(path.resolve(__dirname, "dev-data/themes")) ? path.resolve(__dirname, "dev-data/themes") : path.resolve(__dirname, "themes");
const MIME: Record<string, string> = { ".css": "text/css", ".woff2": "font/woff2", ".woff": "font/woff", ".ttf": "font/ttf", ".otf": "font/otf",
  ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif", ".svg": "image/svg+xml", ".webp": "image/webp", ".md": "text/markdown; charset=utf-8" };
const inside = (base: string, p: string) => { const r = path.resolve(p); return r === base || r.startsWith(base + path.sep) ? r : null; };

// Dev/preview stand-in for the Rust secrets + streaming HTTP commands.
// Secrets live in an in-memory map mirrored to gitignored dev-data/secrets.json (mode 0600).
// Values are never returned. /api/net/stream proxies upstream and injects the secret server-side.
const SECRETS_FILE = path.resolve(__dirname, "dev-data/secrets.json");
const SECRET_ID = /^[a-z0-9._-]{1,64}$/;
const secretMap = new Map<string, string>();
let secretsLoaded = false;

function loadSecrets() {
  if (secretsLoaded) return;
  secretsLoaded = true;
  try {
    if (fs.existsSync(SECRETS_FILE)) {
      const parsed = JSON.parse(fs.readFileSync(SECRETS_FILE, "utf8"));
      const bag = parsed && typeof parsed === "object" ? (parsed.secrets ?? parsed) : {};
      for (const [k, v] of Object.entries(bag)) if (typeof v === "string" && SECRET_ID.test(k)) secretMap.set(k, v);
    }
  } catch { /* ignore a corrupt dev store */ }
}
function saveSecrets() {
  fs.mkdirSync(path.dirname(SECRETS_FILE), { recursive: true });
  const body = JSON.stringify({ secrets: Object.fromEntries(secretMap) }, null, 2) + "\n";
  const tmp = SECRETS_FILE + ".tmp";
  fs.writeFileSync(tmp, body, { mode: 0o600 });
  try { fs.chmodSync(tmp, 0o600); } catch { /* windows */ }
  fs.renameSync(tmp, SECRETS_FILE);
  try { fs.chmodSync(SECRETS_FILE, 0o600); } catch { /* windows */ }
}
function scrub(text: string, secret?: string) {
  if (!secret) return text;
  let out = text.split(secret).join("[redacted]");
  if (!secret.toLowerCase().startsWith("bearer ")) out = out.split("Bearer " + secret).join("[redacted]");
  return out;
}
function readBody(req: any): Promise<string> {
  return new Promise((resolve, reject) => {
    let body = "";
    req.on("data", (c: any) => { body += c; if (body.length > 8_000_000) { reject(new Error("body too large")); req.destroy(); } });
    req.on("end", () => resolve(body));
    req.on("error", reject);
  });
}

const netCancels = new Map<string, AbortController>();

function authHeader(secret: string, auth?: string): { name: string; value: string } {
  if (!auth || auth === "bearer") {
    const value = secret.toLowerCase().startsWith("bearer ") ? secret : "Bearer " + secret;
    return { name: "authorization", value };
  }
  if (auth.startsWith("header:")) {
    const name = auth.slice("header:".length).trim();
    if (!name || /[\s:]/.test(name)) throw new Error("invalid auth header name");
    return { name, value: secret };
  }
  throw new Error('auth must be "bearer" or "header:<name>"');
}

/** Proxy one stream. Writes newline-delimited JSON StreamEvents. Resolves when the client finishes or cancels. */
function proxyStream(id: string, reqBody: any, res: any): void {
  const req = reqBody?.req ?? reqBody;
  const urlRaw = String(req?.url ?? "");
  let target: URL;
  try { target = new URL(urlRaw); } catch { res.statusCode = 400; res.end(JSON.stringify({ type: "error", message: "invalid url" }) + "\n" + JSON.stringify({ type: "done" }) + "\n"); return; }
  if (target.protocol !== "http:" && target.protocol !== "https:") {
    res.statusCode = 400; res.end(JSON.stringify({ type: "error", message: "only http and https urls are allowed" }) + "\n" + JSON.stringify({ type: "done" }) + "\n"); return;
  }
  const method = String(req.method ?? "POST").toUpperCase();
  if (method !== "GET" && method !== "POST") {
    res.statusCode = 400; res.end(JSON.stringify({ type: "error", message: "unsupported method" }) + "\n" + JSON.stringify({ type: "done" }) + "\n"); return;
  }
  loadSecrets();
  let secret: string | undefined;
  const headers: Record<string, string> = {};
  for (const [k, v] of Object.entries(req.headers ?? {})) {
    if (typeof v !== "string") continue;
    if (/^authorization$/i.test(k) || /^proxy-authorization$/i.test(k)) continue;
    headers[k] = v;
  }
  if (req.secretRef) {
    if (!SECRET_ID.test(String(req.secretRef))) {
      res.statusCode = 400; res.end(JSON.stringify({ type: "error", message: "invalid secret id" }) + "\n" + JSON.stringify({ type: "done" }) + "\n"); return;
    }
    secret = secretMap.get(String(req.secretRef));
    if (secret == null) {
      res.statusCode = 400; res.end(JSON.stringify({ type: "error", message: "unknown secret ref" }) + "\n" + JSON.stringify({ type: "done" }) + "\n"); return;
    }
    try {
      const h = authHeader(secret, req.auth);
      headers[h.name] = h.value;
    } catch (e: any) {
      res.statusCode = 400; res.end(JSON.stringify({ type: "error", message: String(e?.message ?? e) }) + "\n" + JSON.stringify({ type: "done" }) + "\n"); return;
    }
  }
  const ac = new AbortController();
  netCancels.set(id, ac);
  const timeoutMs = Math.min(600_000, Math.max(1_000, Number(req.timeoutMs) || 120_000));
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  const lib = target.protocol === "https:" ? https : http;
  const write = (obj: any) => { if (!res.writableEnded) res.write(JSON.stringify(obj) + "\n"); };
  let finished = false;
  const finish = () => {
    if (finished) return;
    finished = true;
    clearTimeout(timer);
    netCancels.delete(id);
    if (!res.writableEnded) { write({ type: "done" }); res.end(); }
  };
  let attempt = 0;
  let opened = false;
  const go = () => {
    if (ac.signal.aborted || finished) { finish(); return; }
    const upstream = lib.request(target, { method, headers, timeout: timeoutMs }, (up) => {
      const status = up.statusCode ?? 0;
      const retryable = status === 429 || status >= 500;
      // Same rule as Rust: retry 429/5xx at most twice, and only before the first byte is forwarded.
      if (retryable && attempt < 2 && !opened) {
        attempt += 1;
        up.resume();
        setTimeout(go, 250 * 2 ** (attempt - 1));
        return;
      }
      opened = true;
      write({ type: "open", status });
      const ctype = String(up.headers["content-type"] ?? "");
      const isSse = ctype.split(";")[0].trim().toLowerCase() === "text/event-stream";
      if (status < 200 || status >= 300) {
        const chunks: Buffer[] = [];
        let size = 0;
        up.on("data", (c: Buffer) => { if (size < 2048) { chunks.push(c); size += c.length; } });
        up.on("end", () => {
          let message = Buffer.concat(chunks).subarray(0, 2048).toString("utf8");
          if (!message) message = "HTTP " + status;
          write({ type: "error", status, message: scrub(message, secret) });
          finish();
        });
        return;
      }
      if (!isSse) {
        const chunks: Buffer[] = [];
        up.on("data", (c: Buffer) => chunks.push(c));
        up.on("end", () => {
          write({ type: "data", data: scrub(Buffer.concat(chunks).toString("utf8"), secret) });
          finish();
        });
        return;
      }
      // SSE: re-parse so a chunk-split line still becomes one data event, and [DONE] ends the stream.
      let buf = "";
      let dataLines: string[] = [];
      let eventName: string | undefined;
      let have = false;
      const dispatch = () => {
        if (!have) { dataLines = []; eventName = undefined; return; }
        const data = dataLines.join("\n");
        dataLines = []; have = false;
        const ev = eventName; eventName = undefined;
        if (data === "[DONE]") return "done" as const;
        write({ type: "data", ...(ev ? { event: ev } : {}), data: scrub(data, secret) });
        return "event" as const;
      };
      const feedLine = (line: string) => {
        if (line.endsWith("\r")) line = line.slice(0, -1);
        if (line === "") return dispatch();
        if (line.startsWith(":")) return;
        const colon = line.indexOf(":");
        const field = colon < 0 ? line : line.slice(0, colon);
        let value = colon < 0 ? "" : line.slice(colon + 1);
        if (value.startsWith(" ")) value = value.slice(1);
        if (field === "data") { have = true; dataLines.push(value); }
        else if (field === "event" && value) { have = true; eventName = value; }
      };
      up.setEncoding("utf8");
      up.on("data", (chunk: string) => {
        buf += chunk;
        let nl: number;
        while ((nl = buf.indexOf("\n")) >= 0) {
          const line = buf.slice(0, nl);
          buf = buf.slice(nl + 1);
          if (feedLine(line) === "done") { up.destroy(); finish(); return; }
        }
      });
      up.on("end", () => {
        if (buf) feedLine(buf);
        else dispatch();
        finish();
      });
      up.on("error", (e) => { write({ type: "error", message: scrub(String(e?.message ?? e), secret) }); finish(); });
    });
    upstream.on("error", (e: any) => {
      if (ac.signal.aborted || finished) { finish(); return; }
      // Connection failures before any forwarded byte share the retry budget.
      if (!opened && attempt < 2) { attempt += 1; setTimeout(go, 250 * 2 ** (attempt - 1)); return; }
      write({ type: "error", message: scrub(String(e?.message ?? e), secret) });
      finish();
    });
    ac.signal.addEventListener("abort", () => { upstream.destroy(); finish(); }, { once: true });
    if (method !== "GET" && req.body != null) upstream.write(String(req.body));
    upstream.end();
  };
  res.statusCode = 200;
  res.setHeader("content-type", "application/x-ndjson; charset=utf-8");
  res.setHeader("cache-control", "no-store");
  go();
}

function devFs(): Plugin {
  const handler = (req: any, res: any, next: any) => {
    const url = new URL(req.url, "http://x");
    const send = (code: number, body: any, type = "application/json") => { res.statusCode = code; res.setHeader("content-type", type); res.end(type === "application/json" ? JSON.stringify(body) : body); };
    const serveFile = (file: string | null) => {
      if (!file || !fs.existsSync(file) || !fs.statSync(file).isFile()) return send(404, "not found", "text/plain");
      res.setHeader("content-type", MIME[path.extname(file).toLowerCase()] ?? "application/octet-stream");
      fs.createReadStream(file).pipe(res);
    };
    try {
      if (url.pathname === "/api/workspace") return send(200, { path: ROOT });
      if (url.pathname === "/api/read") { const p = inside(ROOT, url.searchParams.get("path") ?? ""); if (!p) return send(403, "outside sandbox", "text/plain"); return send(200, { text: fs.readFileSync(p, "utf8") }); }
      if (url.pathname === "/api/list") {
        const p = inside(ROOT, url.searchParams.get("path") ?? ""); if (!p) return send(403, "outside sandbox", "text/plain");
        const entries = fs.readdirSync(p, { withFileTypes: true }).filter((d) => !d.name.startsWith(".") && d.name !== "node_modules")
          .map((d) => ({ name: d.name, path: path.join(p, d.name), isDir: d.isDirectory() }))
          .sort((a, b) => (a.isDir === b.isDir ? a.name.localeCompare(b.name) : a.isDir ? -1 : 1));
        return send(200, { entries });
      }
      if (url.pathname === "/api/write" && req.method === "POST") {
        let body = ""; req.on("data", (c: any) => (body += c)); req.on("end", () => {
          const { path: fp, text } = JSON.parse(body); const p = inside(ROOT, fp); if (!p) return send(403, "outside sandbox", "text/plain");
          const tmp = p + ".tmp-mdnest"; fs.writeFileSync(tmp, text); fs.renameSync(tmp, p); send(200, { ok: true });
        }); return;
      }
      if (url.pathname === "/api/mtime") { const p = inside(ROOT, url.searchParams.get("path") ?? ""); return send(200, { mtime: p && fs.existsSync(p) ? fs.statSync(p).mtimeMs : null }); }
      if (url.pathname === "/api/writeb" && req.method === "POST") {
        let body = ""; req.on("data", (c: any) => (body += c)); req.on("end", () => {
          const { path: fp, data, unique } = JSON.parse(body); let p = inside(ROOT, fp); if (!p) return send(403, "outside sandbox", "text/plain");
          fs.mkdirSync(path.dirname(p), { recursive: true });
          if (unique && fs.existsSync(p)) { const ext = path.extname(p), stem = p.slice(0, p.length - ext.length); let i = 1; while (fs.existsSync(`${stem}-${i}${ext}`)) i++; p = `${stem}-${i}${ext}`; }
          fs.writeFileSync(p, Buffer.from(data, "base64")); send(200, { path: p });
        }); return;
      }
      if (url.pathname === "/api/secret/backend") { loadSecrets(); return send(200, { backend: "file" }); }
      if (url.pathname === "/api/secret/has") {
        loadSecrets();
        const id = url.searchParams.get("id") ?? "";
        if (!SECRET_ID.test(id)) return send(400, "invalid secret id", "text/plain");
        return send(200, { has: secretMap.has(id) });
      }
      if ((url.pathname === "/api/secret/set" || url.pathname === "/api/secret/delete") && req.method === "POST") {
        readBody(req).then((raw) => {
          loadSecrets();
          const body = JSON.parse(raw || "{}");
          const id = String(body.id ?? "");
          if (!SECRET_ID.test(id)) return send(400, "invalid secret id", "text/plain");
          if (url.pathname === "/api/secret/set") {
            const value = String(body.value ?? "");
            if (!value) return send(400, "empty secret", "text/plain");
            secretMap.set(id, value);
          } else {
            secretMap.delete(id);
          }
          saveSecrets();
          send(200, { ok: true });
        }).catch((e) => send(500, String(e?.message ?? e), "text/plain"));
        return;
      }
      if (url.pathname === "/api/net/stream" && req.method === "POST") {
        readBody(req).then((raw) => {
          const body = JSON.parse(raw || "{}");
          const id = String(body.id ?? "");
          if (!id || id.length > 64) return send(400, "invalid stream id", "text/plain");
          proxyStream(id, body, res);
        }).catch((e) => send(500, String(e?.message ?? e), "text/plain"));
        return;
      }
      if (url.pathname === "/api/net/cancel" && req.method === "POST") {
        readBody(req).then((raw) => {
          const body = JSON.parse(raw || "{}");
          const ctl = netCancels.get(String(body.id ?? ""));
          if (ctl) ctl.abort();
          send(200, { ok: true });
        }).catch((e) => send(500, String(e?.message ?? e), "text/plain"));
        return;
      }
      if (url.pathname === "/api/themes") return send(200, { themes: fs.readdirSync(THEMES).filter((f) => f.endsWith(".css")) });
      if (url.pathname.startsWith("/themes/")) return serveFile(inside(THEMES, path.join(THEMES, decodeURIComponent(url.pathname.slice(8)))));
      if (url.pathname.startsWith("/fs/")) return serveFile(inside(ROOT, decodeURIComponent(url.pathname.slice(3))));
    } catch (e: any) { return send(500, String(e?.message ?? e), "text/plain"); }
    next();
  };
  return { name: "mdnest-dev-fs", configureServer: (s) => { s.middlewares.use(handler); }, configurePreviewServer: (s) => { s.middlewares.use(handler); } };
}

export default defineConfig({
  base: "./",
  plugins: [devFs()],
  clearScreen: false,
  server: { port: 1420, strictPort: true, host: "127.0.0.1", watch: { ignored: ["**/src-tauri/**", "**/dev-data/**"] } },
  preview: { port: 4173, host: "127.0.0.1" },
  build: { target: "es2022", chunkSizeWarningLimit: 4000, sourcemap: false },
  optimizeDeps: { include: ["codemirror"] },
});
