import { Node as PMNode } from "prosemirror-model";
import { headingText, userTouched } from "./headingsrc";
import { EditorView, NodeView } from "prosemirror-view";
import { NodeSelection, TextSelection, Selection } from "prosemirror-state";
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
      if (n.type.name === "heading") items.push(`<span class="md-toc-item md-toc-h${n.attrs.level}" data-ref="h${i++}"><a class="md-toc-inner" href="#">${escapeHtml(headingText(n))}</a></span>`);
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

/** the block's source as shown in its editor: without the newline that ends every HTML block */
const srcOf = (html: string | undefined) => (html || "").replace(/\n$/, "");

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
    (this.dom as any).__mdnHtml = this;
    const editor = document.createElement("div");
    editor.className = "md-htmlblock-editor";
    this.dom.appendChild(editor);
    this.cm = CodeMirror(editor, {
      value: srcOf(node.attrs.html),
      mode: "htmlmixed",
      theme: "inner",
      lineWrapping: true,
      viewportMargin: Infinity,
      extraKeys: {
        Up: () => this.escape(-1, "line"), Down: () => this.escape(1, "line"),
        Left: () => this.escape(-1, "char"), Right: () => this.escape(1, "char"),
        "Ctrl-Enter": () => this.escape(1, "force"), Esc: () => this.escape(1, "force"),
      },
    });
    this.cm.on("changes", () => { if (!this.updating) this.commit(); });
    // Typora: the source is shown only while editing; otherwise the rendered HTML
    this.cm.on("focus", () => { this.setEditing(true); this.placeCaret(); });
    this.cm.on("blur", () => setTimeout(() => { if (!this.cm.hasFocus()) this.setEditing(false); }, 0));
    const preview = document.createElement("div");
    preview.className = "md-htmlblock-container";
    preview.contentEditable = "false";
    // ProseMirror ignores events inside this view (stopEvent), so a click on the preview enters edit mode here
    preview.addEventListener("mousedown", (e) => {
      if ((e.target as HTMLElement).closest("a[href]") && (e.ctrlKey || e.metaKey)) return;
      e.preventDefault();
      this.setEditing(true);
      requestAnimationFrame(() => { this.cm.refresh(); this.focusInside(false); });
    });
    this.dom.appendChild(preview);
    this.paint(preview, node.attrs.html || "");
    void loadMode("html").then(() => this.cm.setOption("mode", "htmlmixed"));
    setTimeout(() => this.cm.refresh(), 0);
  }
  private setEditing(on: boolean) {
    if (this.dom.classList.contains("md-htmlblock-editing") === on) return;
    this.dom.classList.toggle("md-htmlblock-editing", on);
    if (on) this.cm.refresh();
  }
  /** leave the source editor with the arrow keys at its edges (like code blocks) */
  private escape(dir: number, unit: "line" | "char" | "force"): any {
    const cm = this.cm, pos = cm.getCursor();
    if (unit !== "force") {
      if (cm.somethingSelected() || pos.line !== (dir < 0 ? cm.firstLine() : cm.lastLine())) return CodeMirror.Pass;
      if (unit === "char" && pos.ch !== (dir < 0 ? 0 : cm.getLine(pos.line).length)) return CodeMirror.Pass;
    }
    const p = this.getPos(); if (p == null) return CodeMirror.Pass;
    const state = this.view.state;
    const target = dir < 0 ? p : p + this.node.nodeSize;
    let sel = Selection.findFrom(state.doc.resolve(target), dir, true);
    let tr = state.tr;
    if (!sel && dir > 0) { tr = tr.insert(state.doc.content.size, state.schema.nodes.paragraph.create()); sel = Selection.findFrom(tr.doc.resolve(target), 1, true); }
    if (!sel) return CodeMirror.Pass;
    this.setEditing(false);
    this.view.focus();
    this.view.dispatch(tr.setSelection(sel).scrollIntoView());
    return undefined;
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
    const old = this.node.attrs.html || "";
    const html = this.cm.getValue() + (old.endsWith("\n") ? "\n" : "");
    if (html === old) return;
    this.view.dispatch(this.view.state.tr.setNodeMarkup(p, undefined, { ...this.node.attrs, html }));
  }
  private paint(preview: HTMLElement, html: string) {
    const tpl = document.createElement("template");
    tpl.innerHTML = html;
    // an empty / invisible block still needs something to click on
    preview.classList.toggle("md-htmlblock-empty", !html.replace(/<[^>]*>/g, "").trim() && !/<(img|svg|video|audio|hr|br|input|canvas|table)\b/i.test(html));
    tpl.content.querySelectorAll("script,iframe,object,embed").forEach((e) => e.remove());
    tpl.content.querySelectorAll("*").forEach((e) => [...e.attributes].forEach((a) => { if (a.name.startsWith("on")) e.removeAttribute(a.name); }));
    preview.replaceChildren(tpl.content);
  }
  /** Move the CodeMirror caret between the template tags (`<div>\\n|\\n</div>`). */
  focusInside(template = true) {
    this.setEditing(true);
    const text = this.cm.getValue();
    const nl = text.indexOf("\n");
    const line = template && nl >= 0 ? this.cm.posFromIndex(nl + 1) : { line: 0, ch: 0 };
    this.cm.focus();
    this.cm.setCursor(line);
    this.placeCaret();
  }
  update(node: PMNode) {
    if (node.type !== this.node.type) return false;
    this.node = node;
    if (!this.cm.hasFocus() && this.cm.getValue() !== srcOf(node.attrs.html)) {
      this.updating = true;
      this.cm.setValue(srcOf(node.attrs.html));
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
  // A freshly opened file whose first block is HTML starts with this node selected: stay rendered until the user acts
  selectNode() { this.dom.classList.add("ProseMirror-selectednode"); if (userTouched(this.view.state)) this.focusInside(); }
  deselectNode() { this.dom.classList.remove("ProseMirror-selectednode"); if (!this.cm.hasFocus()) this.setEditing(false); }
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
