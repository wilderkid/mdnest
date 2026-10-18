// Source mode: whole-document CodeMirror 5 (gfm mode) in #typora-source, toggled by body.typora-sourceview-on
import CodeMirror from "codemirror";
import "codemirror/mode/gfm/gfm";
import "codemirror/addon/mode/overlay";

export class SourceMode {
  cm: CodeMirror.Editor | null = null;
  el: HTMLElement;
  constructor(parent: HTMLElement) {
    this.el = document.createElement("div");
    this.el.id = "typora-source"; this.el.className = "typora-sourceview-off";
    parent.appendChild(this.el);
  }
  get active() { return document.body.classList.contains("typora-sourceview-on"); }
  show(text: string) {
    if (!this.cm) this.cm = CodeMirror(this.el, { value: text, mode: "gfm", theme: "typora-default", lineWrapping: true, lineNumbers: false, viewportMargin: Infinity });
    else this.cm.setValue(text);
    document.body.classList.add("typora-sourceview-on");
    setTimeout(() => { this.cm!.refresh(); this.cm!.focus(); }, 0);
  }
  hide(): string { document.body.classList.remove("typora-sourceview-on"); return this.cm?.getValue() ?? ""; }
  value() { return this.cm?.getValue() ?? ""; }
}
