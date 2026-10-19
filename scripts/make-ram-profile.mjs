#!/usr/bin/env node
// Prepare an XDG profile for scripts/measure-ram.sh PROFILE_DIR=… : starts the real app once
// (tauri-driver), stores plugin settings, waits until the workspace of FILE is indexed (and
// embedded when AI + embeddings are on), then quits and keeps the profile.
// usage: node scripts/make-ram-profile.mjs OUT_DIR FILE MODE [binary]
//   MODE: library   — AI on, library on, vectors from EMBED_URL (default http://127.0.0.1:11434/v1, nomic-embed-text)
//         keyword   — library on, AI off (keyword index only)
//         ai        — AI on, library off
// No API key is stored; nothing is sent anywhere except chunk text to the local embeddings server.
import fs from "node:fs";
import path from "node:path";
import { startNative } from "../tests/native/wd.mjs";

const [out, file, mode = "library", app = "src-tauri/target/release/mdnest"] = process.argv.slice(2);
if (!out || !file) { console.error("usage: make-ram-profile.mjs OUT_DIR FILE MODE [binary]"); process.exit(2); }
const embedUrl = process.env.EMBED_URL ?? "http://127.0.0.1:11434/v1", embedModel = process.env.EMBED_MODEL ?? "nomic-embed-text";
fs.rmSync(out, { recursive: true, force: true });
const n = await startNative({ app, args: [path.resolve(file)], profile: path.resolve(out) });
const root = fs.realpathSync(path.dirname(path.resolve(file)));
try {
  await n.waitFor(() => window.mdnest?.editor?.view && window.mdnest.host.kind === "tauri");
  await n.exec((mode, eu, em) => {
    const s = (o, k, v) => localStorage.setItem(`mdnest.plugin.${o}.${k}`, JSON.stringify(v));
    s("ai", "enabled", mode !== "keyword"); s("ai", "preset", "custom"); s("ai", "baseUrl", "http://127.0.0.1:9/v1"); s("ai", "model", "none");
    s("ai", "embedBaseUrl", eu); s("ai", "embedModel", em);
    s("library", "enabled", mode !== "ai");
  }, mode, embedUrl, embedModel);
  await n.exec(() => location.reload());
  await n.waitFor(() => window.mdnest?.editor?.view && window.mdnest.state.path);
  if (mode !== "ai") {
    const t0 = Date.now(); let s;
    for (;;) {
      s = await n.exec((root) => window.mdnest.host.index.call({ op: "stats", root }), root).catch(() => null);
      if (s && s.chunks > 0 && (mode === "keyword" || s.embedded === s.chunks)) break;
      if (Date.now() - t0 > 120000) throw new Error("indexing timed out " + JSON.stringify(s));
      await new Promise((r) => setTimeout(r, 400));
    }
    console.log("indexed: " + JSON.stringify(s));
  }
  await new Promise((r) => setTimeout(r, 1500)); // let WebKit flush localStorage
} finally { await n.close(); }
console.log("profile ready: " + out);
