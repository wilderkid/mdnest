// Typora-style editable heading markers. While the caret is in a heading, the heading's "## " prefix is
// real text (marked md_hprefix), so the user can click into it, delete a "#", type one more, or delete
// it entirely — the level follows the prefix live, and an invalid prefix turns the block into a
// paragraph. When the caret leaves, the prefix is removed again. The document is never serialized
// with a prefix: stripHeadingPrefixes() runs in collapseAll() (markers.ts).
//
// The prefix is only revealed after the user has touched the editor (pointer or key) since the document
// was loaded, so a freshly opened file doesn't show "# Title" just because the initial caret is there.
import { Plugin, PluginKey, EditorState, NodeSelection, Transaction } from "prosemirror-state";
import { Node as PMNode } from "prosemirror-model";
import { Transform } from "prosemirror-transform";
import { schema } from "./schema";

const hp = schema.marks.md_hprefix;
const PREFIX = /^(#{1,6}) /;

/** length of the leading md_hprefix text of a textblock */
export function headingPrefixLen(node: PMNode): number {
  let len = 0;
  node.forEach((c, off) => { if (off === len && c.isText && hp.isInSet(c.marks)) len += c.nodeSize; });
  return len;
}
/** heading text without a revealed prefix (outline, TOC) */
export function headingText(node: PMNode): string {
  const len = headingPrefixLen(node);
  return len ? node.textContent.slice(len) : node.textContent;
}

/** remove every revealed prefix (used before serializing / exporting) */
export function stripHeadingPrefixes(doc: PMNode): PMNode {
  const at: [number, number][] = [];
  doc.descendants((n, pos) => {
    if (!n.isTextblock) return true;
    const len = headingPrefixLen(n);
    if (len) at.push([pos + 1, len]);
    return false;
  });
  if (!at.length) return doc;
  const tr = new Transform(doc);
  for (const [from, len] of at.reverse()) tr.delete(from, from + len);
  return tr.doc;
}

interface HState { touched: boolean; pointerDown: boolean }
export const headingSrcKey = new PluginKey<HState>("md-heading-src");
/** a freshly loaded document: no prefix / marker reveal until the user clicks or types */
export function markPristine(state: EditorState) { const s = headingSrcKey.getState(state); if (s) s.touched = false; }
/** true once the user has clicked or typed in the editor since this document was loaded */
export const userTouched = (state: EditorState) => headingSrcKey.getState(state)?.touched ?? true;

function targetHeading(state: EditorState): number | null {
  const sel = state.selection;
  if (sel instanceof NodeSelection) return null;
  const { $from, $to } = sel;
  if ($from.parent.type !== schema.nodes.heading || !$from.sameParent($to)) return null;
  return $from.before();
}

function process(trs: readonly Transaction[], old: EditorState, state: EditorState): Transaction | null {
  const ps = headingSrcKey.getState(state)!;
  const active = ps.touched && !ps.pointerDown;
  const target = active ? targetHeading(state) : null;
  const tr = state.tr;
  let userDriven = false; // level/type changes that follow the user's own edit stay in that undo step
  const blocks: { pos: number; node: PMNode; len: number }[] = [];
  state.doc.descendants((n, pos) => {
    if (!n.isTextblock) return true;
    let marked = false;
    n.forEach((c) => { if (c.isText && hp.isInSet(c.marks)) marked = true; });
    if (marked) blocks.push({ pos, node: n, len: headingPrefixLen(n) });
    return false;
  });
  // the inverse mapping finds a block's previous version (to tell a level command from a prefix edit)
  const back = (pos: number) => { let p = pos; for (let i = trs.length - 1; i >= 0; i--) p = trs[i].mapping.invert().map(p, 1); return p; };
  // Undo/redo replays edits that were made to the transient prefix text, so its result is not a
  // meaningful prefix: drop every prefix character, keep the block type/level the history restored,
  // and reveal a fresh canonical prefix below.
  const history = trs.some((t) => t.getMeta("history$"));
  for (const { pos, node, len } of blocks.reverse()) {
    const start = pos + 1;
    if (history) {
      const ranges: [number, number][] = [];
      node.forEach((c, off) => { if (c.isText && hp.isInSet(c.marks)) ranges.push([start + off, start + off + c.nodeSize]); });
      for (const [a, b] of ranges.reverse()) tr.delete(a, b);
      continue;
    }
    if (node.type !== schema.nodes.heading) { // a command made it a paragraph
      if (len) tr.delete(start, start + len); else tr.removeMark(start, start + node.content.size, hp);
      continue;
    }
    const m = PREFIX.exec(node.textContent);
    if (pos !== target) {
      // caret left: hide the prefix (its level is already in sync)
      if (m) { tr.delete(start, start + m[0].length); if (node.attrs.level !== m[1].length) tr.setNodeMarkup(pos, undefined, { ...node.attrs, level: m[1].length }); }
      else { tr.removeMark(start, start + node.content.size, hp); tr.setNodeMarkup(pos, schema.nodes.paragraph); userDriven = true; }
      continue;
    }
    if (!m) {
      // "##Title", "Title", "#######": no longer a heading
      tr.removeMark(start, start + node.content.size, hp);
      tr.setNodeMarkup(pos, schema.nodes.paragraph);
      userDriven = true;
      continue;
    }
    const want = m[0].length;
    if (node.attrs.level !== m[1].length) {
      const prev = old.doc.nodeAt(back(pos));
      const prevPrefix = prev && prev.type === schema.nodes.heading && headingPrefixLen(prev) ? prev.textContent.slice(0, headingPrefixLen(prev)) : null;
      if (prevPrefix === m[0]) {
        // the prefix text is unchanged, so a command (Ctrl+1…6) changed the level: rewrite the prefix
        tr.replaceWith(start, start + want, schema.text("#".repeat(node.attrs.level) + " ", [hp.create()]));
        continue;
      }
      tr.setNodeMarkup(pos, undefined, { ...node.attrs, level: m[1].length });
      userDriven = true;
    }
    if (len !== want) {
      // keep the mark exactly on "#… " (a "#" typed before the first one is unmarked; text typed after the space is not prefix)
      tr.removeMark(start, start + node.content.size, hp);
      tr.addMark(start, start + want, hp.create());
    }
  }
  if (target != null) {
    const node = tr.doc.nodeAt(tr.mapping.map(target));
    if (node && node.type === schema.nodes.heading && !headingPrefixLen(node)) {
      const at = tr.mapping.map(target) + 1;
      tr.insert(at, schema.text("#".repeat(node.attrs.level) + " ", [hp.create()]));
    }
  }
  if (!tr.docChanged) return null;
  if (!userDriven) tr.setMeta("addToHistory", false);
  return tr.setMeta(headingSrcKey, {});
}

export function headingSrcPlugin() {
  return new Plugin<HState>({
    key: headingSrcKey,
    state: {
      init: () => ({ touched: true, pointerDown: false }),
      apply: (tr, v) => v, // mutated in place by the DOM handlers below (no transaction needed)
    },
    appendTransaction(trs, old, state) {
      if (trs.some((t) => t.getMeta(headingSrcKey))) return null;
      if (!trs.some((t) => t.docChanged || t.selectionSet || t.getMeta("md-hsrc-touch") || t.getMeta("md-markers"))) return null;
      if (trs.some((t) => t.getMeta("composition"))) return null;
      return process(trs, old, state);
    },
    props: {
      handleDOMEvents: {
        mousedown(view) {
          const s = headingSrcKey.getState(view.state)!;
          s.touched = true; s.pointerDown = true;
          const up = () => {
            window.removeEventListener("mouseup", up, true);
            const cur = headingSrcKey.getState(view.state); if (cur) cur.pointerDown = false;
            setTimeout(() => { if (!view.isDestroyed) view.dispatch(view.state.tr.setMeta("md-hsrc-touch", true)); }, 40);
          };
          window.addEventListener("mouseup", up, true);
          return false;
        },
        keydown(view) {
          const s = headingSrcKey.getState(view.state)!;
          if (!s.touched) { s.touched = true; view.dispatch(view.state.tr.setMeta("md-hsrc-touch", true)); }
          return false;
        },
        compositionend(view) {
          setTimeout(() => { if (!view.isDestroyed) view.dispatch(view.state.tr.setMeta("md-hsrc-touch", true)); }, 0);
          return false;
        },
      },
    },
  });
}
