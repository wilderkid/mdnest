// Floating table toolbar: rows/columns, column alignment, delete table.
import { Plugin, EditorState } from "prosemirror-state";
import { EditorView } from "prosemirror-view";
import { addRowBefore, addRowAfter, deleteRow, addColumnBefore, addColumnAfter, deleteColumn, deleteTable, isInTable, selectedRect } from "prosemirror-tables";
import { schema } from "./schema";

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

const BUTTONS: [string, string, string][] = [
  ["row-above", "↥ Row", "Insert row above"], ["row-below", "↧ Row", "Insert row below"], ["row-del", "✕ Row", "Delete row"],
  ["col-left", "↤ Col", "Insert column left"], ["col-right", "↦ Col", "Insert column right"], ["col-del", "✕ Col", "Delete column"],
  ["align-left", "⟸", "Align column left"], ["align-center", "≡", "Align column center"], ["align-right", "⟹", "Align column right"],
  ["table-del", "🗑", "Delete table"],
];
const COMMANDS: Record<string, any> = {
  "row-above": addRowBefore, "row-below": addRowAfter, "row-del": deleteRow,
  "col-left": addColumnBefore, "col-right": addColumnAfter, "col-del": deleteColumn,
  "align-left": setColumnAlign("left"), "align-center": setColumnAlign("center"), "align-right": setColumnAlign("right"),
  "table-del": deleteTable,
};

export function tableToolbarPlugin() {
  return new Plugin({
    view(view: EditorView) {
      const bar = document.createElement("div");
      bar.id = "mdn-table-tools"; bar.className = "md-table-edit mdn-toolbar"; bar.style.display = "none";
      bar.innerHTML = BUTTONS.map(([id, label, title]) => `<button data-cmd="${id}" title="${title}">${label}</button>`).join("");
      bar.addEventListener("mousedown", (e) => {
        e.preventDefault();
        const btn = (e.target as HTMLElement).closest("button"); if (!btn) return;
        COMMANDS[btn.dataset.cmd!](view.state, view.dispatch); view.focus();
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
