#!/usr/bin/env node
// Calibrate the library's meaning cut-off for an embedding model against a labelled corpus
// (tests/fixtures/library-calib.json). Chunks come from the real Rust chunker (kb-cli scan/pending),
// vectors from any OpenAI-compatible /v1/embeddings endpoint (e.g. llama-server with nomic-embed-text).
// Prints cosine distances per query and a grid of (absolute, relative) cut-offs.
// Run: cargo build --release --bin kb-cli (in src-tauri); EMBED_URL=http://127.0.0.1:11434/v1 EMBED_MODEL=nomic-embed-text node scripts/calibrate-cutoff.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";

const url = process.env.EMBED_URL ?? "http://127.0.0.1:11434/v1";
const model = process.env.EMBED_MODEL ?? "nomic-embed-text";
const fx = JSON.parse(fs.readFileSync(new URL("../tests/fixtures/library-calib.json", import.meta.url)));
const bin = path.resolve(new URL("../src-tauri/target/release/kb-cli", import.meta.url).pathname);
const ws = fs.mkdtempSync(path.join(os.tmpdir(), "mdn-calib-ws-")), data = fs.mkdtempSync(path.join(os.tmpdir(), "mdn-calib-db-"));
for (const [f, t] of Object.entries(fx.files)) { fs.mkdirSync(path.dirname(path.join(ws, f)), { recursive: true }); fs.writeFileSync(path.join(ws, f), t); }
const kb = (req) => { const r = JSON.parse(execFileSync(bin, [data], { input: JSON.stringify({ root: ws, ...req }) })); if (r.err) throw new Error(r.err); return r.ok; };
const nomic = /nomic-embed/i.test(model);
const embed = async (texts) => {
  const r = await fetch(url.replace(/\/$/, "") + "/embeddings", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ model, input: texts }) });
  if (!r.ok) throw new Error("embeddings " + r.status + " " + (await r.text()).slice(0, 200));
  return (await r.json()).data.sort((a, b) => a.index - b.index).map((d) => d.embedding);
};
const cos = (a, b) => { let d = 0, x = 0, y = 0; for (let i = 0; i < a.length; i++) { d += a[i] * b[i]; x += a[i] * a[i]; y += b[i] * b[i]; } return 1 - d / Math.sqrt(x * y); };

kb({ op: "scan", exclude: [] });
const chunks = kb({ op: "pending", limit: 512 });
const st = kb({ op: "stats" });
const cvec = await embed(chunks.map((c) => (nomic ? "search_document: " : "") + c.input.slice(0, 8000)));
// chunk id → file: a search with the chunk's own vector returns that chunk first (distance 0)
kb({ op: "putVectors", model, items: chunks.map((c, i) => [c.id, cvec[i]]) });
const fileOf = new Map();
for (const c of chunks) {
  const hits = kb({ op: "search", query: "", vector: cvec[chunks.indexOf(c)], k: 1, maxDistance: 2 });
  if (hits[0]) fileOf.set(c.id, hits[0].rel);
}
const rows = [];
for (const { q, rel } of fx.queries) {
  const [qv] = await embed([(nomic ? "search_query: " : "") + q]);
  const d = chunks.map((c, i) => ({ id: c.id, file: fileOf.get(c.id), dist: cos(qv, cvec[i]) })).sort((a, b) => a.dist - b.dist);
  rows.push({ q, rel, d });
}
console.log(`model ${model} · ${st.files} files · ${chunks.length} chunks · dim ${cvec[0].length}\n`);
for (const r of rows) {
  const best = r.d[0].dist;
  const relBest = r.rel.length ? Math.min(...r.d.filter((x) => r.rel.includes(x.file)).map((x) => x.dist)) : null;
  const irr = r.d.filter((x) => !r.rel.includes(x.file));
  console.log(`${r.q.padEnd(44)} best ${best.toFixed(3)} (${r.d[0].file})  rel ${relBest == null ? "  —  " : relBest.toFixed(3)}  first-irrelevant ${irr[0].dist.toFixed(3)} (${irr[0].file})`);
}
// grid: a relevant query "keeps" its relevant note if its best relevant chunk passes; noise = irrelevant chunks that pass
console.log("\nabs   rel   | relevant kept | relevant at #1 | irrelevant hits (relevant queries) | hits on no-match queries");
const grid = [];
for (const abs of [0.35, 0.38, 0.4, 0.42, 0.44, 0.45, 0.46, 0.48, 0.5, 0.55, 0.6, 0.8]) for (const relm of [0.03, 0.05, 0.06, 0.08, 0.1, 0.12, 0.15, 2]) {
  let kept = 0, nrel = 0, top = 0, noise = 0, none = 0;
  for (const r of rows) {
    const best = r.d[0].dist;
    const pass = r.d.filter((x) => x.dist <= abs && x.dist <= best + relm);
    if (r.rel.length) {
      nrel++;
      if (pass.some((x) => r.rel.includes(x.file))) kept++;
      if (pass[0] && r.rel.includes(pass[0].file)) top++;
      noise += pass.filter((x) => !r.rel.includes(x.file)).length;
    } else none += pass.length;
  }
  grid.push({ abs, relm, kept, nrel, top, noise, none });
  console.log(`${abs.toFixed(2)}  ${relm === 2 ? " off" : relm.toFixed(2)}  | ${String(kept).padStart(2)}/${nrel}         | ${String(top).padStart(2)}             | ${String(noise).padStart(4)}                              | ${none}`);
}
// end-to-end check through the Rust search with the chosen cut-offs (CUT_MAX / CUT_REL, default nomic's)
const cmax = Number(process.env.CUT_MAX ?? 0.4), crel = Number(process.env.CUT_REL ?? 0.05);
let found = 0, nrel = 0, noise = 0, noneHits = 0, oldNoise = 0, oldNone = 0;
for (const { q, rel } of fx.queries) {
  const [qv] = await embed([(nomic ? "search_query: " : "") + q]);
  const vecHits = (mx, rl) => kb({ op: "search", query: "", vector: qv, k: 10, maxDistance: mx, relDistance: rl });
  const h = vecHits(cmax, crel), old = vecHits(0.8, 0);
  if (rel.length) { nrel++; if (h.some((x) => rel.includes(x.rel))) found++; noise += h.filter((x) => !rel.includes(x.rel)).length; oldNoise += old.filter((x) => !rel.includes(x.rel)).length; }
  else { noneHits += h.length; oldNone += old.length; }
}
console.log(`\nRust search, k=10, meaning only: cut-off ${cmax}/${crel}: relevant found ${found}/${nrel}, irrelevant hits ${noise}, hits on no-match queries ${noneHits}` +
  ` · old 0.8/none: irrelevant hits ${oldNoise}, hits on no-match queries ${oldNone}`);
fs.rmSync(ws, { recursive: true, force: true }); fs.rmSync(data, { recursive: true, force: true });
if (process.env.CALIB_JSON) fs.writeFileSync(process.env.CALIB_JSON, JSON.stringify({ model, rows: rows.map((r) => ({ q: r.q, rel: r.rel, d: r.d.slice(0, 8) })), grid }, null, 1));
