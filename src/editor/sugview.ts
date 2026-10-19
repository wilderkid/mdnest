// Rendering of pending suggestions. Proposed Markdown is parsed and rendered with the
// editor schema (formatted, never raw syntax). Granularity:
//  - "words":     short inline edits — in-place word diff over formatted tokens (marks kept), original hidden
//  - "sentences": longer edits — rendered proposal, changed/new sentences highlighted, original struck
//  - "block":     rewrites that changed most sentences — rendered proposal marked as a full rewrite
//  - "insert":    generated text — rendered proposal
import { DOMSerializer, Fragment, Mark, Node as PMNode } from "prosemirror-model";
import { schema } from "./schema";
import { parseMarkdown } from "./markdown";
import { diffBy, tokenize } from "./diff";
import { renderTex } from "./render";

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

// ---------- formatted word diff ----------

/** One diff token: a word or a whitespace run with its marks, or an inline atom (math, image, break…). */
export interface InlineTok { text: string; marks: readonly Mark[]; node?: PMNode }

const markKey = (m: Mark) => m.type.name + (m.type.name === "link" ? "(" + m.attrs.href + ")" : "");
/** Tokens compare by text plus formatting, so "word" → "**word**" shows as a change. Whitespace
 *  compares by text only (a space inside vs. outside a bold run is not an edit). */
export function tokKey(t: InlineTok): string {
  if (t.node) return "\u0001" + t.node.type.name + ":" + JSON.stringify(t.node.attrs);
  if (/^\s+$/.test(t.text)) return t.text;
  return t.text + "\u0002" + t.marks.filter((m) => m.type.name !== "md_src").map(markKey).sort().join(",");
}

export function inlineTokens(frag: Fragment): InlineTok[] {
  const out: InlineTok[] = [];
  frag.forEach((n) => {
    if (n.isText) {
      const marks = n.marks.filter((m) => m.type.name !== "md_src");
      for (const w of tokenize(n.text!)) out.push({ text: w, marks });
    } else if (n.isInline) out.push({ text: n.attrs?.tex ?? n.textContent ?? "", marks: n.marks, node: n });
    else n.forEach((c) => out.push(...inlineTokens(Fragment.from(c)))); // defensive: unexpected block
  });
  return out;
}

const tokNodes = (toks: InlineTok[]): PMNode[] => toks.map((t) => t.node ?? schema.text(t.text, t.marks as Mark[]));

/** Word diff over two inline fragments; each run is an inline Fragment that keeps its marks. */
export function inlineDiff(orig: Fragment, next: Fragment): { op: "eq" | "ins" | "del"; frag: Fragment }[] {
  return diffBy(inlineTokens(orig), inlineTokens(next), tokKey).map((r) => ({ op: r.op, frag: Fragment.fromArray(tokNodes(r.items)) }));
}

/** Original inline content for the word diff: the parsed original Markdown when it matches the
 *  captured plain text, else the plain text itself (unformatted). */
export function originalInline(origMd: string | undefined, origPlain: string): Fragment {
  if (origMd) {
    const p = parseProposal(origMd, true);
    if (p.inline && norm(plainOf(p.frag)) === norm(origPlain)) return p.frag;
  }
  return origPlain ? Fragment.from(schema.text(origPlain)) : Fragment.empty;
}

// ---------- math in proposals ----------

/** Replace raw TeX of inline / display math in a proposal with MathJax SVG, as the editor does.
 *  Async; the TeX text stays as fallback until (or if) MathJax renders. */
export function renderMath(root: HTMLElement): Promise<void> {
  const jobs: Promise<void>[] = [];
  root.querySelectorAll<HTMLElement>(".md-inline-math:not([data-tex])").forEach((m) => {
    const tex = m.textContent ?? "";
    m.dataset.tex = tex; m.classList.add("md-math-container");
    // a sentence highlight wrapped the TeX text inside; move it onto the formula before replacing it
    if (m.querySelector(".md-sug-ins")) m.classList.add("md-sug-ins");
    jobs.push(renderTex(tex, false).then((svg) => { m.innerHTML = `<span class="md-math-preview">${svg}</span>`; }, () => {}));
  });
  root.querySelectorAll<HTMLElement>(".md-math-block:not([data-tex])").forEach((m) => {
    const tex = m.textContent ?? "";
    m.dataset.tex = tex;
    jobs.push(renderTex(tex, true).then((svg) => { m.innerHTML = `<div class="md-math-preview mathjax-block">${svg}</div>`; }, () => {}));
  });
  return Promise.all(jobs).then(() => {});
}

/** Build the proposal DOM (inside the .md-sug-diff container). */
export function renderProposal(view: SugView, md: string, origPlain: string, inlineTarget: boolean, origMd?: string): HTMLElement {
  const { frag, inline } = parseProposal(md, inlineTarget);
  let out: HTMLElement;
  if (view === "words") {
    out = document.createElement("span");
    const ser = DOMSerializer.fromSchema(schema);
    const base = inline ? frag : Fragment.from(schema.text(plainOf(frag) || " "));
    for (const r of inlineDiff(originalInline(origMd, origPlain), base)) {
      let dom: Node;
      try { dom = ser.serializeFragment(r.frag); } catch { dom = document.createTextNode(r.frag.textBetween(0, r.frag.size, "", (n) => n.attrs?.tex ?? "")); }
      if (r.op === "eq") out.appendChild(dom);
      else { const s = document.createElement("span"); s.className = r.op === "ins" ? "md-sug-ins" : "md-sug-old"; s.appendChild(dom); out.appendChild(s); }
    }
  } else {
    out = serialize(frag, inline);
    if (inline) out.className = "md-sug-inline";
    if (view === "sentences") markSentences(out, origPlain);
    else if (view === "block") out.classList.add("md-sug-rewrite");
  }
  if (typeof document !== "undefined" && out.querySelector(".md-inline-math, .md-math-block")) void renderMath(out);
  return out;
}
