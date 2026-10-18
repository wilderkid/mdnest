import { Node as PMNode } from "prosemirror-model";
import { EditorView, NodeView } from "prosemirror-view";
import { renderTex, escapeHtml } from "./render";
import { CodeView } from "./codeview";

class InlineMathView implements NodeView {
  dom: HTMLElement;
  constructor(private node: PMNode, private view: EditorView, private getPos: () => number | undefined) {
    this.dom = document.createElement("span");
    this.dom.className = "md-inline-math md-math-container";
    this.dom.setAttribute("md-inline", "inline_math");
    this.render();
    this.dom.addEventListener("dblclick", () => this.edit());
  }
  async render() {
    this.dom.innerHTML = `<span class="md-math-preview">${await renderTex(this.node.attrs.tex, false)}</span>`;
  }
  edit() {
    const tex = prompt("Inline math (TeX)", this.node.attrs.tex);
    const p = this.getPos();
    if (tex != null && p != null) this.view.dispatch(this.view.state.tr.setNodeMarkup(p, undefined, { tex }));
  }
  selectNode() { this.dom.classList.add("md-expand", "ProseMirror-selectednode"); }
  deselectNode() { this.dom.classList.remove("md-expand", "ProseMirror-selectednode"); }
  update(n: PMNode) { if (n.type !== this.node.type) return false; const ch = n.attrs.tex !== this.node.attrs.tex; this.node = n; if (ch) this.render(); return true; }
  ignoreMutation() { return true; }
  stopEvent(e: Event) { return e.type === "dblclick"; }
}

/** TOC block: rendered from document headings; refreshed by the editor on every doc change */
export class TocView implements NodeView {
  dom: HTMLElement;
  constructor(private view: EditorView) {
    this.dom = document.createElement("div");
    this.dom.className = "md-toc md-end-block"; this.dom.setAttribute("mdtype", "toc"); this.dom.contentEditable = "false";
    this.refresh(view.state.doc);
  }
  refresh(doc: PMNode) {
    const items: string[] = [];
    let i = 0;
    doc.descendants((n) => {
      if (n.type.name === "heading") items.push(`<span class="md-toc-item md-toc-h${n.attrs.level}" data-ref="h${i++}"><a class="md-toc-inner" href="#">${escapeHtml(n.textContent)}</a></span>`);
      return n.type.name !== "heading";
    });
    this.dom.innerHTML = `<p class="md-toc-content" role="list">${items.join("")}</p>`;
    this.dom.querySelectorAll<HTMLElement>(".md-toc-item").forEach((el, idx) => el.addEventListener("click", (e) => {
      e.preventDefault();
      const hs = this.view.dom.querySelectorAll("h1,h2,h3,h4,h5,h6"); (hs[idx] as HTMLElement)?.scrollIntoView({ behavior: "smooth", block: "start" });
    }));
  }
  update(n: PMNode) { if (n.type.name !== "toc") return false; return true; }
  ignoreMutation() { return true; }
  stopEvent() { return true; }
}

class HtmlBlockView implements NodeView {
  dom: HTMLElement;
  constructor(node: PMNode) {
    this.dom = document.createElement("div");
    this.dom.className = "md-htmlblock md-rawblock"; this.dom.setAttribute("mdtype", "html_block"); this.dom.contentEditable = "false";
    const c = document.createElement("div"); c.className = "md-htmlblock-container";
    // Sandboxed display: strip scripts/handlers. (Phase 2: proper sanitizer + inline raw edit)
    const tpl = document.createElement("template"); tpl.innerHTML = node.attrs.html;
    tpl.content.querySelectorAll("script,iframe,object,embed").forEach((e) => e.remove());
    tpl.content.querySelectorAll("*").forEach((e) => [...e.attributes].forEach((a) => a.name.startsWith("on") && e.removeAttribute(a.name)));
    c.appendChild(tpl.content); this.dom.appendChild(c);
  }
  ignoreMutation() { return true; }
}

export function nodeViews() {
  return {
    code_block: (n: PMNode, v: EditorView, g: any) => new CodeView(n, v, g, "fence"),
    math_block: (n: PMNode, v: EditorView, g: any) => new CodeView(n, v, g, "math"),
    front_matter: (n: PMNode, v: EditorView, g: any) => new CodeView(n, v, g, "yaml"),
    inline_math: (n: PMNode, v: EditorView, g: any) => new InlineMathView(n, v, g),
    toc: (_n: PMNode, v: EditorView) => { const t = new TocView(v); tocViews.add(t); return t; },
    html_block: (n: PMNode) => new HtmlBlockView(n),
  };
}
export const tocViews = new Set<TocView>();
