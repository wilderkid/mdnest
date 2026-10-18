import { defineConfig, Plugin } from "vite";
import fs from "node:fs";
import path from "node:path";

// Dev/preview-only file API so the frontend runs in a plain browser (used for Playwright tests).
// Sandboxed to dev-data/workspace; themes served from dev-data/themes (falls back to ./themes).
const ROOT = path.resolve(__dirname, "dev-data/workspace");
const THEMES = fs.existsSync(path.resolve(__dirname, "dev-data/themes")) ? path.resolve(__dirname, "dev-data/themes") : path.resolve(__dirname, "themes");
const MIME: Record<string, string> = { ".css": "text/css", ".woff2": "font/woff2", ".woff": "font/woff", ".ttf": "font/ttf", ".otf": "font/otf",
  ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif", ".svg": "image/svg+xml", ".webp": "image/webp", ".md": "text/markdown; charset=utf-8" };
const inside = (base: string, p: string) => { const r = path.resolve(p); return r === base || r.startsWith(base + path.sep) ? r : null; };

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
