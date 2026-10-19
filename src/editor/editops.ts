// Paragraph / format operations used by menus, the toolbar and the editor context menu.
import { EditorState, NodeSelection, TextSelection, Transaction } from "prosemirror-state";
import { DOMSerializer } from "prosemirror-model";
import { EditorView } from "prosemirror-view";
import { setBlockType, toggleMark } from "prosemirror-commands";
import { liftListItem, sinkListItem, wrapInList } from "prosemirror-schema-list";
import { schema } from "./schema";
import { selectionMarkdown, plainBetween } from "./insertmd";
import { collapseAll } from "./markers";
import { serializeMarkdown } from "./markdown";

type Cmd = (state: EditorState, dispatch?: (tr: Transaction) => void, view?: EditorView) => boolean;

export function increaseHeading(): Cmd {
  return (state, dispatch) => {
    const { $from } = state.selection;
    const parent = $from.parent;
    if (parent.type === schema.nodes.heading) {
      const level = Math.max(1, parent.attrs.level - 1);
      if (level === parent.attrs.level) return true;
      return setBlockType(schema.nodes.heading, { level })(state, dispatch);
    }
    return setBlockType(schema.nodes.heading, { level: 1 })(state, dispatch);
  };
}

export function decreaseHeading(): Cmd {
  return (state, dispatch) => {
    const parent = state.selection.$from.parent;
    if (parent.type !== schema.nodes.heading) return false;
    // One step toward body text: h1 becomes a paragraph. Deeper headings step down one level.
    if (parent.attrs.level <= 1) return setBlockType(schema.nodes.paragraph)(state, dispatch);
    return setBlockType(schema.nodes.heading, { level: parent.attrs.level + 1 })(state, dispatch);
  };
}

export function toggleTaskList(): Cmd {
  return (state, dispatch) => {
    const { $from } = state.selection;
    for (let d = $from.depth; d > 0; d--) {
      const n = $from.node(d);
      if (n.type === schema.nodes.list_item) {
        if (!dispatch) return true;
        const checked = n.attrs.checked === null ? false : null;
        dispatch(state.tr.setNodeMarkup($from.before(d), undefined, { ...n.attrs, checked }));
        return true;
      }
    }
    return wrapInList(schema.nodes.bullet_list)(state, (tr) => {
      if (!dispatch) return;
      const $p = tr.selection.$from;
      for (let d = $p.depth; d > 0; d--) {
        if ($p.node(d).type === schema.nodes.list_item) {
          tr.setNodeMarkup($p.before(d), undefined, { checked: false });
          break;
        }
      }
      dispatch(tr);
    });
  };
}

export function clearFormat(): Cmd {
  return (state, dispatch) => {
    const { from, to, empty, $from } = state.selection;
    if (!dispatch) return true;
    let tr = state.tr;
    if (!empty) {
      for (const name of Object.keys(schema.marks)) tr = tr.removeMark(from, to, schema.marks[name]);
    } else {
      tr = tr.setStoredMarks([]);
    }
    if ($from.parent.type === schema.nodes.heading) tr = tr.setBlockType($from.before(), $from.after(), schema.nodes.paragraph);
    dispatch(tr);
    return true;
  };
}

export function selectLine(): Cmd {
  return (state, dispatch) => {
    const { $from } = state.selection;
    if (!$from.parent.isTextblock) return false;
    if (dispatch) {
      const start = $from.start();
      const end = $from.end();
      dispatch(state.tr.setSelection(TextSelection.create(state.doc, start, end)));
    }
    return true;
  };
}

export function selectWord(): Cmd {
  return (state, dispatch) => {
    const { $from } = state.selection;
    if (!$from.parent.isTextblock) return false;
    const text = $from.parent.textContent;
    let off = $from.parentOffset;
    const isWord = (ch: string) => /[\p{L}\p{N}_'-]/u.test(ch);
    // A caret on a boundary belongs to the word on its left (end of "alpha| beta"),
    // except at the very start of the block, which belongs to the first word.
    if (off === 0 && text.length && isWord(text[0])) { /* keep */ }
    else if (off > 0 && (off >= text.length || !isWord(text[off])) && isWord(text[off - 1])) off--;
    let a = off, b = off;
    while (a > 0 && isWord(text[a - 1])) a--;
    while (b < text.length && isWord(text[b])) b++;
    if (a === b) { if (b < text.length) b++; else if (a > 0) a--; }
    if (dispatch) dispatch(state.tr.setSelection(TextSelection.create(state.doc, $from.start() + a, $from.start() + b)));
    return true;
  };
}

export function selectStyledScope(): Cmd {
  return (state, dispatch) => {
    const { $from, from, to } = state.selection;
    const marks = $from.marks();
    if (!marks.length) return selectLine()(state, dispatch);
    const mark = marks[marks.length - 1];
    let a = from, b = Math.max(from, to);
    const parent = $from.parent;
    const start = $from.start();
    parent.forEach((node, offset) => {
      const nFrom = start + offset;
      const nTo = nFrom + node.nodeSize;
      if (nTo < from || nFrom > to) return;
      if (mark.isInSet(node.marks)) {
        a = Math.min(a, nFrom);
        b = Math.max(b, nTo);
      }
    });
    // expand across adjacent text nodes that share the mark
    let changed = true;
    while (changed) {
      changed = false;
      parent.forEach((node, offset) => {
        const nFrom = start + offset;
        const nTo = nFrom + node.nodeSize;
        if (nTo === a || nFrom === b) {
          if (mark.isInSet(node.marks)) {
            a = Math.min(a, nFrom);
            b = Math.max(b, nTo);
            changed = true;
          }
        }
      });
    }
    if (dispatch) dispatch(state.tr.setSelection(TextSelection.create(state.doc, a, b)));
    return true;
  };
}

function topRange(state: EditorState): { from: number; to: number } | null {
  const { $from } = state.selection;
  if (!$from.depth) return null;
  return { from: $from.before(1), to: $from.after(1) };
}

export function insertParagraphBefore(): Cmd {
  return (state, dispatch) => {
    const r = topRange(state);
    if (!r) return false;
    if (dispatch) {
      const para = schema.nodes.paragraph.create();
      const tr = state.tr.insert(r.from, para);
      dispatch(tr.setSelection(TextSelection.create(tr.doc, r.from + 1)).scrollIntoView());
    }
    return true;
  };
}

export function insertParagraphAfter(): Cmd {
  return (state, dispatch) => {
    const r = topRange(state);
    if (!r) return false;
    if (dispatch) {
      const para = schema.nodes.paragraph.create();
      const tr = state.tr.insert(r.to, para);
      dispatch(tr.setSelection(TextSelection.create(tr.doc, r.to + 1)).scrollIntoView());
    }
    return true;
  };
}

export function deleteBlock(): Cmd {
  return (state, dispatch) => {
    const r = topRange(state);
    if (!r) return false;
    if (dispatch) {
      let tr = state.tr.delete(r.from, r.to);
      if (!tr.doc.childCount) tr = tr.insert(0, schema.nodes.paragraph.create());
      const pos = Math.min(r.from + 1, tr.doc.content.size);
      try { tr.setSelection(TextSelection.near(tr.doc.resolve(Math.max(1, pos)))); } catch { /* empty */ }
      dispatch(tr.scrollIntoView());
    }
    return true;
  };
}

export function jumpTop(): Cmd {
  return (state, dispatch) => {
    if (dispatch) dispatch(state.tr.setSelection(TextSelection.create(state.doc, 1)).scrollIntoView());
    return true;
  };
}

export function jumpBottom(): Cmd {
  return (state, dispatch) => {
    if (dispatch) {
      const pos = Math.max(1, state.doc.content.size - 1);
      dispatch(state.tr.setSelection(TextSelection.near(state.doc.resolve(pos), -1)).scrollIntoView());
    }
    return true;
  };
}

export function deleteSelection(): Cmd {
  return (state, dispatch) => {
    if (state.selection.empty) return false;
    if (dispatch) dispatch(state.tr.deleteSelection());
    return true;
  };
}

export function selectionHtml(state: EditorState): string {
  const { from, to, empty } = state.selection;
  const slice = empty ? state.doc.slice(0, state.doc.content.size) : state.doc.slice(from, to);
  const serializer = DOMSerializer.fromSchema(schema);
  const div = document.createElement("div");
  div.appendChild(serializer.serializeFragment(slice.content));
  return div.innerHTML;
}

export function copyMarkdownText(state: EditorState): string {
  const { from, to, empty } = state.selection;
  if (empty) return serializeMarkdown(collapseAll(state.doc));
  return selectionMarkdown(state, from, to);
}

export function copyPlainText(state: EditorState): string {
  const { from, to, empty } = state.selection;
  if (empty) return state.doc.textBetween(0, state.doc.content.size, "\n", "\n");
  return plainBetween(state, from, to);
}

export function linkAt(state: EditorState): { href: string; from: number; to: number } | null {
  const { $from, from, to } = state.selection;
  const mark = $from.marks().find((m) => m.type === schema.marks.link) ?? state.storedMarks?.find((m) => m.type === schema.marks.link);
  if (!mark) return null;
  let a = from, b = Math.max(from, to);
  const parent = $from.parent;
  const start = $from.start();
  parent.forEach((node, offset) => {
    const nFrom = start + offset, nTo = nFrom + node.nodeSize;
    if (mark.isInSet(node.marks) && nTo >= a - 1 && nFrom <= b + 1) {
      if (nTo >= from - node.nodeSize && nFrom <= to + node.nodeSize) {
        a = Math.min(a, nFrom); b = Math.max(b, nTo);
      }
    }
  });
  return { href: mark.attrs.href || "", from: a, to: b };
}

export function imageSelection(state: EditorState): { pos: number; src: string } | null {
  const sel = state.selection;
  if (sel instanceof NodeSelection && sel.node.type === schema.nodes.image) {
    return { pos: sel.from, src: sel.node.attrs.src };
  }
  return null;
}

export function setImageZoom(percent: number): Cmd {
  return (state, dispatch) => {
    const img = imageSelection(state);
    if (!img) return false;
    if (dispatch) {
      const node = state.doc.nodeAt(img.pos)!;
      dispatch(state.tr.setNodeMarkup(img.pos, undefined, { ...node.attrs, zoom: String(percent) }));
    }
    return true;
  };
}

export function deleteImage(): Cmd {
  return (state, dispatch) => {
    const img = imageSelection(state);
    if (!img) return false;
    if (dispatch) dispatch(state.tr.delete(img.pos, img.pos + state.doc.nodeAt(img.pos)!.nodeSize));
    return true;
  };
}

export { liftListItem, sinkListItem };
