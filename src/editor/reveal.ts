// Block focus + block-level reveal: the textblock containing the caret gets .md-focus and its
// ancestors .md-focus-container (Typora-theme compatible classes); headings show their "#" prefix
// and selected images their source. Inline markers are real text — see markers.ts.
import { Plugin, PluginKey, EditorState, NodeSelection } from "prosemirror-state";
import { Decoration, DecorationSet } from "prosemirror-view";

function meta(text: string, cls: string) {
  return () => { const s = document.createElement("span"); s.className = "md-meta " + cls; s.textContent = text; s.setAttribute("contenteditable", "false"); return s; };
}

export const revealKey = new PluginKey("md-reveal");
export function revealPlugin() {
  return new Plugin({
    key: revealKey,
    props: {
      decorations(state: EditorState) {
        const decos: Decoration[] = [];
        const sel = state.selection;
        const $from = sel.$from;
        // block focus
        for (let d = $from.depth; d > 0; d--) {
          const node = $from.node(d);
          const start = $from.before(d);
          const cls = d === $from.depth || (sel instanceof NodeSelection && d === $from.depth) ? "md-focus" : "md-focus-container";
          decos.push(Decoration.node(start, start + node.nodeSize, { class: cls }));
        }
        if (sel instanceof NodeSelection) {
          const n = sel.node;
          if (n.type.name === "code_block" || n.type.name === "math_block" || n.type.name === "toc" || n.type.name === "html_block") {
            decos.push(Decoration.node(sel.from, sel.to, { class: "md-focus" }));
          }
          if (n.type.name === "image") {
            decos.push(Decoration.widget(sel.from, meta(`![${n.attrs.alt ?? ""}](${n.attrs.src})`, "md-before md-content md-image-src-span"), { side: -1 }));
          }
          return DecorationSet.create(state.doc, decos);
        }
        const parent = $from.parent;
        if (parent.isTextblock && !parent.type.spec.code) {
          const blockStart = $from.start();
          if (parent.type.name === "heading") {
            decos.push(Decoration.widget(blockStart, meta("#".repeat(parent.attrs.level) + " ", "md-before md-heading-meta"), { side: -1, marks: [] }));
          }
        }
        return DecorationSet.create(state.doc, decos);
      },
    },
  });
}
