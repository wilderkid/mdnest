// Real desktop library smoke: Tauri app (Rust kb + notify watcher in-process), real embeddings from
// a local OpenAI-compatible server (llama.cpp llama-server or Ollama, nomic-embed-text), and the relay
// chat model for @library answers. The relay key comes from the environment and is deleted afterwards.
// Run: EMBED_URL=http://127.0.0.1:11434/v1 XAI_API_KEY=… node tests/native/library-smoke.mjs [binary]
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { startNative } from "./wd.mjs";

const app = process.argv[2] ?? "src-tauri/target/release/mdnest";
const embedUrl = process.env.EMBED_URL ?? "http://127.0.0.1:11434/v1";
const embedModel = process.env.EMBED_MODEL ?? "nomic-embed-text";
const baseUrl = process.env.RELAY_BASE_URL ?? "https://your-relay.example.com/v1";
const chatModel = process.env.CHAT_MODEL ?? "grok-4.7";
const key = process.env.XAI_API_KEY;
if (!key) { console.error("XAI_API_KEY not set"); process.exit(2); }
const redact = (s) => String(s).split(key).join("<redacted>");
const OUT = path.resolve("screenshots/library");
const WS = fs.mkdtempSync(path.join(os.tmpdir(), "mdnest-lib-ws-"));
const notes = {
  "readme.md": "# Notes\n\nPersonal notes: pets, cooking, work.\n",
  "pets/cats.md": "# Cats\n\nMiso and Tofu are our two cats.\n\n## Sleep\n\nThey sleep up to sixteen hours a day, mostly on the sofa in the afternoon.\n\n## Vet\n\nAnnual check-up is in March; vaccinations every three years.\n",
  "kitchen/sourdough.md": "# Sourdough\n\n## Starter\n\nFeed the starter with equal weights of flour and water the night before.\n\n## Proofing\n\nShape the loaf, then let it proof for 12 hours in the fridge before baking at 250 °C.\n",
  "work/launch.md": "# Product launch\n\nThe public release is scheduled for 14 November. Marketing needs final screenshots by 7 November.\n\n## Risks\n\nThe payment provider migration may slip by a week.\n",
  "notes/学习.md": "# 学习计划\n\n每天练习三十分钟日语听力，周末复习单词。\n",
  "private/diary.md": "# Diary\n\nSecret: I still have not filed my taxes.\n",
};
for (const [f, t] of Object.entries(notes)) { fs.mkdirSync(path.dirname(path.join(WS, f)), { recursive: true }); fs.writeFileSync(path.join(WS, f), t); }

const n = await startNative({ app, args: [path.join(WS, "readme.md")] });
let fail = 0;
const ok = (c, m, info = "") => { console.log((c ? "PASS " : "FAIL ") + m + (info ? " — " + redact(info).slice(0, 300) : "")); if (!c) fail++; };
const stats = () => n.exec((root) => window.mdnest.host.index.call({ op: "stats", root }), WS);
const until = async (pred, ms = 120000) => { const t0 = Date.now(); for (;;) { const s = await stats().catch(() => null); if (s && pred(s)) return s; if (Date.now() - t0 > ms) return s; await new Promise((r) => setTimeout(r, 400)); } };
const panel = (id) => n.exec((id) => { document.body.classList.add("pin-outline"); document.querySelector(`#typora-sidebar .sidebar-tab[data-id="p-${id}"]`).click(); }, id);
const searchTop = async (q) => {
  await n.exec((q) => { const i = document.querySelector(".mdn-lib-q"); i.value = q; i.dispatchEvent(new Event("input", { bubbles: true })); }, q);
  await new Promise((r) => setTimeout(r, 400));
  return n.waitFor(() => { const h = document.querySelector(".mdn-lib-hit"); return h ? h.innerText : null; }, { timeout: 15000 });
};
try {
  await n.waitFor(() => window.mdnest?.editor?.view && window.mdnest.host.kind === "tauri");
  await n.exec(async (k, url, m, eu, em) => {
    const s = (o, a, v) => localStorage.setItem(`mdnest.plugin.${o}.${a}`, JSON.stringify(v));
    s("ai", "enabled", true); s("ai", "preset", "relay"); s("ai", "baseUrl", url); s("ai", "model", m); s("ai", "maxTokens", 400);
    s("ai", "embedBaseUrl", eu); s("ai", "embedModel", em); s("ai", "exclude", "private");
    s("library", "enabled", true);
    await window.mdnest.host.secrets.set("ai.apikey", k);
  }, key, baseUrl, chatModel, embedUrl, embedModel);
  await n.exec(() => location.reload());
  await n.waitFor(() => window.mdnest?.editor?.view && window.mdnest.state.path);
  const t0 = Date.now();
  let s = await until((x) => x.chunks > 0 && x.embedded === x.chunks);
  ok(s.files === 5 && s.embedded === s.chunks && s.model === embedModel, `indexed natively in ${((Date.now() - t0) / 1000).toFixed(1)}s: ${s.files} files, ${s.chunks} chunks, dim ${s.dim}, db ${s.dbBytes} B`, JSON.stringify(s));
  await panel("library");
  const q1 = await searchTop("when do we ship to customers?");
  ok(/work\/launch\.md/.test(q1) && /meaning/.test(q1), "semantic: 'when do we ship to customers?' → launch note", q1);
  const q2 = await searchTop("how long should bread rise");
  ok(/kitchen\/sourdough\.md/.test(q2), "semantic: 'how long should bread rise' → sourdough", q2);
  // nomic-embed-text is English-centric: the English→Chinese match sits at cosine distance ≈0.49,
  // beyond the calibrated default (0.40). A per-model cut-off line (Settings → Library) brings it back.
  const setLib = (k, v) => n.exec((k, v) => { v == null ? localStorage.removeItem("mdnest.plugin.library." + k) : localStorage.setItem("mdnest.plugin.library." + k, JSON.stringify(v)); }, k, v);
  await setLib("cutoffs", "nomic-embed-text = 0.5 0.15");
  const q3 = await searchTop("Japanese listening practice");
  ok(/学习\.md/.test(q3), "cross-language: English query finds the Chinese note (per-model cut-off 0.5)", q3);
  await setLib("cutoffs", null);
  const allHits = async (q) => {
    await n.exec((q) => { const i = document.querySelector(".mdn-lib-q"); i.value = q; i.dispatchEvent(new Event("input", { bubbles: true })); }, q);
    await new Promise((r) => setTimeout(r, 1500));
    return n.exec(() => [...document.querySelectorAll(".mdn-lib-results:not(.mdn-lib-related) .mdn-lib-hit")].map((h) => h.innerText.replace(/\s+/g, " ")));
  };
  const q0 = await allHits("kubernetes ingress configuration");
  ok(!q0.some((h) => /meaning/.test(h)), `default nomic cut-off: unrelated question gets no meaning matches (${q0.length} hits)`, JSON.stringify(q0));
  const q4 = await searchTop("taxes");
  ok(!/diary/.test(q4 ?? ""), "excluded folder never indexed", q4);
  await n.screenshot(path.join(OUT, "06-native-real-embeddings-search.png"));

  // native watcher (notify) → incremental re-index + embed
  const before = s.chunks;
  fs.appendFileSync(path.join(WS, "pets/cats.md"), "\n## Food\n\nTofu is allergic to chicken, so only fish-based food.\n");
  s = await until((x) => x.chunks === before + 1 && x.embedded === x.chunks, 20000);
  ok(s.chunks === before + 1 && s.embedded === s.chunks, "notify watcher re-indexed the edited note", JSON.stringify(s));
  const q5 = await searchTop("which cat has a food allergy");
  ok(/Cats › Food/.test(q5), "new section searchable by meaning", q5);

  // @library through the relay model, citation jumps to the source line
  await panel("ai");
  await n.exec(() => { const i = document.querySelector(".mdn-ai-input"); i.value = "@library How long does the sourdough proof, and where?"; i.dispatchEvent(new Event("input", { bubbles: true })); i.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true })); });
  const t1 = Date.now();
  const ans = await n.waitFor(() => { const a = [...document.querySelectorAll(".mdn-ai-assistant")].pop(); const busy = [...document.querySelectorAll(".mdn-ai button")].some((b) => b.textContent === "Stop" && !b.disabled); return a && a.querySelector(".mdn-ai-sources") && !busy ? a.innerText : null; }, { timeout: 90000, interval: 400 });
  ok(/12/.test(ans) && /fridge/i.test(ans), `${chatModel} answered from the notes in ${((Date.now() - t1) / 1000).toFixed(1)}s`, ans);
  const cites = await n.exec(() => document.querySelectorAll(".mdn-ai-assistant:last-of-type .mdn-ai-cite, .mdn-ai-msg:last-child .mdn-ai-cite").length);
  ok(cites > 0, `answer carries ${cites} clickable citation(s)`, ans);
  await n.exec(() => { const b = [...document.querySelectorAll(".mdn-ai-cite")].pop() ?? document.querySelector(".mdn-ai-source"); b.click(); });
  await n.waitFor(() => window.mdnest.state.path?.endsWith("sourdough.md"), { timeout: 8000 }).catch(() => null);
  const where = await n.exec(() => ({ path: window.mdnest.state.path, block: window.mdnest.editor.view.state.selection.$from.node(1)?.textContent ?? "", flash: !!document.querySelector("#write .md-cite-flash") }));
  ok(/sourdough\.md$/.test(where.path ?? "") && /Proof|Shape the loaf|Starter|Feed/.test(where.block), "citation opened sourdough.md at the cited section", JSON.stringify(where));
  await n.screenshot(path.join(OUT, "07-native-library-chat-citation.png"));
  const usage = await n.exec(() => JSON.parse(localStorage.getItem("mdnest.plugin.ai.usage") || "{}"));
  console.log("usage: " + JSON.stringify(Object.values(usage)[0] ?? {}));
} catch (e) {
  ok(false, "error", e?.stack ?? e);
  try { await n.screenshot("/tmp/native-lib-fail.png"); console.log(redact(await n.exec(() => document.body.innerText.slice(0, 800)))); } catch { /* */ }
} finally {
  try {
    await n.exec(() => window.mdnest.host.secrets.delete("ai.apikey"));
    const files = [];
    const walk = (d) => { for (const f of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, f.name); f.isDirectory() ? walk(p) : files.push(p); } };
    walk(n.profile);
    const dbs = files.filter((f) => f.includes(`${path.sep}library${path.sep}`) && f.endsWith(".sqlite"));
    ok(dbs.length === 1 && !files.some((f) => { try { return fs.readFileSync(f).includes(key); } catch { return false; } }), `key deleted; no leak; index at ${dbs.map((d) => path.relative(n.profile, d)).join(",")}`);
    ok(!dbs.some((d) => fs.readFileSync(d).includes("filed my taxes")), "excluded note text not in the index DB");
  } catch (e) { ok(false, "cleanup", e?.message ?? e); }
  await n.close();
  fs.rmSync(WS, { recursive: true, force: true });
}
process.exit(fail ? 1 : 0);
