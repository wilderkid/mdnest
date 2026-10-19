// Floating table toolbar: rows/columns, column alignment, delete table.
import { Plugin, EditorState } from "prosemirror-state";
import { EditorView } from "prosemirror-view";
import { addRowBefore, addRowAfter, deleteRow, addColumnBefore, addColumnAfter, deleteColumn, deleteTable, isInTable, selectedRect, moveTableRow, moveTableColumn } from "prosemirror-tables";
import { schema } from "./schema";
import { serializeMarkdown } from "./markdown";

export function setColumnAlign(align: "left" | "center" | "right" | null) {
  return (state: EditorState, dispatch?: (tr: any) => void) => {
    if (!isInTable(state)) return false;
    if (dispatch) {
      const rect = selectedRect(state); const tr = state.tr;
      for (let col = rect.left; col < rect.right; col++)
        for (let row = 0; row < rect.map.height; row++) {
          const pos = rect.tableStart + rect.map.map[row * rect.map.width + col];
          const cell = tr.doc.nodeAt(pos)!;
          tr.setNodeMarkup(pos, undefined, { ...cell.attrs, align });
        }
      dispatch(tr);
    }
    return true;
  };
}

export function insertTable(rows = 3, cols = 3) {
  return (state: EditorState, dispatch?: (tr: any) => void) => {
    const { table, table_row, table_header, table_cell, paragraph } = schema.nodes;
    const mkRow = (cell: any) => table_row.create(null, Array.from({ length: cols }, () => cell.create()));
    const t = table.create(null, [mkRow(table_header), ...Array.from({ length: rows - 1 }, () => mkRow(table_cell))]);
    if (dispatch) {
      const { $from } = state.selection;
      const at = $from.depth > 0 ? $from.after(1) : state.selection.from;
      const tr = state.tr.insert(at, [t, paragraph.create()]);
      dispatch(tr.scrollIntoView());
    }
    return true;
  };
}

export function moveRow(dir: -1 | 1) {
  return (state: EditorState, dispatch?: (tr: any) => void) => {
    if (!isInTable(state)) return false;
    const rect = selectedRect(state);
    const from = rect.top;
    const to = from + dir;
    if (to < 0 || to >= rect.map.height) return false;
    return moveTableRow({ from, to })(state, dispatch);
  };
}

export function moveColumn(dir: -1 | 1) {
  return (state: EditorState, dispatch?: (tr: any) => void) => {
    if (!isInTable(state)) return false;
    const rect = selectedRect(state);
    const from = rect.left;
    const to = from + dir;
    if (to < 0 || to >= rect.map.width) return false;
    return moveTableColumn({ from, to })(state, dispatch);
  };
}

/** Markdown of the table that contains the selection. */
export function tableMarkdown(state: EditorState): string | null {
  if (!isInTable(state)) return null;
  const rect = selectedRect(state);
  const pos = rect.tableStart - 1;
  const node = state.doc.nodeAt(pos);
  if (!node) return null;
  const doc = schema.nodes.doc.create(null, [node, schema.nodes.paragraph.create()]);
  const md = serializeMarkdown(doc);
  return md.replace(/\n+$/, "");
}

export function copyTable(write: (text: string) => void) {
  return (state: EditorState) => {
    const md = tableMarkdown(state);
    if (md == null) return false;
    write(md);
    return true;
  };
}

const BUTTONS: [string, string, string][] = [
  ["row-above", "↥ Row", "Insert row above"], ["row-below", "↧ Row", "Insert row below"], ["row-del", "✕ Row", "Delete row"],
  ["col-left", "↤ Col", "Insert column left"], ["col-right", "↦ Col", "Insert column right"], ["col-del", "✕ Col", "Delete column"],
  ["align-left", "⟸", "Align column left"], ["align-center", "≡", "Align column center"], ["align-right", "⟹", "Align column right"],
  ["more", "…", "More table commands"],
  ["table-del", "🗑", "Delete table"],
];
const MORE: [string, string][] = [
  ["row-above", "Add Row Above"], ["row-below", "Add Row Below"],
  ["col-left", "Add Column Before"], ["col-right", "Add Column After"],
  ["row-del", "Delete Row"], ["col-del", "Delete Column"],
  ["row-up", "Move Row Up"], ["row-down", "Move Row Down"],
  ["col-left-move", "Move Column Left"], ["col-right-move", "Move Column Right"],
  ["align-left", "Align Left"], ["align-center", "Align Center"], ["align-right", "Align Right"],
  ["copy", "Copy Table"],
  ["table-del", "Delete Table"],
];
const COMMANDS: Record<string, any> = {
  "row-above": addRowBefore, "row-below": addRowAfter, "row-del": deleteRow,
  "col-left": addColumnBefore, "col-right": addColumnAfter, "col-del": deleteColumn,
  "align-left": setColumnAlign("left"), "align-center": setColumnAlign("center"), "align-right": setColumnAlign("right"),
  "row-up": moveRow(-1), "row-down": moveRow(1),
  "col-left-move": moveColumn(-1), "col-right-move": moveColumn(1),
  "table-del": deleteTable,
};

export function tableToolbarPlugin() {
  return new Plugin({
    view(view: EditorView) {
      const bar = document.createElement("div");
      bar.id = "mdn-table-tools"; bar.className = "md-table-edit mdn-toolbar"; bar.style.display = "none";
      bar.innerHTML = BUTTONS.map(([id, label, title]) => `<button data-cmd="${id}" title="${title}">${label}</button>`).join("");
      const more = document.createElement("div");
      more.className = "context-menu dropdown-menu mdn-table-more";
      more.hidden = true;
      more.innerHTML = MORE.map(([id, label]) => `<button type="button" class="mdn-menu-item" data-cmd="${id}">${label}</button>`).join("");
      bar.appendChild(more);
      const run = (id: string) => {
        if (id === "more") {
          more.hidden = !more.hidden;
          return;
        }
        more.hidden = true;
        if (id === "copy") {
          const md = tableMarkdown(view.state);
          if (md) navigator.clipboard.writeText(md).catch(() => {});
          return;
        }
        const cmd = COMMANDS[id];
        if (cmd) cmd(view.state, view.dispatch);
        view.focus();
      };
      bar.addEventListener("mousedown", (e) => {
        const btn = (e.target as HTMLElement).closest("button"); if (!btn || !bar.contains(btn)) return;
        e.preventDefault();
        run(btn.dataset.cmd || "");
      });
      const host = view.dom.parentElement!; // <content> scroll container
      host.appendChild(bar);
      const update = () => {
        const st = view.state;
        if (!isInTable(st) || !view.editable) { bar.style.display = "none"; return; }
        const rect = selectedRect(st);
        const tableDom = view.nodeDOM(rect.tableStart - 1) as HTMLElement | null;
        const el = tableDom?.closest?.("table") ?? tableDom?.querySelector?.("table") ?? tableDom;
        if (!el) { bar.style.display = "none"; return; }
        const align = rect.table.child(0).child(Math.min(rect.left, rect.table.child(0).childCount - 1)).attrs.align;
        bar.querySelectorAll<HTMLElement>("[data-cmd^=align]").forEach((b) => b.classList.toggle("active", b.dataset.cmd === "align-" + align));
        bar.style.display = "flex";
        const hr = host.getBoundingClientRect(), tr = el.getBoundingClientRect();
        bar.style.left = Math.max(4, tr.left - hr.left + host.scrollLeft) + "px";
        bar.style.top = Math.max(4, tr.top - hr.top + host.scrollTop - bar.offsetHeight - 6) + "px";
      };
      return { update, destroy: () => bar.remove() };
    },
  });
}
