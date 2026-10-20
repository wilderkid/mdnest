// Typora-style editable markers.
// When the caret enters (or touches) a formatted inline span, that span is swapped for its literal
// Markdown source (e.g. "**bold**") marked with `md_src`. The user edits real characters, so typing or
// deleting delimiters changes the formatting. When the caret leaves, the raw text is re-parsed into
// marks. Raw regions are styled live with inline decorations (delimiters get .md-meta).
import { Plugin, PluginKey, EditorState, Transaction, TextSelection } from "prosemirror-state";
import { Decoration, DecorationSet, EditorView } from "prosemirror-view";
import { Fragment, Mark, Node as PMNode } from "prosemirror-model";
import { Transform } from "prosemirror-transform";
import { schema } from "./schema";
import { parser, serializer, refEnvFor } from "./markdown";
import { renderTex } from "./render";
import { stripHeadingPrefixes, headingPrefixLen, userTouched } from "./headingsrc";

const CARET = "\uE000", LEAD = "\uE001";
const src = schema.marks.md_src;
const hprefix = schema.marks.md_hprefix;
/** marks that make a span "formatted" (expandable); the heading prefix mark is not formatting */
const fmt = (m: Mark) => m.type !== src && m.type !== hprefix;

/** inline fragment → markdown source; optional caret offset (within fragment) is tracked */
export function inlineToMarkdown(frag: Fragment, caret?: number): { text: string; caret: number } {
  if (caret != null) {
    // insert a sentinel carrying the marks of the char before the caret (so "link|" maps inside [..])
    let before: readonly Mark[] = [], after: readonly Mark[] = [], off = 0;
    frag.forEach((n) => { if (off < caret) before = n.marks; if (off >= caret && after.length === 0 && off === caret) after = n.marks; off += n.nodeSize; });
    const marks = caret > 0 ? before : after;
    const left = frag.cut(0, caret), right = frag.cut(caret);
    frag = left.append(Fragment.from(schema.text(CARET, marks as Mark[]))).append(right);
  }
  const para = schema.nodes.paragraph.create(null, Fragment.from(schema.text(LEAD)).append(frag));
  let out = serializer.serialize(schema.node("doc", null, [para])).replace(/\n+$/, "");
  out = out.replace(LEAD, "");
  const ci = out.indexOf(CARET);
  return { text: out.replace(CARET, ""), caret: ci < 0 ? out.length : ci };
}

/** markdown source → inline fragment (falls back to plain text when it would not be a paragraph) */
export function markdownToInline(raw: string, env: any = {}): Fragment {
  if (!raw) return Fragment.empty;
  try {
    const doc = (parser as any).parse(LEAD + raw, { references: env.references });
    if (doc && doc.childCount === 1 && doc.firstChild!.type === schema.nodes.paragraph) {
      const c = doc.firstChild!.content;
      const first = c.firstChild!;
      if (first.isText && first.text!.startsWith(LEAD)) {
        const rest = first.text!.slice(1);
        const head = rest ? Fragment.from(first.type.schema.text(rest, first.marks)) : Fragment.empty;
        return head.append(c.cut(first.nodeSize));
      }
    }
  } catch (e) { console.warn("reparse failed", e); }
  return Fragment.from(schema.text(raw));
}

export function srcRanges(doc: PMNode, from = 0, to = doc.content.size) {
  const out: { from: number; to: number }[] = [];
  doc.nodesBetween(from, to, (node, pos) => {
    if (!node.isTextblock) return true;
    let cur: { from: number; to: number } | null = null;
    node.forEach((child, off) => {
      const p = pos + 1 + off;
      if (child.isText && src.isInSet(child.marks)) { if (cur && cur.to === p) cur.to = p + child.nodeSize; else { cur = { from: p, to: p + child.nodeSize }; out.push(cur); } }
      else cur = null;
    });
    return false;
  });
  return out;
}

const PH = 0xe100; // placeholder chars for raw runs while serializing a block
const SPECIAL = /[*_`~=\[\]$\\<]/;

/**
 * Re-parse a whole textblock: formatted content is serialized normally, raw (md_src) runs are
 * spliced in verbatim, and the result is parsed by markdown-it. `caret` (doc pos inside the block)
 * is tracked with a sentinel; returns its new position (or null).
 */
function collapseBlock(tr: Transform, blockPos: number, caret: number | null): number | null {
  const whole = tr.doc.nodeAt(blockPos)!;
  // a revealed heading prefix ("## ") stays verbatim in front of the re-parsed inline content
  const skip = headingPrefixLen(whole);
  const block = skip ? whole.copy(whole.content.cut(skip)) : whole; const start = blockPos + 1 + skip;
  const raws: string[] = []; const parts: PMNode[] = [];
  let run = null as string | null;
  const flush = () => { if (run != null) { parts.push(schema.text(String.fromCharCode(PH + raws.length))); raws.push(run); run = null; } };
  let off = 0; let caretPlaced = false;
  block.forEach((child) => {
    const p = start + off; off += child.nodeSize;
    const inRaw = child.isText && !!src.isInSet(child.marks);
    let node: PMNode = child;
    if (caret != null && !caretPlaced && caret >= p && caret < p + child.nodeSize && child.isText) {
      const k = caret - p; caretPlaced = true;
      if (inRaw) { run = (run ?? "") + child.text!.slice(0, k) + CARET + child.text!.slice(k); return; }
      flush();
      if (k > 0) parts.push(child.cut(0, k));
      parts.push(schema.text(CARET, child.marks)); node = child.cut(k);
      parts.push(node); return;
    }
    if (inRaw) { run = (run ?? "") + child.text!; return; }
    flush(); parts.push(node);
  });
  if (caret != null && !caretPlaced && caret === start + block.content.size) {
    if (run != null) run += CARET; else { const last = parts[parts.length - 1]; parts.push(schema.text(CARET, last?.isText ? last.marks.filter((m) => m.type !== src) as Mark[] : [])); }
    caretPlaced = true;
  }
  flush();
  const para = schema.nodes.paragraph.create(null, Fragment.from(schema.text(LEAD)).append(Fragment.fromArray(parts)));
  let text = serializer.serialize(schema.node("doc", null, [para])).replace(/\n+$/, "").replace(LEAD, "");
  text = text.replace(/[\ue100-\ue1ff]/g, (ch) => raws[ch.charCodeAt(0) - PH] ?? "");
  let frag = markdownToInline(text, /[\[\]]/.test(text) ? refEnvFor(tr.doc) : {});
  // locate + remove caret sentinel
  let newCaret: number | null = null;
  if (caretPlaced) {
    const nodes: PMNode[] = []; let acc = 0;
    frag.forEach((n) => {
      if (newCaret == null && n.isText && n.text!.includes(CARET)) {
        const k = n.text!.indexOf(CARET); newCaret = start + acc + k;
        const t = n.text!.replace(CARET, ""); if (t) nodes.push(schema.text(t, n.marks)); acc += t.length;
      } else { nodes.push(n); acc += n.nodeSize; }
    });
    frag = Fragment.fromArray(nodes);
  }
  if (frag.eq(block.content)) return newCaret; // nothing changed structurally
  tr.replaceWith(start, start + block.content.size, frag);
  return newCaret;
}

function collapseRange(tr: Transform, r: { from: number; to: number }) {
  const $p = tr.doc.resolve(r.from);
  collapseBlock(tr, $p.before(), null);
}
/** re-parse every raw region (used before serializing / exporting) */
export function collapseAll(doc: PMNode): PMNode {
  doc = stripHeadingPrefixes(doc);
  const ranges = srcRanges(doc); if (!ranges.length) return doc;
  const tr = new Transform(doc);
  const blocks = [...new Set(ranges.map((r) => doc.resolve(r.from).before()))].sort((a, b) => b - a);
  for (const b of blocks) collapseBlock(tr, b, null);
  return tr.doc;
}

/** span of formatted inline content touching `pos` (marks, inline math), or null */
function expandable(doc: PMNode, pos: number) {
  const $p = doc.resolve(pos); const parent = $p.parent;
  if (!parent.isTextblock || parent.type.spec.code) return null;
  const start = $p.start();
  type Seg = { from: number; to: number; node: PMNode };
  const segs: Seg[] = [];
  parent.forEach((n, off) => segs.push({ from: start + off, to: start + off + n.nodeSize, node: n }));
  const ATOMS = ["inline_math", "footnote_ref"];
  const formatted = (n: PMNode) => !hprefix.isInSet(n.marks) && (ATOMS.includes(n.type.name) || n.marks.some(fmt));
  // segments that touch the caret and are formatted
  let lo = -1, hi = -1;
  segs.forEach((s, i) => { if (formatted(s.node) && s.from <= pos && pos <= s.to) { if (lo < 0) lo = i; hi = i; } });
  if (lo < 0) return null;
  // grow while neighbours share any non-src mark with the current edge (covers nested/overlapping marks)
  const shares = (a: PMNode, b: PMNode) => a.marks.some((m) => fmt(m) && m.isInSet(b.marks));
  while (lo > 0 && shares(segs[lo].node, segs[lo - 1].node)) lo--;
  while (hi < segs.length - 1 && shares(segs[hi].node, segs[hi + 1].node)) hi++;
  if (segs.slice(lo, hi + 1).some((s) => !s.node.isText && !ATOMS.includes(s.node.type.name))) return null; // images etc.
  return { from: segs[lo].from, to: segs[hi].to, start, parent };
}

export const markersKey = new PluginKey<{ pointerDown: boolean }>("md-markers");
const pointer = { down: false };
/**
 * Bring ProseMirror's selection in line with the DOM selection *now*. After a click the browser moves
 * the caret natively and ProseMirror only learns about it on the (async) selectionchange event; a key
 * pressed, or a paste, before that event would act on the stale selection. Called on mouseup (+30 ms),
 * before every keydown and before paste/drop.
 */
export function syncSelectionFromDOM(view: EditorView, force = false): boolean {
  const dom = view.dom.ownerDocument.getSelection();
  if (!dom || !dom.anchorNode || !dom.focusNode || !view.dom.contains(dom.anchorNode) || !view.dom.contains(dom.focusNode)) return false;
  const inCM = (n: Node) => (n.nodeType === 1 ? (n as Element) : n.parentElement)?.closest(".CodeMirror, [contenteditable=false]");
  if (inCM(dom.anchorNode) || inCM(dom.focusNode)) return false;
  let anchor: number, head: number;
  try { anchor = view.posAtDOM(dom.anchorNode, dom.anchorOffset); head = view.posAtDOM(dom.focusNode, dom.focusOffset); } catch { return false; }
  const sel = view.state.selection;
  if (!force && anchor === sel.anchor && head === sel.head) return false;
  try {
    const $a = view.state.doc.resolve(anchor), $h = view.state.doc.resolve(head);
    if (!$a.parent.inlineContent || !$h.parent.inlineContent) return false;
    view.dispatch(view.state.tr.setSelection(TextSelection.between($a, $h)).setMeta(markersKey, { pointerDown: false }));
    return true;
  } catch { return false; }
}

function expandAt(tr: Transaction, state: EditorState) {
  if (!userTouched(state)) return; // not on a freshly loaded document before the user clicks/types
  const sel = tr.selection;
  if (!sel.empty || !(sel instanceof TextSelection)) return;
  const pos = sel.head;
  const $p = tr.doc.resolve(pos);
  if ($p.marks().some((m) => m.type === src) || (pos > $p.start() && $p.nodeBefore?.marks.some((m) => m.type === src))) return;
  const r = expandable(tr.doc, pos); if (!r) return;
  const frag = r.parent.content.cut(r.from - r.start, r.to - r.start);
  const { text, caret } = inlineToMarkdown(frag, pos - r.from);
  if (!text) return;
  tr.replaceWith(r.from, r.to, schema.text(text, [src.create()]));
  tr.setSelection(TextSelection.create(tr.doc, r.from + caret));
  // (no stored marks: they would go stale and leak md_src into text typed elsewhere after a click;
  //  text typed at the very start of a raw region is attached in appendTransaction instead)
}

export function markersPlugin() {
  return new Plugin({
    key: markersKey,
    state: {
      init: () => ({ pointerDown: false }),
      apply: (tr, v) => { const m = tr.getMeta(markersKey); return m ? { ...v, ...m } : v; },
    },
    appendTransaction(trs, _old, state) {
      if (trs.some((t) => t.getMeta("md-markers-internal"))) return null;
      const pointerDown = pointer.down;
      if (!trs.some((t) => t.docChanged || t.selectionSet || t.getMeta(markersKey))) return null;
      const tr = state.tr.setMeta("md-markers-internal", true);
      // 1) literally typed / pasted Markdown punctuation becomes raw source (md_src)
      const inserted: [number, number][] = [];
      trs.forEach((t, ti) => {
        // A smart-punctuation replacement must stay its own undo step. Marking the
        // inserted glyph merges that step with the characters the user just typed.
        if (t.getMeta("history$") || t.getMeta("smart-punct") || !t.docChanged) return;
        t.steps.forEach((step, si) => step.getMap().forEach((_os, _oe, ns, ne) => {
          if (ne <= ns) return;
          let a = ns, b = ne; const rest = t.mapping.slice(si + 1);
          a = rest.map(a, -1); b = rest.map(b, 1);
          for (const later of trs.slice(ti + 1)) { a = later.mapping.map(a, -1); b = later.mapping.map(b, 1); }
          inserted.push([a, b]);
        }));
      });
      for (const [a, b] of inserted) {
        tr.doc.nodesBetween(a, b, (n, pos, parent) => {
          if (!n.isText || !parent || !parent.isTextblock || parent.type.spec.code) return;
          if (n.marks.some((m) => m.type === src || m.type === hprefix || m.type.spec.code)) return;
          const f = Math.max(a, pos), t2 = Math.min(b, pos + n.nodeSize);
          const after = tr.doc.resolve(t2).nodeAfter;
          const touchesRaw = !!after && after.isText && !!src.isInSet(after.marks) && t2 === pos + n.nodeSize;
          if (touchesRaw || SPECIAL.test(tr.doc.textBetween(f, t2))) tr.addMark(f, t2, src.create());
        });
      }
      if (pointerDown) return tr.docChanged ? tr : null;
      // 2) collapse textblocks whose raw regions no longer hold the selection
      const sel = tr.selection; const { from, to } = sel;
      const ranges = srcRanges(tr.doc);
      const byBlock = new Map<number, { from: number; to: number }[]>();
      for (const r of ranges) { const b = tr.doc.resolve(r.from).before(); (byBlock.get(b) ?? byBlock.set(b, []).get(b)!).push(r); }
      let caret: number | null = null;
      for (const [b, rs] of [...byBlock.entries()].sort((x, y) => y[0] - x[0])) {
        const holds = rs.some((r) => from >= r.from && to <= r.to);
        if (holds && rs.length === 1) continue;
        const node = tr.doc.nodeAt(b)!;
        const caretHere = sel.empty && from > b && from < b + node.nodeSize ? from : null;
        const nc = collapseBlock(tr, b, caretHere);
        if (caretHere != null && nc != null) caret = nc;
      }
      if (caret != null) tr.setSelection(TextSelection.create(tr.doc, caret));
      // 3) expand the formatted span at the caret
      expandAt(tr, state);
      return tr.docChanged || tr.selectionSet ? tr : null;
    },
    props: {
      decorations(state) {
        const decos: Decoration[] = [];
        for (const r of srcRanges(state.doc)) {
          const raw = state.doc.textBetween(r.from, r.to);
          for (const d of highlightInline(raw)) {
            const a = r.from + d.from, b = r.from + d.to;
            if (d.widget) decos.push(Decoration.widget(b, mathPreview(d.widget), { side: 1, key: "mp:" + d.widget }));
            else if (b > a) decos.push(Decoration.inline(a, b, d.attrs));
          }
        }
        return decos.length ? DecorationSet.create(state.doc, decos) : null;
      },
      handleDOMEvents: {
        // While the mouse button is down (click / drag-select) nothing is expanded or collapsed, so the
        // DOM doesn't shift under the pointer. No transaction is dispatched here: dispatching before
        // ProseMirror has read the click's DOM selection would write the *old* selection back (this was
        // the Phase 1 click-then-type misplacement). The flag is cleared in a capture-phase mouseup that
        // runs before ProseMirror's own mouseup handler, whose selection transaction then expands.
        mousedown(view) {
          pointer.down = true;
          const up = () => {
            window.removeEventListener("mouseup", up, true);
            pointer.down = false;
            // fallback for clicks that don't produce a selection transaction (same position)
            setTimeout(() => { if (!view.isDestroyed && !pointer.down && view.hasFocus()) { if (!syncSelectionFromDOM(view)) view.dispatch(view.state.tr.setMeta(markersKey, { pointerDown: false })); } }, 30);
          };
          window.addEventListener("mouseup", up, true);
          return false;
        },
        keydown(view) { if (!pointer.down) syncSelectionFromDOM(view); return false; },
        paste(view) { syncSelectionFromDOM(view); return false; },
      },
    },
  });
}

function mathPreview(tex: string) {
  return () => {
    const el = document.createElement("span");
    el.className = "md-inline-math-preview md-math-container"; el.contentEditable = "false";
    renderTex(tex, false).then((h) => (el.innerHTML = h));
    return el;
  };
}

type Hl = { from: number; to: number; attrs: any; widget?: string };
/** lightweight inline Markdown highlighter for raw regions (styling only; parsing is markdown-it's job) */
export function highlightInline(s: string, base = 0, out: Hl[] = []): Hl[] {
  const meta = (a: number, b: number, extra = "") => out.push({ from: base + a, to: base + b, attrs: { class: "md-meta md-before" + extra } });
  const wrap = (a: number, b: number, nodeName: string, cls?: string) => out.push({ from: base + a, to: base + b, attrs: { nodeName, ...(cls ? { class: cls } : {}) } });
  let i = 0;
  const find = (needle: string, from: number) => { for (let j = from; j < s.length; j++) { if (s[j] === "\\") { j++; continue; } if (s.startsWith(needle, j)) return j; } return -1; };
  while (i < s.length) {
    const c = s[i];
    if (c === "\\" && i + 1 < s.length) { meta(i, i + 1); i += 2; continue; }
    if (c === "`") {
      let n = 0; while (s[i + n] === "`") n++;
      const close = s.indexOf("`".repeat(n), i + n);
      if (close > 0) { meta(i, i + n); wrap(i + n, close, "code"); meta(close, close + n); i = close + n; continue; }
      i += n; continue;
    }
    if (c === "$" && s[i + 1] !== "$") {
      const close = find("$", i + 1);
      if (close > i + 1) { meta(i, i + 1); wrap(i + 1, close, "span", "md-math-src"); meta(close, close + 1); out.push({ from: base + close + 1, to: base + close + 1, attrs: null, widget: s.slice(i + 1, close) }); i = close + 1; continue; }
    }
    const pair = (d: string, tag: string) => {
      if (!s.startsWith(d, i)) return false;
      const close = find(d, i + d.length);
      if (close <= i + d.length - 0 || close === i + d.length) return false;
      meta(i, i + d.length); wrap(i + d.length, close, tag);
      highlightInline(s.slice(i + d.length, close), base + i + d.length, out);
      meta(close, close + d.length); i = close + d.length; return true;
    };
    if (pair("**", "strong") || pair("__", "strong") || pair("~~", "del") || pair("==", "mark")) continue;
    if ((c === "*" || c === "_") && s[i + 1] !== c && pair(c, "em")) continue;
    if (c === "!" && s[i + 1] === "[") { const e = s.indexOf(")", i); if (e > 0) { meta(i, e + 1); i = e + 1; continue; } }
    if (c === "[") {
      const mid = find("](", i + 1);
      const end = mid > 0 ? find(")", mid + 2) : -1;
      if (mid > 0 && end > 0) {
        meta(i, i + 1); wrap(i + 1, mid, "a"); highlightInline(s.slice(i + 1, mid), base + i + 1, out);
        out.push({ from: base + mid, to: base + end + 1, attrs: { class: "md-meta md-after md-url md-content" } }); i = end + 1; continue;
      }
    }
    i++;
  }
  return out;
}

/** make input rules / commands aware of raw regions */
export const inRawRegion = (state: EditorState) => state.selection.$from.marks().some((m) => m.type === src) || (state.storedMarks ?? []).some((m) => m.type === src);
export type { EditorView };
