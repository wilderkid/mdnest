// CodeMirror 5.65 node view for fences, math blocks and YAML front matter.
// Uses theme "inner" so the editor gets .cm-s-inner (the class Typora themes style).
import CodeMirror from "codemirror";
import "codemirror/mode/javascript/javascript";
import "codemirror/mode/python/python";
import "codemirror/mode/css/css";
import "codemirror/mode/xml/xml";
import "codemirror/mode/htmlmixed/htmlmixed";
import "codemirror/mode/markdown/markdown";
import "codemirror/mode/gfm/gfm";
import "codemirror/mode/shell/shell";
import "codemirror/mode/clike/clike";
import "codemirror/mode/rust/rust";
import "codemirror/mode/go/go";
import "codemirror/mode/sql/sql";
import "codemirror/mode/yaml/yaml";
import "codemirror/mode/stex/stex";
import "codemirror/mode/diff/diff";
import { Node as PMNode } from "prosemirror-model";
import { EditorView, NodeView } from "prosemirror-view";
import { Selection, TextSelection } from "prosemirror-state";
import { exitCode } from "prosemirror-commands";
import { undo, redo } from "prosemirror-history";
import { renderTex, renderMermaid } from "./render";

const modeAlias: Record<string, string> = {
  js: "javascript", javascript: "javascript", ts: "text/typescript", typescript: "text/typescript", json: "application/json",
  py: "python", python: "python", css: "css", html: "htmlmixed", xml: "xml", md: "gfm", markdown: "gfm",
  sh: "shell", bash: "shell", shell: "shell", c: "text/x-csrc", cpp: "text/x-c++src", "c++": "text/x-c++src", java: "text/x-java",
  cs: "text/x-csharp", csharp: "text/x-csharp", rust: "rust", go: "go", sql: "sql", yaml: "yaml", yml: "yaml",
  tex: "stex", latex: "stex", diff: "diff", kotlin: "text/x-kotlin", scala: "text/x-scala",
};
export const cmMode = (lang: string) => modeAlias[(lang || "").toLowerCase().split(/\s/)[0]] ?? "text/plain";

type Kind = "fence" | "math" | "yaml";

export class CodeView implements NodeView {
  dom: HTMLElement; cm: CodeMirror.Editor; node: PMNode; updating = false; incomingChanges = false;
  preview?: HTMLElement; langInput?: HTMLInputElement; renderTimer: any;
  constructor(node: PMNode, private view: EditorView, private getPos: () => number | undefined, private kind: Kind) {
    this.node = node;
    if (kind === "fence") {
      this.dom = document.createElement("pre");
      this.dom.className = "md-fences md-end-block ty-contain-cm modeLoaded";
      this.dom.setAttribute("mdtype", "fences");
      this.dom.setAttribute("lang", node.attrs.params);
    } else if (kind === "math") {
      this.dom = document.createElement("div");
      this.dom.className = "md-math-block md-end-block md-rawblock";
      this.dom.setAttribute("mdtype", "math_block");
    } else {
      this.dom = document.createElement("pre");
      this.dom.className = "md-meta-block md-end-block";
      this.dom.setAttribute("mdtype", "meta_block");
    }
    this.dom.setAttribute("spellcheck", "false");
    this.cm = CodeMirror(this.dom, {
      value: node.textContent, theme: "inner", lineWrapping: true, viewportMargin: Infinity,
      mode: kind === "math" ? "stex" : kind === "yaml" ? "yaml" : cmMode(node.attrs.params),
      extraKeys: this.keys(),
    });
    if (kind === "fence") {
      const tip = document.createElement("div");
      tip.className = "code-tooltip md-hover-tip"; tip.contentEditable = "false";
      const inp = document.createElement("input");
      inp.className = "ty-cm-lang-input"; inp.placeholder = "language"; inp.value = node.attrs.params;
      inp.addEventListener("change", () => { const p = this.getPos(); if (p != null) view.dispatch(view.state.tr.setNodeMarkup(p, undefined, { params: inp.value.trim() })); });
      tip.appendChild(inp); this.dom.appendChild(tip); this.langInput = inp;
    }
    if (kind === "math" || this.isDiagram()) this.ensurePreview();
    this.cm.on("beforeChange", () => (this.incomingChanges = this.updating));
    this.cm.on("cursorActivity", () => { if (!this.updating && !this.incomingChanges) this.forwardSelection(); });
    this.cm.on("changes", () => { if (!this.updating) { this.valueChanged(); this.forwardSelection(); } this.incomingChanges = false; });
    this.cm.on("focus", () => this.forwardSelection());
    setTimeout(() => this.cm.refresh(), 0);
  }
  isDiagram() { return this.kind === "fence" && /^(mermaid)\b/i.test(this.node.attrs.params); }
  ensurePreview() {
    if (!this.preview) {
      this.preview = document.createElement("div");
      this.preview.contentEditable = "false";
      if (this.kind === "math") this.preview.className = "md-math-preview mathjax-block md-mathjax-preview";
      else { this.preview.className = "md-diagram-panel md-fences-adv-panel"; this.dom.classList.add("md-fences-advanced"); }
      this.preview.addEventListener("mousedown", (e) => { e.preventDefault(); this.cm.focus(); });
      this.dom.appendChild(this.preview);
    }
    this.schedulePreview(0);
  }
  schedulePreview(ms = 250) {
    clearTimeout(this.renderTimer);
    this.renderTimer = setTimeout(async () => {
      if (!this.preview) return;
      const src = this.node.textContent;
      const html = this.kind === "math" ? await renderTex(src, true) : `<div class="md-diagram-panel-preview">${await renderMermaid(src)}</div>`;
      if (this.preview) this.preview.innerHTML = html;
    }, ms);
  }
  forwardSelection() {
    if (!this.cm.hasFocus()) return;
    const state = this.view.state; const sel = this.asPMSelection(state.doc);
    if (!sel.eq(state.selection)) this.view.dispatch(state.tr.setSelection(sel));
  }
  asPMSelection(doc: PMNode) {
    const offset = this.getPos()! + 1;
    const anchor = this.cm.indexFromPos(this.cm.getCursor("anchor")) + offset;
    const head = this.cm.indexFromPos(this.cm.getCursor("head")) + offset;
    return TextSelection.create(doc, anchor, head);
  }
  setSelection(anchor: number, head: number) {
    this.cm.focus(); this.updating = true;
    this.cm.setSelection(this.cm.posFromIndex(anchor), this.cm.posFromIndex(head));
    this.updating = false;
  }
  valueChanged() {
    const change = computeChange(this.node.textContent, this.cm.getValue());
    if (change) {
      const start = this.getPos()! + 1;
      const tr = this.view.state.tr.replaceWith(start + change.from, start + change.to, change.text ? this.view.state.schema.text(change.text) : []);
      this.view.dispatch(tr);
    }
  }
  keys() {
    const view = this.view;
    const k = (unit: "line" | "char", dir: number) => () => this.maybeEscape(unit, dir);
    return {
      Up: k("line", -1), Left: k("char", -1), Down: k("line", 1), Right: k("char", 1),
      "Ctrl-Enter": () => { if (exitCode(view.state, view.dispatch)) view.focus(); },
      "Ctrl-Z": () => undo(view.state, view.dispatch), "Shift-Ctrl-Z": () => redo(view.state, view.dispatch), "Ctrl-Y": () => redo(view.state, view.dispatch),
      Backspace: (cm: CodeMirror.Editor) => {
        if (cm.getValue() === "") { const p = this.getPos()!; view.dispatch(view.state.tr.delete(p, p + this.node.nodeSize).scrollIntoView()); view.focus(); return; }
        return CodeMirror.Pass;
      },
    } as any;
  }
  maybeEscape(unit: "line" | "char", dir: number): any {
    const cm = this.cm; const pos = cm.getCursor();
    if (cm.somethingSelected() || pos.line !== (dir < 0 ? cm.firstLine() : cm.lastLine()) ||
      (unit === "char" && pos.ch !== (dir < 0 ? 0 : cm.getLine(pos.line).length))) return CodeMirror.Pass;
    this.view.focus();
    const targetPos = this.getPos()! + (dir < 0 ? 0 : this.node.nodeSize);
    const selection = Selection.near(this.view.state.doc.resolve(targetPos), dir);
    this.view.dispatch(this.view.state.tr.setSelection(selection).scrollIntoView());
    this.view.focus();
  }
  update(node: PMNode) {
    if (node.type !== this.node.type) return false;
    const langChanged = node.attrs.params !== this.node.attrs.params;
    this.node = node;
    if (this.kind === "fence") {
      this.dom.setAttribute("lang", node.attrs.params);
      if (langChanged) { this.cm.setOption("mode", cmMode(node.attrs.params)); if (this.langInput) this.langInput.value = node.attrs.params; if (this.isDiagram()) this.ensurePreview(); }
    }
    const change = computeChange(this.cm.getValue(), node.textContent);
    if (change) {
      this.updating = true;
      this.cm.replaceRange(change.text, this.cm.posFromIndex(change.from), this.cm.posFromIndex(change.to));
      this.updating = false;
    }
    if (this.preview) this.schedulePreview();
    return true;
  }
  selectNode() { this.cm.focus(); }
  stopEvent() { return true; }
  ignoreMutation() { return true; }
  destroy() { clearTimeout(this.renderTimer); }
}

function computeChange(oldVal: string, newVal: string) {
  if (oldVal === newVal) return null;
  let start = 0, oldEnd = oldVal.length, newEnd = newVal.length;
  while (start < oldEnd && oldVal.charCodeAt(start) === newVal.charCodeAt(start)) ++start;
  while (oldEnd > start && newEnd > start && oldVal.charCodeAt(oldEnd - 1) === newVal.charCodeAt(newEnd - 1)) { oldEnd--; newEnd--; }
  return { from: start, to: oldEnd, text: newVal.slice(start, newEnd) };
}

/** arrow-key handler so the caret can enter a CodeMirror node view from the surrounding text */
export function arrowHandler(dir: "left" | "right" | "up" | "down") {
  return (state: any, dispatch: any, view?: EditorView) => {
    if (state.selection.empty && view && view.endOfTextblock(dir)) {
      const side = dir === "left" || dir === "up" ? -1 : 1;
      const $head = state.selection.$head;
      const nextPos = Selection.near(state.doc.resolve(side > 0 ? $head.after() : $head.before()), side);
      if (nextPos.$head && nextPos.$head.parent.type.spec.code) { dispatch(state.tr.setSelection(nextPos)); return true; }
    }
    return false;
  };
}
