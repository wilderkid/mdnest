// Enter-key block shortcuts. Kept out of rules.ts so unit tests can import it without CodeMirror.
import { EditorState, TextSelection, Transaction } from "prosemirror-state";

/** `| a | b |` → header cells. Returns null when it is not a header row. */
export function tableCells(text: string): string[] | null {
  if (!/^\|.+\|$/.test(text.trim())) return null;
  const inner = text.trim().replace(/^\|/, "").replace(/\|$/, "");
  const cells = inner.split("|").map((c) => c.trim());
  if (cells.length < 2 || cells.some((c) => c === "")) return null;
  if (cells.every((c) => /^:?-+:?$/.test(c))) return null;
  return cells;
}

/**
 * Enter on a paragraph that is only a block shortcut. Input rules never see the newline,
 * so this runs from the Enter keymap before the block is split.
 */
export function blockEnterRule(state: EditorState, dispatch?: (tr: Transaction) => void): boolean {
  const { $from } = state.selection;
  if (!$from.parent.isTextblock || $from.parent.type.spec.code || $from.parent.type.name !== "paragraph") return false;
  const text = $from.parent.textContent;
  const n = state.schema.nodes;
  const start = $from.before();
  const end = $from.after();
  const replace = (node: any, extra?: any) => {
    if (dispatch) {
      const nodes = extra ? [node, extra] : [node];
      // A code/atom block cannot hold the caret. Follow it with an empty paragraph.
      if (!extra && node.type?.spec?.code) nodes.push(n.paragraph.create());
      if (!extra && node.isAtom) nodes.push(n.paragraph.create());
      const tr = state.tr.replaceWith(start, end, nodes);
      const pos = Math.min(tr.doc.content.size - 1, Math.max(1, start + 1));
      try { tr.setSelection(TextSelection.near(tr.doc.resolve(pos))); } catch { /* default */ }
      dispatch(tr.scrollIntoView());
    }
    return true;
  };
  const fence = /^```([^\s`]*)$/.exec(text);
  if (fence) return replace(n.code_block.create({ params: fence[1] || "" }));
  if (text === "$$") return replace(n.math_block.create());
  if (/^\[TOC\]$/i.test(text)) return replace(n.toc.create(), n.paragraph.create());
  if (text === "---") {
    const first = $from.index(0) === 0 && state.doc.firstChild?.type.name !== "front_matter";
    if (first) return replace(n.front_matter.create());
    return replace(n.horizontal_rule.create());
  }
  const cells = tableCells(text);
  if (cells) {
    const header = n.table_row.create(null, cells.map((c) => n.table_header.create(null, state.schema.text(c))));
    const empty = n.table_row.create(null, cells.map(() => n.table_cell.create()));
    return replace(n.table.create(null, [header, empty]), n.paragraph.create());
  }
  return false;
}

export function taskListFromParagraph(state: EditorState, match: RegExpMatchArray, start: number, _end: number): Transaction | null {
  const n = state.schema.nodes;
  const $s = state.doc.resolve(start);
  for (let d = $s.depth; d > 0; d--) if ($s.node(d).type === n.list_item) {
    return state.tr.delete(start, _end).setNodeMarkup($s.before(d), undefined, { checked: match[1] === "x" });
  }
  if ($s.parent.type !== n.paragraph || $s.parentOffset !== 0) return null;
  const checked = match[1] === "x";
  const item = n.list_item.create({ checked }, n.paragraph.create());
  const list = n.bullet_list.create(null, item);
  return state.tr.replaceWith($s.before(), $s.after(), list);
}
