// Turn Markdown into a Slice the editor can insert. Shared by the plugin write API
// and suggestion accept, so both follow the same parse path.
import { EditorState } from "prosemirror-state";
import { Node as PMNode, Slice } from "prosemirror-model";
import { schema } from "./schema";
import { parseMarkdown, serializeMarkdown } from "./markdown";
import { collapseAll } from "./markers";

/** Serialize [from, to] the way the document serializer does: collapse raw markers, then cut a doc. */
export function selectionMarkdown(state: EditorState, from = state.selection.from, to = state.selection.to): string {
  ({ from, to } = normalizeRange(state, from, to));
  if (from === to) return "";
  if (sameTextblock(state, from, to)) {
    // Whole or partial single block: send only its inline content, keep "#", "- " etc. outside.
    const inner = collapseAll(state.doc).slice(from, to).content;
    try { return serializeMarkdown(schema.node("doc", null, [schema.node("paragraph", null, inner)])).replace(/\n+$/, ""); }
    catch { /* fall through */ }
  }
  const collapsed = collapseAll(state.doc);
  const lo = Math.max(0, Math.min(from, collapsed.content.size));
  const hi = Math.max(lo, Math.min(to, collapsed.content.size));
  if (lo === hi) return "";
  let doc: PMNode;
  try { doc = collapsed.cut(lo, hi); }
  catch { doc = docFromSlice(collapsed.slice(lo, hi)); }
  return serializeMarkdown(doc).replace(/\n$/, "");
}

function docFromSlice(slice: Slice): PMNode {
  try { return schema.node("doc", null, slice.content); }
  catch { /* inline fragment or open slice */ }
  const first = slice.content.firstChild;
  if (first && (first.isInline || first.isText)) {
    return schema.node("doc", null, [schema.node("paragraph", null, slice.content)]);
  }
  const text = slice.content.textBetween(0, slice.content.size, "\n");
  return schema.node("doc", null, [schema.node("paragraph", null, text ? [schema.text(text)] : [])]);
}

/**
 * A selection that ends at the very start of the next textblock (triple-click, shift+down) is
 * pulled back to the end of the previous one, so a whole-heading selection stays inside it.
 */
export function normalizeRange(state: EditorState, from: number, to: number): { from: number; to: number } {
  if (to <= from) return { from, to };
  try {
    const $to = state.doc.resolve(to);
    if ($to.parent.isTextblock && $to.parentOffset === 0) {
      let p = to - 1;
      while (p > from) {
        const $p = state.doc.resolve(p);
        if ($p.parent.isTextblock) return { from, to: p };
        p--;
      }
    }
  } catch { /* keep */ }
  return { from, to };
}

/** Plain text of [from, to] with atoms (math) as their source. */
export function plainBetween(state: EditorState, from: number, to: number): string {
  return from < to ? state.doc.textBetween(from, to, "\n", (n) => n.attrs?.tex ?? n.textContent ?? "") : "";
}

export function sameTextblock(state: EditorState, from: number, to: number) {
  try {
    const $a = state.doc.resolve(from), $b = state.doc.resolve(to);
    return $a.parent === $b.parent && $a.parent.isTextblock && !$a.parent.type.spec.code;
  } catch { return false; }
}

/**
 * Slice to insert at [from, to]. A single-paragraph parse becomes its inline
 * content when the target is inside a textblock, so "hello" does not nest a paragraph.
 */
export function sliceForInsert(md: string, state: EditorState, from: number, to: number): Slice {
  const parsed = parseMarkdown(md.replace(/\r\n/g, "\n"));
  // One parsed textblock (paragraph, or a heading the model echoed back) into a textblock target:
  // insert its inline content so the target keeps its own block type ("#", list item, …).
  const onlyBlock = parsed.childCount === 1 && parsed.firstChild!.isTextblock && !parsed.firstChild!.type.spec.code;
  if (onlyBlock && sameTextblock(state, from, to)) {
    return new Slice(parsed.firstChild!.content, 0, 0);
  }
  return new Slice(parsed.content, 0, 0);
}

/** Markdown of the top-level blocks around the block containing `pos`. */
export function contextMarkdown(state: EditorState, pos: number, before: number, after: number): string {
  const doc = collapseAll(state.doc);
  const clamped = Math.max(0, Math.min(pos, doc.content.size));
  const $p = doc.resolve(clamped);
  const top = $p.depth === 0 ? Math.min($p.index(0), Math.max(0, doc.childCount - 1)) : $p.index(0);
  const start = Math.max(0, top - Math.max(0, before));
  const end = Math.min(doc.childCount, top + 1 + Math.max(0, after));
  const nodes: PMNode[] = [];
  for (let i = start; i < end; i++) nodes.push(doc.child(i));
  if (!nodes.length) return "";
  return serializeMarkdown(schema.node("doc", null, nodes)).replace(/\n$/, "");
}
