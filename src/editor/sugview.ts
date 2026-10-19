// Rendering of pending suggestions. Proposed Markdown is parsed and rendered with the
// editor schema (formatted, never raw syntax). Granularity:
//  - "words":     short inline edits — in-place word diff over plain text, original hidden
//  - "sentences": longer edits — rendered proposal, changed/new sentences highlighted, original struck
//  - "block":     rewrites that changed most sentences — rendered proposal marked as a full rewrite
//  - "insert":    generated text — rendered proposal
import { DOMSerializer, Fragment, Node as PMNode } from "prosemirror-model";
import { schema } from "./schema";
import { parseMarkdown } from "./markdown";
import { wordDiff } from "./diff";

export type SugView = "words" | "sentences" | "block" | "insert";

const words = (s: string) => (s.match(/[\p{L}\p{N}]+|[^\s\p{L}\p{N}]/gu) ?? []).length;

let seg: any;
export function sentences(text: string): string[] {
  const S = (Intl as any).Segmenter;
  if (S) {
    seg ??= new S(undefined, { granularity: "sentence" });
    return Array.from(seg.segment(text), (x: any) => x.segment as string).filter((s) => s.trim());
  }
  return text.split(/(?<=[.!?。！？])\s+/).filter((s) => s.trim());
}
const norm = (s: string) => s.replace(/\s+/g, " ").trim();

/** Parsed proposal; inline targets get the inline content of a single parsed textblock. */
export function parseProposal(md: string, inlineTarget: boolean): { frag: Fragment; inline: boolean } {
  let doc: PMNode;
  try { doc = parseMarkdown(md.replace(/\r\n/g, "\n")); } catch { doc = schema.node("doc", null, [schema.node("paragraph", null, md ? [schema.text(md)] : [])]); }
  if (inlineTarget && doc.childCount === 1 && doc.firstChild!.isTextblock && !doc.firstChild!.type.spec.code) {
    return { frag: doc.firstChild!.content, inline: true };
  }
  return { frag: doc.content, inline: false };
}

export function plainOf(frag: Fragment): string {
  return frag.size ? frag.textBetween(0, frag.size, "\n", (n) => n.attrs?.tex ?? n.textContent ?? "") : "";
}

/** Fraction of proposal sentences not present in the original (multiset match). */
export function changedSentences(orig: string, next: string): { changed: Set<number>; ratio: number; list: string[] } {
  const pool = new Map<string, number>();
  for (const s of sentences(orig)) pool.set(norm(s), (pool.get(norm(s)) ?? 0) + 1);
  const list = sentences(next);
  const changed = new Set<number>();
  list.forEach((s, i) => {
    const k = norm(s), c = pool.get(k) ?? 0;
    if (c > 0) pool.set(k, c - 1); else changed.add(i);
  });
  return { changed, ratio: list.length ? changed.size / list.length : 0, list };
}

export function chooseView(mode: "replace" | "insert", inlineTarget: boolean, origPlain: string, nextPlain: string): SugView {
  if (mode === "insert") return "insert";
  if (inlineTarget && words(origPlain) <= 30 && words(nextPlain) <= 40) return "words";
  const { ratio, list } = changedSentences(origPlain, nextPlain);
  return list.length >= 3 && ratio > 0.7 ? "block" : "sentences";
}

function serialize(frag: Fragment, inline: boolean): HTMLElement {
  const host = document.createElement(inline ? "span" : "div");
  try { host.appendChild(DOMSerializer.fromSchema(schema).serializeFragment(frag)); }
  catch { host.textContent = plainOf(frag); }
  return host;
}

/** Wrap the text in [s, e) of el's text content with spans of class cls. */
function wrapRange(el: Element, s: number, e: number, cls: string) {
  const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
  const nodes: Text[] = [];
  for (let n = walker.nextNode(); n; n = walker.nextNode()) nodes.push(n as Text);
  let off = 0;
  for (const t of nodes) {
    const len = t.data.length, a = Math.max(s, off), b = Math.min(e, off + len);
    if (a < b) {
      let mid = t;
      if (a > off) mid = mid.splitText(a - off);
      if (b < off + len) mid.splitText(b - a);
      const w = document.createElement("span");
      w.className = cls;
      mid.parentNode!.insertBefore(w, mid);
      w.appendChild(mid);
    }
    off += len;
  }
}

function markSentences(root: HTMLElement, origPlain: string) {
  const blocks = root.querySelectorAll("p,h1,h2,h3,h4,h5,h6,th,td,pre,span.md-sug-inline");
  const targets = blocks.length ? Array.from(blocks).filter((b) => !b.querySelector("p,h1,h2,h3,h4,h5,h6")) : [root];
  const pool = new Map<string, number>();
  for (const s of sentences(origPlain)) pool.set(norm(s), (pool.get(norm(s)) ?? 0) + 1);
  for (const b of targets) {
    const text = b.textContent ?? "";
    let pos = 0;
    const marks: [number, number][] = [];
    for (const s of sentences(text)) {
      const at = text.indexOf(s, pos);
      if (at < 0) continue;
      pos = at + s.length;
      const k = norm(s), c = pool.get(k) ?? 0;
      if (c > 0) pool.set(k, c - 1);
      else marks.push([at, at + s.trimEnd().length]);
    }
    for (const [s, e] of marks.reverse()) wrapRange(b, s, e, "md-sug-ins");
  }
}

/** Build the proposal DOM (inside the .md-sug-diff container). */
export function renderProposal(view: SugView, md: string, origPlain: string, inlineTarget: boolean): HTMLElement {
  const { frag, inline } = parseProposal(md, inlineTarget);
  if (view === "words") {
    const out = document.createElement("span");
    for (const op of wordDiff(origPlain, plainOf(frag))) {
      if (op.op === "eq") out.appendChild(document.createTextNode(op.text));
      else { const s = document.createElement("span"); s.className = op.op === "ins" ? "md-sug-ins" : "md-sug-old"; s.textContent = op.text; out.appendChild(s); }
    }
    return out;
  }
  const body = serialize(frag, inline);
  if (inline) body.className = "md-sug-inline";
  if (view === "sentences") markSentences(body, origPlain);
  else if (view === "block") body.classList.add("md-sug-rewrite");
  return body;
}
