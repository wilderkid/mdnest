import { Node as PMNode } from "prosemirror-model";
import { EditorView, NodeView } from "prosemirror-view";
import { NodeSelection, TextSelection } from "prosemirror-state";
import CodeMirror from "codemirror";
import { renderTex, escapeHtml } from "./render";
import { CodeView, loadMode } from "./codeview";

class InlineMathView implements NodeView {
  dom: HTMLElement;
  constructor(private node: PMNode, private view: EditorView, private getPos: () => number | undefined) {
    this.dom = document.createElement("span");
    this.dom.className = "md-inline-math md-math-container";
    this.dom.setAttribute("md-inline", "inline_math");
    this.render();
    this.dom.addEventListener("mousedown", (e) => { e.preventDefault(); this.edit(); });
  }
  async render() {
    this.dom.innerHTML = `<span class="md-math-preview">${await renderTex(this.node.attrs.tex, false)}</span>`;
  }
  /** editing = put the caret next to the formula; the markers plugin swaps it for editable `$tex$`
   *  source with a live rendered preview (inline popover) */
  edit() {
    const p = this.getPos(); if (p == null) return;
    this.view.dispatch(this.view.state.tr.setSelection(TextSelection.create(this.view.state.doc, p + this.node.nodeSize)));
    this.view.focus();
  }
  selectNode() { this.dom.classList.add("md-expand", "ProseMirror-selectednode"); }
  deselectNode() { this.dom.classList.remove("md-expand", "ProseMirror-selectednode"); }
  update(n: PMNode) { if (n.type !== this.node.type) return false; const ch = n.attrs.tex !== this.node.attrs.tex; this.node = n; if (ch) this.render(); return true; }
  ignoreMutation() { return true; }
  stopEvent(e: Event) { return e.type === "mousedown"; }
}

/** footnote reference: superscript label (title = definition text). Click → caret next to it, which
 *  reveals the editable `[^label]` source; Ctrl/Cmd+click jumps to the definition. */
class FootnoteRefView implements NodeView {
  dom: HTMLElement;
  constructor(private node: PMNode, private view: EditorView, private getPos: () => number | undefined) {
    this.dom = document.createElement("sup");
    this.dom.className = "md-footnote"; this.dom.setAttribute("md-inline", "footnote"); this.dom.setAttribute("mdtype", "footnote");
    this.render();
    this.dom.addEventListener("click", (e) => e.preventDefault());
    this.dom.addEventListener("mousedown", (e) => {
      e.preventDefault();
      if (e.ctrlKey || e.metaKey) { this.jump(); return; }
      const p = this.getPos(); if (p == null) return;
      this.view.dispatch(this.view.state.tr.setSelection(TextSelection.create(this.view.state.doc, p + this.node.nodeSize)));
      this.view.focus();
    });
  }
  definition(): { pos: number; text: string } | null {
    let r: { pos: number; text: string } | null = null;
    this.view.state.doc.descendants((n, pos) => { if (!r && n.type.name === "footnote_def" && n.attrs.label === this.node.attrs.label) r = { pos, text: n.textContent }; return !r; });
    return r;
  }
  render() {
    const l = this.node.attrs.label;
    this.dom.innerHTML = "";
    const a = document.createElement("a"); a.href = "#dfref-footnote-" + l; a.setAttribute("name", "ref-footnote-" + l); a.textContent = l;
    this.dom.appendChild(a);
    const d = this.definition(); this.dom.title = d ? d.text : `[^${l}] (no definition)`;
    this.dom.classList.toggle("md-footnote-missing", !d);
  }
  jump() {
    const d = this.definition(); if (!d) return;
    this.view.dispatch(this.view.state.tr.setSelection(TextSelection.create(this.view.state.doc, d.pos + 1)).scrollIntoView());
    this.view.focus();
  }
  update(n: PMNode) { if (n.type !== this.node.type) return false; this.node = n; this.render(); return true; }
  ignoreMutation() { return true; }
  stopEvent(e: Event) { return e.type === "mousedown"; }
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

/** Raw HTML block. A CodeMirror editor holds the source; a sandboxed preview shows the rendered HTML. */
class HtmlBlockView implements NodeView {
  dom: HTMLElement;
  private cm: CodeMirror.Editor;
  private node: PMNode;
  private updating = false;
  constructor(node: PMNode, private view: EditorView, private getPos: () => number | undefined) {
    this.node = node;
    this.dom = document.createElement("div");
    this.dom.className = "md-htmlblock md-rawblock md-end-block";
    this.dom.setAttribute("mdtype", "html_block");
    this.dom.contentEditable = "false";
    const editor = document.createElement("div");
    editor.className = "md-htmlblock-editor";
    this.dom.appendChild(editor);
    this.cm = CodeMirror(editor, {
      value: node.attrs.html || "",
      mode: "htmlmixed",
      theme: "inner",
      lineWrapping: true,
      viewportMargin: Infinity,
    });
    this.cm.on("changes", () => { if (!this.updating) this.commit(); });
    this.cm.on("focus", () => this.placeCaret());
    const preview = document.createElement("div");
    preview.className = "md-htmlblock-container";
    preview.contentEditable = "false";
    this.dom.appendChild(preview);
    this.paint(preview, node.attrs.html || "");
    void loadMode("html").then(() => this.cm.setOption("mode", "htmlmixed"));
    setTimeout(() => this.cm.refresh(), 0);
  }
  /** Put the ProseMirror caret inside this atom so menus know which block is active. */
  private placeCaret() {
    const p = this.getPos();
    if (p == null) return;
    const sel = NodeSelection.create(this.view.state.doc, p);
    if (!sel.eq(this.view.state.selection)) this.view.dispatch(this.view.state.tr.setSelection(sel));
  }
  private commit() {
    const p = this.getPos();
    if (p == null) return;
    const html = this.cm.getValue();
    if (html === this.node.attrs.html) return;
    this.view.dispatch(this.view.state.tr.setNodeMarkup(p, undefined, { ...this.node.attrs, html }));
  }
  private paint(preview: HTMLElement, html: string) {
    const tpl = document.createElement("template");
    tpl.innerHTML = html;
    tpl.content.querySelectorAll("script,iframe,object,embed").forEach((e) => e.remove());
    tpl.content.querySelectorAll("*").forEach((e) => [...e.attributes].forEach((a) => { if (a.name.startsWith("on")) e.removeAttribute(a.name); }));
    preview.replaceChildren(tpl.content);
  }
  /** Move the CodeMirror caret between the template tags (`<div>\\n|\\n</div>`). */
  focusInside() {
    const text = this.cm.getValue();
    const nl = text.indexOf("\n");
    const line = nl < 0 ? 0 : this.cm.posFromIndex(nl + 1);
    this.cm.focus();
    this.cm.setCursor(line);
    this.placeCaret();
  }
  update(node: PMNode) {
    if (node.type !== this.node.type) return false;
    this.node = node;
    if (!this.cm.hasFocus() && this.cm.getValue() !== node.attrs.html) {
      this.updating = true;
      this.cm.setValue(node.attrs.html || "");
      this.updating = false;
    }
    const preview = this.dom.querySelector<HTMLElement>(".md-htmlblock-container");
    if (preview) this.paint(preview, node.attrs.html || "");
    return true;
  }
  stopEvent(e: Event) {
    return this.dom.contains(e.target as Node);
  }
  ignoreMutation() { return true; }
  selectNode() { this.dom.classList.add("ProseMirror-selectednode"); this.focusInside(); }
  deselectNode() { this.dom.classList.remove("ProseMirror-selectednode"); }
}

export function htmlBlockTemplate(): string {
  return "<div>\n\n</div>";
}

export function nodeViews() {
  return {
    code_block: (n: PMNode, v: EditorView, g: any) => new CodeView(n, v, g, "fence"),
    math_block: (n: PMNode, v: EditorView, g: any) => new CodeView(n, v, g, "math"),
    front_matter: (n: PMNode, v: EditorView, g: any) => new CodeView(n, v, g, "yaml"),
    inline_math: (n: PMNode, v: EditorView, g: any) => new InlineMathView(n, v, g),
    footnote_ref: (n: PMNode, v: EditorView, g: any) => new FootnoteRefView(n, v, g),
    toc: (_n: PMNode, v: EditorView) => { const t = new TocView(v); tocViews.add(t); return t; },
    html_block: (n: PMNode, v: EditorView, g: () => number | undefined) => new HtmlBlockView(n, v, g),
  };
}
export const tocViews = new Set<TocView>();
