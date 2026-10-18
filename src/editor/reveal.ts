// Live-preview "source reveal": when the caret is inside an inline mark, show its Markdown
// delimiters as .md-meta widgets and mark the wrapper with .md-expand; the textblock containing
// the caret gets .md-focus and its ancestors .md-focus-container (Typora-theme compatible classes).
import { Plugin, PluginKey, EditorState, NodeSelection } from "prosemirror-state";
import { Decoration, DecorationSet } from "prosemirror-view";
import { Mark, Node as PMNode } from "prosemirror-model";

const delim: Record<string, [string, string] | ((m: Mark) => [string, string])> = {
  strong: ["**", "**"], em: ["*", "*"], code: ["`", "`"], strike: ["~~", "~~"], highlight: ["==", "=="],
  link: (m) => ["[", `](${m.attrs.href}${m.attrs.title ? ` "${m.attrs.title}"` : ""})`],
};

function meta(text: string, cls: string) {
  return () => { const s = document.createElement("span"); s.className = "md-meta " + cls; s.textContent = text; s.setAttribute("contenteditable", "false"); return s; };
}

/** contiguous ranges of each mark inside a textblock */
function markRanges(block: PMNode, blockStart: number) {
  const out: { mark: Mark; from: number; to: number }[] = [];
  const open = new Map<Mark, { from: number; to: number }>();
  block.forEach((child, offset) => {
    const pos = blockStart + offset;
    for (const [m, r] of open) if (!m.isInSet(child.marks)) { out.push({ mark: m, ...r }); open.delete(m); }
    for (const m of child.marks) {
      let found = false;
      for (const [om, r] of open) if (om.eq(m)) { r.to = pos + child.nodeSize; found = true; }
      if (!found) open.set(m, { from: pos, to: pos + child.nodeSize });
    }
  });
  for (const [m, r] of open) out.push({ mark: m, ...r });
  return out;
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
          const pos = sel.from, end = sel.to;
          for (const r of markRanges(parent, blockStart)) {
            if (r.to < pos || r.from > end) continue; // caret/selection touches the mark range (inclusive edges)
            const spec = delim[r.mark.type.name];
            if (!spec) continue;
            const [b, a] = typeof spec === "function" ? spec(r.mark) : spec;
            decos.push(Decoration.inline(r.from, r.to, { class: "md-expand" }));
            decos.push(Decoration.widget(r.from, meta(b, "md-before"), { side: -1, marks: [] }));
            decos.push(Decoration.widget(r.to, meta(a, "md-after" + (r.mark.type.name === "link" ? " md-url md-content" : "")), { side: 1, marks: [] }));
          }
        }
        return DecorationSet.create(state.doc, decos);
      },
    },
  });
}
