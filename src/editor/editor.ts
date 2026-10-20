import { EditorState, Plugin, PluginKey, NodeSelection, TextSelection } from "prosemirror-state";
import { EditorView, DecorationSet } from "prosemirror-view";
import { Fragment, Node as PMNode, Slice } from "prosemirror-model";
import { history } from "prosemirror-history";
import { dropCursor } from "prosemirror-dropcursor";
import { gapCursor } from "prosemirror-gapcursor";
import { tableEditing, columnResizing } from "prosemirror-tables";
import { schema } from "./schema";
import { parseMarkdown, serializeMarkdown } from "./markdown";
import { revealPlugin } from "./reveal";
import { headingSrcPlugin, markPristine } from "./headingsrc";
import { markersPlugin, collapseAll } from "./markers";
import { defsPlugin, defsKeymap } from "./defs";
import { tableToolbarPlugin } from "./tabletools";
import { searchPlugin } from "./search";
import { nodeViews, tocViews } from "./views";
import { collectImages, imagesFromPastedHtml, pastedHtmlIsOnlyImages, type ImageItem } from "../shell/images";
import { buildInputRules, buildKeymaps } from "./rules";
import { autoPairPlugin, skipAutoCloser } from "./autopair";
import { smartPunctPlugin } from "./smartpunct";
import { spellcheckOn } from "./spellcheck";
import { emojiPlugin } from "./emoji";
import type { Command, DecorationProvider } from "../plugins/api";
import { suggestPlugin } from "./suggest";
import { slashPlugin, slashItems, registerSlashItem } from "./slash";
import { liveCommandKeymap } from "./plugin-keys";
import { blockNavPlugin } from "./blocknav";
import { imageToolsPlugin } from "./imagetools";

export interface EditorHooks {
  onChange: () => void;
  keys: Parameters<typeof buildKeymaps>[1];
  decorationProviders: DecorationProvider[];
  /** Plugin commands whose `key` is bound in the editor keymap. Read on each keydown. */
  commands?: () => Command[];
  /** pasted / dropped image files; return true when handled */
  onImageFiles?: (files: ImageItem[], pos: number | null) => boolean;
  /** Caret moved (selection-only transaction). */
  onSelect?: () => void;
}

let foreignHtml = false;
function collapseNewlines(frag: Fragment): Fragment {
  const out: PMNode[] = [];
  frag.forEach((n) => {
    if (n.isText) out.push(/\n/.test(n.text!) ? n.type.schema.text(n.text!.replace(/[ \t]*\n[ \t]*/g, " "), n.marks) : n);
    else if (n.type.spec.code || n.type.name === "html_block") out.push(n);
    else out.push(n.copy(collapseNewlines(n.content)));
  });
  return Fragment.from(out);
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
    suggestPlugin(), // before keymaps so Accept (Mod-Enter) / Reject (Escape) win while a suggestion is open
    slashPlugin(),
    liveCommandKeymap(() => hooks.commands?.() ?? []),
    defsPlugin(), defsKeymap(),
    autoPairPlugin(), smartPunctPlugin(), emojiPlugin(), buildInputRules(schema), ...buildKeymaps(schema, hooks.keys), history(), dropCursor(), blockNavPlugin(), gapCursor(),
    columnResizing(), tableEditing({ allowTableNodeSelection: true }), revealPlugin(), headingSrcPlugin(), tableToolbarPlugin(), imageToolsPlugin(), searchPlugin(), externalDecorations(hooks),
  ];
  const mkState = (md: string) => {
    const doc = parseMarkdown(md);
    // start the caret in the first prose textblock (not inside front matter / a code node view,
    // which would hand focus to CodeMirror)
    let pos = -1;
    doc.descendants((n, p) => { if (pos >= 0) return false; if (n.isTextblock && !n.type.spec.code) { pos = p + 1; return false; } return true; });
    const selection = pos >= 0 ? TextSelection.create(doc, pos) : undefined;
    const st = EditorState.create({ doc, plugins, selection });
    markPristine(st); // a freshly loaded document reveals no Markdown source until the user clicks/types
    return st;
  };
  const view = new EditorView({ mount }, {
    state: mkState(markdown),
    nodeViews: nodeViews() as any,
    attributes: { id: "write", class: "", spellcheck: spellcheckOn() ? "true" : "false" },
    dispatchTransaction(tr) {
      const st = view.state.apply(tr);
      view.updateState(st);
      if (tr.docChanged) { tocViews.forEach((t) => (t.dom.isConnected ? t.refresh(st.doc) : tocViews.delete(t))); hooks.onChange(); }
      else if (tr.selectionSet) hooks.onSelect?.();
    },
    handleClickOn(view, _pos, node, nodePos, event) {
      const t = event.target as HTMLElement;
      if (!editorEditable(view) && event.button === 0 && t.tagName !== "A") return true;
      if (node.type.name === "list_item" && t.tagName === "INPUT" && node.attrs.checked !== null) {
        if (!view.editable) return true;
        view.dispatch(view.state.tr.setNodeMarkup(nodePos, undefined, { checked: !node.attrs.checked }));
        return true;
      }
      if (node.type.name === "image") { view.dispatch(view.state.tr.setSelection(NodeSelection.create(view.state.doc, nodePos))); return true; }
      return false;
    },
    // A selected block (code, math, table, HTML…) copies as its Markdown source
    clipboardTextSerializer(slice, view) {
      const sel = view.state.selection;
      if (sel instanceof NodeSelection && sel.node.isBlock) {
        try { return serializeMarkdown(schema.node("doc", null, [sel.node])).replace(/\n+$/, "\n"); } catch { /* fall through */ }
      }
      if (sel instanceof NodeSelection && sel.node.type.name === "image") {
        try { return serializeMarkdown(schema.node("doc", null, [schema.nodes.paragraph.create(null, sel.node)])).trim(); } catch { /* fall through */ }
      }
      return slice.content.textBetween(0, slice.content.size, "\n\n");
    },
    // paragraphs keep newlines ("pre"): HTML pasted from elsewhere has source-formatting newlines that
    // a browser would collapse, so collapse them here (our own copies keep their soft breaks)
    transformPastedHTML(html) { foreignHtml = !/data-pm-slice/.test(html); return html; },
    transformPasted(slice) {
      if (!foreignHtml) return slice;
      foreignHtml = false;
      return new Slice(collapseNewlines(slice.content), slice.openStart, slice.openEnd);
    },
    handlePaste(view, event, slice) {
      if (!editorEditable(view)) { event.preventDefault(); return true; }
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
      if (!editorEditable(view)) { event.preventDefault(); return true; }
      const files = collectImages((event as DragEvent).dataTransfer);
      if (!files.length || !hooks.onImageFiles) return false;
      const p = view.posAtCoords({ left: (event as DragEvent).clientX, top: (event as DragEvent).clientY });
      event.preventDefault();
      return hooks.onImageFiles(files, p ? p.pos : null);
    },
    handleDOMEvents: {
      click(_v, e) {
        const a = (e.target as HTMLElement).closest("a[href]") as HTMLAnchorElement | null;
        if (a && (e.ctrlKey || e.metaKey)) {
          e.preventDefault();
          const href = a.getAttribute("href") || a.href;
          window.dispatchEvent(new CustomEvent("mdn-open-link", { detail: href }));
          return true;
        }
        return false;
      },
    },
  });
  // Survives setMarkdown, which replaces EditorState and destroys plugin views.
  view.dom.addEventListener("beforeinput", (ev) => skipAutoCloser(view, ev), true);
  // Typora-compatible wrapper: <content><div id="write">…
  return {
    view,
    getMarkdown: () => serializeMarkdown(collapseAll(view.state.doc)),
    getDoc: () => collapseAll(view.state.doc),
    setMarkdown: (md: string) => {
      const kept = slashItems(view.state);
      view.updateState(mkState(md));
      for (const it of kept) registerSlashItem(view, it);
      tocViews.forEach((t) => t.dom.isConnected ? t.refresh(view.state.doc) : tocViews.delete(t));
    },
    refreshDecorations: () => view.dispatch(view.state.tr.setMeta("refresh", true)),
  };
}
export type Editor = ReturnType<typeof createEditor>;

/** EditorView.editable is a boolean. Older checks treated it as a function and no longer type-check. */
function editorEditable(view: EditorView): boolean {
  return view.editable !== false;
}
