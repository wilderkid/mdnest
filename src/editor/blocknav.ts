// Typora-style navigation around block elements (0.2.2):
//  * arrows leave a block at its edges; past the first/last block of the document they create an
//    empty paragraph; between two blocks (code/math/HTML/table/hr…) the caret becomes a gap cursor;
//  * Ctrl/Cmd+Enter inserts a paragraph after the block; Shift+Enter is a soft line break;
//  * Backspace/Delete next to a block select it first (visible highlight), the next press removes it;
//  * a grip handle at the left of a block selects it with one click.
import { EditorState, NodeSelection, Plugin, PluginKey, Selection, TextSelection, Transaction } from "prosemirror-state";
import { GapCursor } from "prosemirror-gapcursor";
import { EditorView } from "prosemirror-view";
import { Node as PMNode } from "prosemirror-model";
import { splitBlock } from "prosemirror-commands";
import { isInTable, addRowAfter } from "prosemirror-tables";
import { t } from "../i18n";

/** GapCursor.valid is marked internal in the typings but is the plugin's own test for a gap position. */
const gapValid = ($p: ReturnType<PMNode["resolve"]>): boolean => (GapCursor as any).valid($p);
type Dispatch = ((tr: Transaction) => void) | undefined;
type Dir = "left" | "right" | "up" | "down";

/** Blocks that Backspace/Delete select as a whole instead of merging into. */
export const SELECT_BLOCKS = new Set(["code_block", "math_block", "html_block", "table", "horizontal_rule", "toc", "front_matter", "link_def"]);
/** Blocks that get the hover grip handle. */
const HANDLE_BLOCKS = new Set([...SELECT_BLOCKS, "blockquote", "bullet_list", "ordered_list", "footnote_def"]);

export const blockSelKey = new PluginKey<boolean>("mdn-block-select");
/** True while the current NodeSelection was made by block selection (handle / Backspace / Delete):
 *  node views show a highlight instead of entering their editor. */
export function quietBlockSelection(state: EditorState): boolean {
  return state.selection instanceof NodeSelection && !!blockSelKey.getState(state);
}
export function selectBlockTr(tr: Transaction, pos: number): Transaction {
  return tr.setSelection(NodeSelection.create(tr.doc, pos)).setMeta(blockSelKey, true).scrollIntoView();
}

const para = (state: EditorState) => state.schema.nodes.paragraph.create();

/** Insert an empty paragraph at `pos` and put the caret in it. */
function paragraphAt(tr: Transaction, pos: number): Transaction {
  tr.insert(pos, tr.doc.type.schema.nodes.paragraph.create());
  return tr.setSelection(TextSelection.create(tr.doc, pos + 1)).scrollIntoView();
}

/** Can a paragraph be inserted at `pos`? (not before YAML front matter, only where blocks go) */
function canParagraphAt(doc: PMNode, pos: number): boolean {
  const $p = doc.resolve(pos);
  if ($p.parent.inlineContent) return false;
  if ($p.depth === 0 && $p.index() === 0 && doc.firstChild?.type.name === "front_matter") return false;
  return $p.parent.canReplaceWith($p.index(), $p.index(), doc.type.schema.nodes.paragraph);
}

/**
 * Leave the block [pos, pos+size) in direction `dir` (used by CodeMirror node views and by the
 * keymap for selected blocks). Past the document edge an empty paragraph is created; between two
 * blocks the caret becomes a gap cursor.
 */
export function leaveBlockTr(state: EditorState, pos: number, size: number, dir: 1 | -1): Transaction | null {
  const edge = dir > 0 ? pos + size : pos;
  const $edge = state.doc.resolve(edge);
  const found = Selection.findFrom($edge, dir);
  if (!found) return canParagraphAt(state.doc, edge) ? paragraphAt(state.tr, edge) : null;
  if (gapValid($edge)) return state.tr.setSelection(new GapCursor($edge)).scrollIntoView();
  return state.tr.setSelection(found).scrollIntoView();
}
export function leaveBlock(view: EditorView, pos: number, size: number, dir: 1 | -1): boolean {
  const tr = leaveBlockTr(view.state, pos, size, dir);
  if (!tr) return false;
  view.focus();
  view.dispatch(tr);
  view.focus();
  return true;
}

/** Insert an empty paragraph right after the block at [pos, pos+size) (Ctrl+Enter). */
export function paragraphAfterTr(state: EditorState, pos: number, size: number): Transaction {
  return paragraphAt(state.tr, pos + size);
}

function tableRowInfo($h: ReturnType<EditorState["doc"]["resolve"]>): { row: number; rows: number } | null {
  for (let d = $h.depth; d > 0; d--) if ($h.node(d).type.spec.tableRole === "row") return { row: $h.index(d - 1), rows: $h.node(d - 1).childCount };
  return null;
}

/** Arrow keys: Typora-like movement out of and around block elements. */
export function blockArrow(dir: Dir) {
  const fwd = dir === "right" || dir === "down";
  const side: 1 | -1 = fwd ? 1 : -1;
  return (state: EditorState, dispatch: Dispatch, view?: EditorView): boolean => {
    const sel = state.selection;
    // a selected block or a gap cursor: step past it / out of the gap
    if (sel instanceof GapCursor) {
      const $p = sel.$head;
      const found = Selection.findFrom($p, side);
      if (!found) {
        if (!canParagraphAt(state.doc, $p.pos)) return false;
        dispatch?.(paragraphAt(state.tr, $p.pos));
        return true;
      }
      // into the neighbouring block (a code block gets its CodeMirror caret at the near edge)
      dispatch?.(state.tr.setSelection(found).scrollIntoView());
      return true;
    }
    if (sel instanceof NodeSelection && sel.node.isBlock) {
      const tr = leaveBlockTr(state, sel.from, sel.node.nodeSize, side);
      if (!tr) return false;
      dispatch?.(tr);
      return true;
    }
    if (!sel.empty || !view || !view.endOfTextblock(dir)) return false;
    const $h = sel.$head;
    if ($h.parent.type.spec.code || $h.depth === 0) return false;
    // last (first) top-level block, caret on its last (first) line, nothing to move to → new paragraph
    const top = $h.index(0);
    const edgeTop = fwd ? top === state.doc.childCount - 1 : top === 0;
    if (edgeTop && $h.depth > 1) {
      const tbl = tableRowInfo($h);
      const vertical = dir === "up" || dir === "down";
      let atEdge: boolean;
      if (tbl && vertical) atEdge = fwd ? tbl.row === tbl.rows - 1 : tbl.row === 0;
      else atEdge = !Selection.findFrom(state.doc.resolve(fwd ? $h.after() : $h.before()), side, true);
      if (atEdge) {
        const at = fwd ? state.doc.content.size : 0;
        if (!canParagraphAt(state.doc, at)) return false;
        dispatch?.(paragraphAt(state.tr, at));
        return true;
      }
    }
    // entering a CodeMirror block or stopping in the gap after/before a block
    if (tableRowInfo($h) && !(dir === "left" || dir === "right")) return false;
    const $out = state.doc.resolve(fwd ? $h.after() : $h.before());
    if ($h.depth === 1 && gapValid($out)) return false; // the gap cursor plugin handles it
    const next = Selection.near($out, side);
    if (next.$head && next.$head.parent.type.spec.code && next.$head.parent !== $h.parent) {
      dispatch?.(state.tr.setSelection(next).scrollIntoView());
      return true;
    }
    return false;
  };
}

/** The block node before (dir -1) or after (dir 1) the textblock holding the caret, at the same depth. */
function siblingBlock(state: EditorState, dir: 1 | -1): { node: PMNode; pos: number } | null {
  const $c = state.selection.$from;
  if ($c.depth === 0) return null;
  const d = $c.depth - 1;
  const idx = $c.index(d);
  const container = $c.node(d);
  if (dir < 0 ? idx === 0 : idx >= container.childCount - 1) return null;
  const node = container.child(idx + dir);
  const pos = dir < 0 ? $c.before() - node.nodeSize : $c.after();
  return { node, pos };
}

/** Delete the selected block; the caret lands in the neighbouring textblock (or a fresh paragraph). */
export function deleteSelectedBlock(state: EditorState, dispatch: Dispatch, dir: 1 | -1 = -1): boolean {
  const sel = state.selection;
  if (!(sel instanceof NodeSelection) || !sel.node.isBlock) return false;
  if (!dispatch) return true;
  const { from, to } = sel;
  const $from = state.doc.resolve(from);
  const parent = $from.parent;
  const idx = $from.index();
  const before = idx > 0 ? parent.child(idx - 1) : null;
  const after = idx + 1 < parent.childCount ? parent.child(idx + 1) : null;
  const want = dir < 0 ? (before ?? after) : (after ?? before);
  let tr = state.tr;
  if (!want || !want.isTextblock || want.type.spec.code) {
    // keep a paragraph where the block was, so the caret has a home and the layout does not jump
    tr = tr.replaceWith(from, to, para(state));
    tr.setSelection(TextSelection.create(tr.doc, from + 1));
  } else {
    tr = tr.delete(from, to);
    const at = Math.min(from, tr.doc.content.size);
    tr.setSelection(Selection.near(tr.doc.resolve(at), want === before ? -1 : 1));
  }
  dispatch(tr.scrollIntoView());
  return true;
}

function backspace(state: EditorState, dispatch: Dispatch): boolean {
  const sel = state.selection;
  if (sel instanceof NodeSelection && sel.node.isBlock) return deleteSelectedBlock(state, dispatch, -1);
  if (sel instanceof GapCursor) {
    const before = sel.$head.nodeBefore;
    if (!before) return false;
    dispatch?.(selectBlockTr(state.tr, sel.head - before.nodeSize));
    return true;
  }
  if (!sel.empty) return false;
  const $c = sel.$from;
  if (!$c.parent.isTextblock || $c.parent.type.spec.code) return false;
  // an image just before the caret: select it first, the next Backspace removes it
  const img = $c.nodeBefore;
  if (img && img.type.name === "image") {
    dispatch?.(state.tr.setSelection(NodeSelection.create(state.doc, $c.pos - img.nodeSize)).scrollIntoView());
    return true;
  }
  if ($c.parentOffset !== 0) return false;
  const sib = siblingBlock(state, -1);
  if (!sib || !SELECT_BLOCKS.has(sib.node.type.name)) return false;
  if (dispatch) {
    let tr = state.tr;
    // an empty paragraph after a block is simply removed
    if ($c.parent.type.name === "paragraph" && $c.parent.content.size === 0) tr = tr.delete($c.before(), $c.after());
    dispatch(selectBlockTr(tr, sib.pos));
  }
  return true;
}

function del(state: EditorState, dispatch: Dispatch): boolean {
  const sel = state.selection;
  if (sel instanceof NodeSelection && sel.node.isBlock) return deleteSelectedBlock(state, dispatch, 1);
  if (sel instanceof GapCursor) {
    const after = sel.$head.nodeAfter;
    if (!after) return false;
    dispatch?.(selectBlockTr(state.tr, sel.head));
    return true;
  }
  if (!sel.empty) return false;
  const $c = sel.$from;
  if (!$c.parent.isTextblock || $c.parent.type.spec.code) return false;
  const img = $c.nodeAfter;
  if (img && img.type.name === "image") {
    dispatch?.(state.tr.setSelection(NodeSelection.create(state.doc, $c.pos)).scrollIntoView());
    return true;
  }
  if ($c.parentOffset !== $c.parent.content.size) return false;
  const sib = siblingBlock(state, 1);
  if (!sib || !SELECT_BLOCKS.has(sib.node.type.name)) return false;
  if (dispatch) {
    let tr = state.tr;
    let pos = sib.pos;
    if ($c.parent.type.name === "paragraph" && $c.parent.content.size === 0) { tr = tr.delete($c.before(), $c.after()); pos = $c.before(); }
    dispatch(selectBlockTr(tr, pos));
  }
  return true;
}

/** Ctrl/Cmd+Enter: new paragraph after the current block (tables: new row, as before). */
export function modEnter(state: EditorState, dispatch: Dispatch): boolean {
  const sel = state.selection;
  if (isInTable(state) && !(sel instanceof NodeSelection)) return addRowAfter(state, dispatch);
  if (sel instanceof GapCursor) { if (!canParagraphAt(state.doc, sel.head)) return false; dispatch?.(paragraphAt(state.tr, sel.head)); return true; }
  if (sel instanceof NodeSelection && sel.node.isBlock) { dispatch?.(paragraphAfterTr(state, sel.from, sel.node.nodeSize)); return true; }
  const $h = sel.$head;
  if ($h.depth === 0) return false;
  // after the top-level block (a list, quote, …): Typora's "insert paragraph after"
  const end = $h.after(1);
  dispatch?.(paragraphAt(state.tr, end));
  return true;
}

/** Shift+Enter: soft line break inside a paragraph (saved as a single newline, like Typora). */
export function softBreak(state: EditorState, dispatch: Dispatch): boolean {
  const $h = state.selection.$head;
  const parent = $h.parent;
  if (!parent.isTextblock || parent.type.spec.code) return false;
  if (isInTable(state)) { dispatch?.(state.tr.replaceSelectionWith(state.schema.nodes.hard_break.create()).scrollIntoView()); return true; }
  if (parent.type.name === "heading") return splitBlock(state, dispatch);
  dispatch?.(state.tr.insertText("\n").scrollIntoView());
  return true;
}

export const blockKeys = {
  Backspace: backspace, Delete: del, "Mod-Backspace": backspace, "Mod-Delete": del,
};

/** Hover grip at the left of a block: one click selects the whole block (then Delete / Ctrl+X / Ctrl+C). */
class BlockHandle {
  el: HTMLButtonElement;
  target: { pos: number; dom: HTMLElement } | null = null;
  constructor(private view: EditorView) {
    this.el = document.createElement("button");
    this.el.type = "button";
    this.el.className = "mdn-block-handle";
    this.el.hidden = true;
    this.el.title = t("Select block (then Delete to remove)");
    this.el.setAttribute("aria-label", t("Select block"));
    this.el.innerHTML = `<svg width="14" height="14" viewBox="0 0 24 24" aria-hidden="true">${[6, 12, 18].map((y) => `<circle cx="9" cy="${y}" r="1.6" fill="currentColor"/><circle cx="15" cy="${y}" r="1.6" fill="currentColor"/>`).join("")}</svg>`;
    document.body.appendChild(this.el);
    this.el.addEventListener("mousedown", (e) => {
      e.preventDefault(); e.stopPropagation();
      const tg = this.target; if (!tg) return;
      const node = this.view.state.doc.nodeAt(tg.pos);
      if (!node) return;
      this.view.focus();
      this.view.dispatch(selectBlockTr(this.view.state.tr, tg.pos));
      this.view.focus();
      this.place();
    });
    this.el.addEventListener("contextmenu", (e) => e.preventDefault());
    view.dom.addEventListener("mousemove", this.onMove);
    view.dom.addEventListener("mouseleave", this.onLeave);
    window.addEventListener("scroll", this.onScroll, true);
  }
  onMove = (e: MouseEvent) => {
    if (!this.view.editable) return this.hide();
    const hit = this.findBlock(e.clientY);
    if (!hit) return this.hide();
    this.target = hit;
    this.place();
  };
  onLeave = (e: MouseEvent) => { if (e.relatedTarget !== this.el && !this.el.contains(e.relatedTarget as Node)) this.hide(); };
  onScroll = () => { if (!this.el.hidden) this.place(); };
  /** top-level block under the pointer row (whole width, so the gutter counts too) */
  findBlock(y: number): { pos: number; dom: HTMLElement } | null {
    const doc = this.view.state.doc;
    let pos = 0;
    for (let i = 0; i < doc.childCount; i++) {
      const n = doc.child(i);
      const dom = this.view.nodeDOM(pos) as HTMLElement | null;
      if (dom && dom.nodeType === 1) {
        const r = dom.getBoundingClientRect();
        if (y >= r.top - 2 && y <= r.bottom + 2) return HANDLE_BLOCKS.has(n.type.name) ? { pos, dom } : null;
      }
      pos += n.nodeSize;
    }
    return null;
  }
  place() {
    const tg = this.target;
    if (!tg || !tg.dom.isConnected) return this.hide();
    const r = tg.dom.getBoundingClientRect();
    const host = this.view.dom.getBoundingClientRect();
    const sel = this.view.state.selection;
    this.el.classList.toggle("on", sel instanceof NodeSelection && sel.from === tg.pos);
    this.el.style.top = Math.round(r.top + Math.min(6, Math.max(0, r.height / 2 - 11))) + "px";
    this.el.style.left = Math.round(Math.max(host.left - 30, Math.min(r.left, host.left) - 28)) + "px";
    this.el.hidden = false;
  }
  hide() { this.el.hidden = true; this.target = null; }
  update() { if (this.target) this.place(); }
  destroy() {
    this.el.remove();
    this.view.dom.removeEventListener("mousemove", this.onMove);
    this.view.dom.removeEventListener("mouseleave", this.onLeave);
    window.removeEventListener("scroll", this.onScroll, true);
  }
}

export function blockNavPlugin() {
  return new Plugin<boolean>({
    key: blockSelKey,
    state: {
      init: () => false,
      apply: (tr, prev) => {
        const m = tr.getMeta(blockSelKey);
        if (m !== undefined) return !!m;
        if (tr.selectionSet) return false;
        return prev && tr.selection instanceof NodeSelection;
      },
    },
    props: {
      attributes: (state): Record<string, string> => (quietBlockSelection(state) ? { class: "mdn-has-block-sel" } : {}),
    },
    view: (v) => new BlockHandle(v),
  });
}
