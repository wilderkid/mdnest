import { EditorState, Plugin, PluginKey, NodeSelection, TextSelection } from "prosemirror-state";
import { EditorView, DecorationSet } from "prosemirror-view";
import { history } from "prosemirror-history";
import { dropCursor } from "prosemirror-dropcursor";
import { gapCursor } from "prosemirror-gapcursor";
import { tableEditing, columnResizing } from "prosemirror-tables";
import { schema } from "./schema";
import { parseMarkdown, serializeMarkdown } from "./markdown";
import { revealPlugin } from "./reveal";
import { markersPlugin, collapseAll } from "./markers";
import { defsPlugin, defsKeymap } from "./defs";
import { tableToolbarPlugin } from "./tabletools";
import { searchPlugin } from "./search";
import { nodeViews, tocViews } from "./views";
import { collectImages, imagesFromPastedHtml, pastedHtmlIsOnlyImages, type ImageItem } from "../shell/images";
import { buildInputRules, buildKeymaps } from "./rules";
import type { DecorationProvider } from "../plugins/api";

export interface EditorHooks {
  onChange: () => void;
  keys: Parameters<typeof buildKeymaps>[1];
  decorationProviders: DecorationProvider[];
  /** pasted / dropped image files; return true when handled */
  onImageFiles?: (files: ImageItem[], pos: number | null) => boolean;
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
    markersPlugin(), // first: its keydown hook syncs a stale post-click selection before keymaps run
    defsPlugin(), defsKeymap(),
    buildInputRules(schema), ...buildKeymaps(schema, hooks.keys), history(), dropCursor(), gapCursor(),
    columnResizing(), tableEditing(), revealPlugin(), tableToolbarPlugin(), searchPlugin(), externalDecorations(hooks),
  ];
  const mkState = (md: string) => {
    const doc = parseMarkdown(md);
    // start the caret in the first prose textblock (not inside front matter / a code node view,
    // which would hand focus to CodeMirror)
    let pos = -1;
    doc.descendants((n, p) => { if (pos >= 0) return false; if (n.isTextblock && !n.type.spec.code) { pos = p + 1; return false; } return true; });
    const selection = pos >= 0 ? TextSelection.create(doc, pos) : undefined;
    return EditorState.create({ doc, plugins, selection });
  };
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
    handlePaste(view, event, slice) {
      // WebKitGTK: the paste event carries no clipboardData, so ProseMirror captures the native paste in
      // a hidden element and hands us a slice holding <img src="blob:…">. Import those bytes instead.
      // a file copied in a file manager (text/uri-list / gnome-copied-files) can likewise reach us only as
      // pasted text "file:///…": import the image files instead of inserting their URIs
      // (WebKitGTK turns a text/uri-list clipboard into links: [/path/x.png](file:///path/x.png))
      const uris: string[] = []; let plain = false;
      slice.content.descendants((n) => {
        if (!n.isText || !n.text!.trim()) return true;
        const l = n.marks.find((m) => m.type.name === "link" && /^file:\/\//i.test(m.attrs.href));
        if (l) { if (uris[uris.length - 1] !== l.attrs.href) uris.push(l.attrs.href); }
        else if (/^\s*(file:\/\/\S+\s*)+$/i.test(n.text!)) uris.push(...n.text!.trim().split(/\s+/));
        else plain = true;
        return true;
      });
      if (hooks.onImageFiles && uris.length && !plain) {
        const dt = new DataTransfer(); dt.setData("text/plain", uris.join("\n"));
        const items = collectImages(dt);
        if (items.length) { hooks.onImageFiles(items, view.state.selection.from); return true; }
      }
      const srcs: string[] = []; let other = false;
      slice.content.descendants((n) => { if (n.type.name === "image") { if (/^(blob|data):/i.test(n.attrs.src)) srcs.push(n.attrs.src); else other = true; } else if (n.isText && n.text!.trim()) other = true; return true; });
      if (srcs.length && !other && hooks.onImageFiles && !(event.clipboardData?.files?.length)) {
        const pos = view.state.selection.from;
        imagesFromPastedHtml(srcs.map((s) => `<img src="${s.replace(/"/g, "&quot;")}">`).join("")).then((f) => { if (f.length) hooks.onImageFiles!(f, pos); });
        return true;
      }
      const files = collectImages(event.clipboardData);
      if (files.length && hooks.onImageFiles) { event.preventDefault(); return hooks.onImageFiles(files, null); }
      // WebKitGTK: a clipboard image arrives as <img src="blob:…"> HTML only
      const html = event.clipboardData?.getData("text/html") ?? "";
      if (hooks.onImageFiles && pastedHtmlIsOnlyImages(html)) {
        event.preventDefault();
        const pos = view.state.selection.from;
        imagesFromPastedHtml(html).then((f) => { if (f.length) hooks.onImageFiles!(f, pos); });
        return true;
      }
      return false;
    },
    handleDrop(view, event) {
      const files = collectImages((event as DragEvent).dataTransfer);
      if (!files.length || !hooks.onImageFiles) return false;
      const p = view.posAtCoords({ left: (event as DragEvent).clientX, top: (event as DragEvent).clientY });
      event.preventDefault();
      return hooks.onImageFiles(files, p ? p.pos : null);
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
    getMarkdown: () => serializeMarkdown(collapseAll(view.state.doc)),
    getDoc: () => collapseAll(view.state.doc),
    setMarkdown: (md: string) => { view.updateState(mkState(md)); tocViews.forEach((t) => t.dom.isConnected ? t.refresh(view.state.doc) : tocViews.delete(t)); },
    refreshDecorations: () => view.dispatch(view.state.tr.setMeta("refresh", true)),
  };
}
export type Editor = ReturnType<typeof createEditor>;
