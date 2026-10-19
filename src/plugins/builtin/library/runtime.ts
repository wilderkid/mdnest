// Library runtime (lazy): scan → embed loop, watcher, hybrid search panel, related notes, @library.
import type { PluginContext } from "../../api";
import type { AiProvider } from "../ai/provider";
import type { Source } from "../ai/mentions";

export interface Hit { id: number; path: string; rel: string; heading: string; anchor: string; lineStart: number; lineEnd: number; text: string; score: number; via: string[] }
export interface Stats { root: string; files: number; chunks: number; embedded: number; model: string | null; dim: number | null; dbBytes: number }
interface Status { phase: "idle" | "scanning" | "embedding" | "paused" | "error" | "off"; done: number; total: number; message: string; vectors: boolean }

let ctx: PluginContext;
let ai: AiProvider;
let unwatch: (() => void) | null = null;
let unmention: (() => void) | null = null;
let job: AbortController | null = null;
let queue: Promise<void> = Promise.resolve();
let savedHook = false;
const status: Status = { phase: "off", done: 0, total: 0, message: "", vectors: false };
const listeners = new Set<() => void>();
const changed = () => listeners.forEach((f) => { try { f(); } catch { /* panel gone */ } });

export function init(c: PluginContext, provider: AiProvider) { ctx = c; ai = provider; }

export function excludes(): string[] {
  const own = String(ctx.settings.get("exclude") ?? "").split(/\r?\n/).map((l) => l.trim()).filter((l) => l && !l.startsWith("#"));
  return [...new Set([...ai.excluded(), ...own])];
}

/** embeddings are usable: AI on, vectors enabled, endpoint configured */
export function vectorsWanted(): boolean {
  if (ctx.settings.get("embed") === false) return false;
  try { const i = ai.embedInfo(); return ai.info().enabled && !!i.baseUrl && !!i.model; } catch { return false; }
}

const set = (p: Partial<Status>) => { Object.assign(status, p); changed(); };
const serial = (fn: () => Promise<void>) => (queue = queue.then(fn, fn));

export async function start() {
  if (!ctx.workspace.root()) { set({ phase: "idle", message: "Open a folder to build its library." }); return; }
  unwatch?.(); unwatch = null;
  unmention ??= ai.registerMention({ trigger: "@library", title: "Library", resolve: (q, signal) => resolveMention(q, signal) });
  try { unwatch = await ctx.index.watch((paths) => { void serial(() => runScan(paths)); }); } catch { /* browser host without watch */ }
  if (!savedHook) {
    savedHook = true;
    ctx.events.on("file-saved", (p?: string) => { if (p && ctx.settings.get("enabled") === true) void serial(() => runScan([p])); });
  }
  await serial(() => runScan());
}

export function stop() {
  job?.abort(); job = null; unwatch?.(); unwatch = null; unmention?.(); unmention = null;
  set({ phase: "off", message: "" });
}

export async function reindex(full: boolean) {
  if (full) { job?.abort(); await ctx.index.call("clear"); }
  await serial(() => runScan());
}

/** scan (optionally only some paths), then embed pending chunks in batches */
export async function runScan(paths?: string[]) {
  if (ctx.settings.get("enabled") !== true || !ctx.workspace.root()) return;
  set({ phase: "scanning", message: paths ? `Updating ${paths.length} file(s)…` : "Scanning folder…" });
  try {
    const rep = await ctx.index.call("scan", { exclude: excludes(), ...(paths ? { paths } : {}) });
    set({ message: `${rep.changedFiles} changed · +${rep.addedChunks} −${rep.removedChunks} chunks` });
    await embedPending();
  } catch (e: any) {
    set({ phase: "error", message: String(e?.message ?? e) });
  }
}

export async function embedPending(batch = 32) {
  if (!vectorsWanted()) { set({ phase: "idle", vectors: false, message: status.message || "Keyword search only (no embeddings)" }); return; }
  const { model } = ai.embedInfo();
  const ac = new AbortController(); job = ac;
  const st0 = await ctx.index.call<Stats>("stats");
  // a different embedding model rebuilds all vectors (Rust drops them on the first put)
  const total = st0.model && st0.model !== model ? st0.chunks : st0.chunks - st0.embedded;
  let done = 0;
  set({ phase: "embedding", done, total, vectors: true });
  try {
    for (;;) {
      if (ac.signal.aborted) { set({ phase: "paused", message: "Paused" }); return; }
      const pending = await ctx.index.call<{ id: number; input: string }[]>("pending", { limit: batch });
      if (!pending.length) break;
      const pre = taskPrefix(model, "doc");
      const vecs = await ai.embed(pending.map((p) => pre + p.input.slice(0, 8000)), { signal: ac.signal, batch });
      await ctx.index.call("putVectors", { model, items: pending.map((p, i) => [p.id, vecs[i]]) });
      done += pending.length;
      set({ done, total: Math.max(total, done) });
    }
    set({ phase: "idle", message: `Indexed · ${done} new vector${done === 1 ? "" : "s"}` });
  } catch (e: any) {
    if (ac.signal.aborted) { set({ phase: "paused", message: "Paused" }); return; }
    set({ phase: "error", vectors: false, message: "Embeddings unavailable: " + String(e?.message ?? e) + " — keyword search still works" });
  } finally { if (job === ac) job = null; }
}

export function pause() { job?.abort(); }

/** Task prefixes some embedding models are trained with (nomic-embed-text: search_document / search_query). */
export function taskPrefix(model: string, kind: "doc" | "query"): string {
  if (/nomic-embed/i.test(model)) return kind === "doc" ? "search_document: " : "search_query: ";
  return "";
}

const qcache = new Map<string, number[]>();
async function queryVector(q: string, signal?: AbortSignal): Promise<number[] | undefined> {
  if (!vectorsWanted() || status.phase === "error") return undefined;
  const st = await ctx.index.call<Stats>("stats").catch(() => null);
  if (!st?.embedded || st.model !== ai.embedInfo().model) return undefined;
  const key = st.model + "\u0000" + q;
  if (qcache.has(key)) return qcache.get(key);
  try {
    const [v] = await ai.embed([taskPrefix(st.model, "query") + q], { signal });
    if (qcache.size > 50) qcache.clear();
    qcache.set(key, v);
    return v;
  } catch { return undefined; }
}

/** Cosine-distance cut-off for meaning-only hits (model dependent; keyword hits are unaffected). */
export function maxDistance(): number {
  const v = Number(ctx.settings.get("maxDistance"));
  return Number.isFinite(v) && v > 0 && v <= 2 ? v : 0.8;
}

export async function search(q: string, k = 8, signal?: AbortSignal): Promise<Hit[]> {
  if (!q.trim()) return [];
  const vector = await queryVector(q, signal);
  return ctx.index.call<Hit[]>("search", { query: q, k, maxDistance: maxDistance(), ...(vector ? { vector } : {}) });
}

export const label = (h: Hit) => h.rel + (h.heading ? " › " + h.heading.split(" > ").join(" › ") : "");

export function formatSources(hits: Hit[], max = 1500): { context: string; sources: Source[] } {
  const sources: Source[] = hits.map((h, i) => ({ n: i + 1, label: label(h), path: h.path, line: h.lineStart, text: h.text }));
  const context = hits.map((h, i) => `[${i + 1}] ${label(h)} (lines ${h.lineStart}–${h.lineEnd})\n${h.text.length > max ? h.text.slice(0, max) + "…" : h.text}`).join("\n\n");
  return { context, sources };
}

export async function resolveMention(q: string, signal?: AbortSignal) {
  if (ctx.settings.get("enabled") !== true) return { context: "", sources: [] };
  const k = Math.max(1, Math.min(12, Number(ctx.settings.get("k")) || 6));
  return formatSources(await search(q, k, signal));
}

// ---------- panel ----------

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string, text?: string) {
  const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e;
}

export function mountPanel(host: HTMLElement) {
  host.replaceChildren();
  const root = el("div", "mdn-lib");
  const statusEl = el("div", "mdn-lib-status");
  const bar = el("div", "mdn-lib-progress"); const fill = el("div"); bar.appendChild(fill);
  const actions = el("div", "mdn-lib-actions");
  const btn = (t: string, f: () => void) => { const b = el("button", "", t); b.type = "button"; b.onclick = f; return b; };
  const pauseBtn = btn("Pause", () => { if (status.phase === "embedding") pause(); else void serial(() => embedPending()); });
  actions.append(btn("Re-index", () => void reindex(false)), pauseBtn);
  const input = el("input", "mdn-lib-q") as HTMLInputElement; input.type = "search"; input.placeholder = "Search notes (keywords + meaning)…";
  const results = el("div", "mdn-lib-results");
  const relHead = el("div", "mdn-lib-h", "Related to this note");
  const related = el("div", "mdn-lib-results mdn-lib-related");
  root.append(statusEl, bar, actions, input, results, relHead, related);
  host.appendChild(root);

  const hitView = (h: Hit) => {
    const item = el("button", "mdn-lib-hit"); item.type = "button";
    const top = el("div", "mdn-lib-hit-top");
    top.append(el("span", "mdn-lib-hit-title", label(h)), el("span", "mdn-lib-hit-line", `:${h.lineStart}`));
    for (const v of h.via) top.appendChild(el("span", "mdn-lib-via mdn-lib-via-" + v, v === "fts" ? "keyword" : "meaning"));
    const snip = h.text.replace(/^#{1,6} .*\n+/, "").replace(/\s+/g, " ").slice(0, 160);
    item.append(top, el("div", "mdn-lib-hit-snip", snip));
    item.onclick = () => { void ctx.workspace.openAt(h.path, h.lineStart); };
    return item;
  };
  const paintStatus = async () => {
    const st = await ctx.index.call<Stats>("stats").catch(() => null);
    const base = st ? `${st.files} files · ${st.chunks} chunks · ${st.embedded}/${st.chunks} vectors${st.model ? " (" + st.model + ")" : ""}` : "No folder open";
    statusEl.textContent = base + (status.message ? " — " + status.message : "");
    const pct = status.phase === "embedding" && status.total ? Math.round((100 * status.done) / status.total) : 0;
    bar.style.display = status.phase === "embedding" ? "" : "none";
    fill.style.width = pct + "%";
    const missing = !!st && st.embedded < st.chunks;
    pauseBtn.textContent = status.phase === "embedding" ? "Pause" : "Resume vectors";
    pauseBtn.style.display = status.phase === "embedding" || missing ? "" : "none";
    pauseBtn.disabled = !vectorsWanted() || status.phase === "scanning";
    root.dataset.phase = status.phase;
  };
  let t: any, ac: AbortController | null = null;
  const run = () => {
    clearTimeout(t);
    t = setTimeout(async () => {
      ac?.abort(); ac = new AbortController(); const mine = ac;
      const q = input.value;
      const hits = await search(q, 10, mine.signal).catch((e) => { results.replaceChildren(el("p", "mdn-lib-empty", String(e?.message ?? e))); return null; });
      if (!hits || mine.signal.aborted) return;
      results.replaceChildren(...(hits.length ? hits.map(hitView) : q.trim() ? [el("p", "mdn-lib-empty", "No matches.")] : []));
    }, 250);
  };
  input.addEventListener("input", run);
  const paintRelated = async () => {
    const p = ctx.editor.getFilePath();
    const hits = p ? await ctx.index.call<Hit[]>("related", { path: p, k: 5 }).catch(() => []) : [];
    related.replaceChildren(...(hits.length ? hits.map(hitView) : [el("p", "mdn-lib-empty", vectorsWanted() ? "Nothing related yet." : "Needs embeddings.")]));
  };
  const onChange = () => { void paintStatus(); if (status.phase === "idle") void paintRelated(); };
  listeners.add(onChange);
  ctx.events.on("file-opened", () => void paintRelated());
  void paintStatus(); void paintRelated();
  return () => { listeners.delete(onChange); };
}

export const _status = status; // tests
