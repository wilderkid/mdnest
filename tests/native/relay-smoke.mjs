// Real desktop (Tauri) smoke through an OpenAI-compatible relay: Rust net_stream + SSE + secret store.
// The key is taken from the environment at runtime (e.g. `. ~/.grok/relay.env`), stored with the
// app's secret API, and deleted afterwards. It is never printed or written to the repo.
// Run: XAI_API_KEY=… node tests/native/relay-smoke.mjs [binary] [model]
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { startNative } from "./wd.mjs";

const app = process.argv[2] ?? "src-tauri/target/release/mdnest";
const model = process.argv[3] ?? "grok-4.7";
const baseUrl = process.env.RELAY_BASE_URL ?? "https://your-relay.example.com/v1";
const key = process.env.XAI_API_KEY;
if (!key) { console.error("XAI_API_KEY not set"); process.exit(2); }
const OUT = path.resolve("screenshots/ai-polish");
const redact = (s) => String(s).split(key).join("<redacted>");

// Neutral throwaway workspace, so the file tree in the screenshot shows test notes only
// (without a file argument the sidebar would list the user's home folder).
const WS = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "mdnest-relay-")), "smoke-notes");
const notes = { "smoke.md": "# Smoke test\n", "ideas.md": "# Ideas\n\n- one\n", "todo.md": "# To do\n\n- [ ] water the plants\n" };
for (const [f, t] of Object.entries(notes)) { fs.mkdirSync(WS, { recursive: true }); fs.writeFileSync(path.join(WS, f), t); }
const n = await startNative({ app, args: [path.join(WS, "smoke.md")] });
let fail = 0;
const ok = (c, m, info = "") => { console.log((c ? "PASS " : "FAIL ") + m + (info ? " — " + redact(info).slice(0, 300) : "")); if (!c) fail++; };
try {
  await n.waitFor(() => window.mdnest?.editor?.view && window.mdnest.host.kind === "tauri");
  await n.exec(async (k, url, m) => {
    const s = (a, v) => localStorage.setItem("mdnest.plugin.ai." + a, JSON.stringify(v));
    s("enabled", true); s("preset", "relay"); s("baseUrl", url); s("model", m); s("maxTokens", 300);
    await window.mdnest.host.secrets.set("ai.apikey", k);
  }, key, baseUrl, model);
  await n.exec(() => location.reload());
  await n.waitFor(() => window.mdnest?.editor?.view && document.querySelector('#typora-sidebar .sidebar-tab[data-id="p-ai"]'));
  const tree = await n.exec(() => document.querySelector("#typora-sidebar")?.innerText ?? "");
  ok(/smoke-notes/i.test(tree) && !/chrome-profile|cli-config|sand-data/.test(tree), "sidebar shows the neutral test workspace only", tree.replace(/\s+/g, " ").slice(0, 200));
  ok(await n.exec(() => window.mdnest.host.secrets.has("ai.apikey")), "key is in the native secret store (" + await n.exec(() => window.mdnest.host.secrets.backend()) + ")");
  await n.exec(() => {
    window.mdnest.editor.setMarkdown("# Smoke test\n\nthis sentence have a error and it are bad.\n");
    const v = window.mdnest.editor.view, { state } = v;
    let r = null;
    state.doc.descendants((nd, p) => { if (!r && nd.isTextblock && nd.textContent.startsWith("this")) r = [p + 1, p + 1 + nd.content.size]; });
    v.dispatch(state.tr.setSelection(state.selection.constructor.create(state.doc, r[0], r[1])));
    v.focus();
    window.mdnest.editor.view.dom.dispatchEvent(new KeyboardEvent("keydown", { key: "P", code: "KeyP", ctrlKey: true, shiftKey: true, bubbles: true }));
  });
  await n.waitFor(() => !!document.querySelector("#mdn-palette input"));
  await n.exec(() => {
    const inp = document.querySelector("#mdn-palette input");
    inp.value = "AI: Polish"; inp.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await n.waitFor(() => [...document.querySelectorAll("#mdn-palette .pal-item")].some((e) => e.textContent.includes("AI: Polish")));
  const t0 = Date.now();
  await n.exec(() => [...document.querySelectorAll("#mdn-palette .pal-item")].find((e) => e.textContent.includes("AI: Polish")).dispatchEvent(new MouseEvent("mousedown", { bubbles: true })));
  const status = await n.waitFor(() => {
    const st = document.querySelector("#write .md-sug-status")?.textContent ?? "";
    const acc = [...document.querySelectorAll("#write .md-sug-bar button")].some((b) => b.textContent === "Accept");
    return acc || /error|rejected|not found|cannot/i.test(st) ? st || "ready" : null;
  }, { timeout: 90000, interval: 300 });
  const secs = ((Date.now() - t0) / 1000).toFixed(1);
  const proposal = await n.exec(() => document.querySelector("#write .md-sug-diff")?.innerText ?? "");
  ok(!/error|not found|cannot|rejected/i.test(status), `relay streamed a suggestion in ${secs}s via Rust net_stream`, status + " | " + proposal);
  ok(!(await n.exec(() => document.documentElement.outerHTML + JSON.stringify(localStorage))).includes(key), "key not in DOM or localStorage");
  await n.screenshot(path.join(OUT, "06-native-relay-smoke.png"));
  await n.exec(() => [...document.querySelectorAll("#write .md-sug-bar button")].find((b) => b.textContent === "Accept")?.dispatchEvent(new MouseEvent("mousedown", { bubbles: true })));
  const md = await n.exec(() => window.mdnest.editor.getMarkdown());
  ok(/^# Smoke test\n/.test(md) && !/have a error/.test(md), "accepted rewrite in document", JSON.stringify(md.slice(0, 160)));
  const usage = await n.exec(() => JSON.parse(localStorage.getItem("mdnest.plugin.ai.usage") || "{}"));
  const day = Object.values(usage)[0] ?? {};
  ok(day.requests === 1 && day.prompt + day.completion > 0, "usage counted", JSON.stringify(day));
  console.log("result: " + JSON.stringify(md.split("\n")[2]) + " · usage " + JSON.stringify(day));
} catch (e) {
  ok(false, "error", e?.stack ?? e);
  try { await n.screenshot("/tmp/native-fail.png"); console.log(redact(await n.exec(() => document.body.innerText.slice(0, 600)))); } catch { /* */ }
} finally {
  try {
    await n.exec(() => window.mdnest.host.secrets.delete("ai.apikey"));
    const gone = !(await n.exec(() => window.mdnest.host.secrets.has("ai.apikey")));
    const files = [];
    const walk = (d) => { for (const f of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, f.name); f.isDirectory() ? walk(p) : files.push(p); } };
    walk(n.profile);
    const leaked = files.some((f) => { try { return fs.readFileSync(f).includes(key); } catch { return false; } });
    ok(gone && !leaked, "key deleted from the secret store; no profile file contains it");
  } catch (e) { ok(false, "cleanup", e?.message ?? e); }
  await n.close();
  fs.rmSync(path.dirname(WS), { recursive: true, force: true });
}
process.exit(fail ? 1 : 0);
