import { EditorState, Plugin, PluginKey, NodeSelection } from "prosemirror-state";
import { EditorView, DecorationSet } from "prosemirror-view";
import { history } from "prosemirror-history";
import { dropCursor } from "prosemirror-dropcursor";
import { gapCursor } from "prosemirror-gapcursor";
import { tableEditing, columnResizing } from "prosemirror-tables";
import { schema } from "./schema";
import { parseMarkdown, serializeMarkdown } from "./markdown";
import { revealPlugin } from "./reveal";
import { nodeViews, tocViews } from "./views";
import { buildInputRules, buildKeymaps } from "./rules";
import type { DecorationProvider } from "../plugins/api";

export interface EditorHooks {
  onChange: () => void;
  keys: Parameters<typeof buildKeymaps>[1];
  decorationProviders: DecorationProvider[];
}

const extKey = new PluginKey("ext-decos");
function externalDecorations(hooks: EditorHooks) {
  return new Plugin({
    key: extKey,
    props: {
      decorations(state) {
        const sets = hooks.decorationProviders.map((p) => { try { return p(state); } catch (e) { console.error(e); return null; } }).filter(Boolean) as DecorationSet[];
        if (!sets.length) return null;
        // merge: collect all decorations
        const all = sets.flatMap((s) => s.find());
        return DecorationSet.create(state.doc, all);
      },
    },
  });
}

export function createEditor(mount: HTMLElement, markdown: string, hooks: EditorHooks) {
  const plugins = [
    buildInputRules(schema), ...buildKeymaps(schema, hooks.keys), history(), dropCursor(), gapCursor(),
    columnResizing(), tableEditing(), revealPlugin(), externalDecorations(hooks),
  ];
  const mkState = (md: string) => EditorState.create({ doc: parseMarkdown(md), plugins });
  const view = new EditorView({ mount }, {
    state: mkState(markdown),
    nodeViews: nodeViews() as any,
    attributes: { id: "write", class: "", spellcheck: "false" },
    dispatchTransaction(tr) {
      const st = view.state.apply(tr);
      view.updateState(st);
      if (tr.docChanged) { tocViews.forEach((t) => (t.dom.isConnected ? t.refresh(st.doc) : tocViews.delete(t))); hooks.onChange(); }
    },
    handleClickOn(view, _pos, node, nodePos, event) {
      const t = event.target as HTMLElement;
      if (node.type.name === "list_item" && t.tagName === "INPUT" && node.attrs.checked !== null) {
        view.dispatch(view.state.tr.setNodeMarkup(nodePos, undefined, { checked: !node.attrs.checked }));
        return true;
      }
      if (node.type.name === "image") { view.dispatch(view.state.tr.setSelection(NodeSelection.create(view.state.doc, nodePos))); return true; }
      return false;
    },
    handleDOMEvents: {
      click(_v, e) {
        const a = (e.target as HTMLElement).closest("a[href]") as HTMLAnchorElement | null;
        if (a && (e.ctrlKey || e.metaKey)) { window.open(a.href, "_blank"); e.preventDefault(); return true; }
        return false;
      },
    },
  });
  // Typora-compatible wrapper: <content><div id="write">…
  return {
    view,
    getMarkdown: () => serializeMarkdown(view.state.doc),
    setMarkdown: (md: string) => { view.updateState(mkState(md)); tocViews.forEach((t) => t.dom.isConnected ? t.refresh(view.state.doc) : tocViews.delete(t)); },
    refreshDecorations: () => view.dispatch(view.state.tr.setMeta("refresh", true)),
  };
}
export type Editor = ReturnType<typeof createEditor>;
