// Find / replace bar (Ctrl+F / Ctrl+H) driving either the WYSIWYG searcher or the source-mode one.
import type CodeMirror from "codemirror";
import { EditorSearch, SearchQuery, buildRegex } from "../editor/search";
import { t } from "../i18n";

interface Searcher {
  set(q: SearchQuery): { count: number; current: number };
  go(dir: 1 | -1): { count: number; current: number };
  replace(r: string): { count: number; current: number };
  replaceAll(r: string): { count: number; current: number; replaced?: number };
  clear(): void;
  selectCurrent?(): void;
  currentRange(): { from: number; to: number } | null;
}

/** source mode (CodeMirror 5) searcher */
export class SourceSearch implements Searcher {
  private marks: CodeMirror.TextMarker[] = []; private ranges: { from: number; to: number }[] = []; private cur = -1; private q: SearchQuery | null = null;
  constructor(private cm: () => CodeMirror.Editor | null) {}
  private run() {
    const cm = this.cm(); this.marks.forEach((m) => m.clear()); this.marks = []; this.ranges = [];
    if (!cm || !this.q) return;
    const re = buildRegex(this.q); if (!re) return;
    const text = cm.getValue(); let m: RegExpExecArray | null;
    while ((m = re.exec(text))) { if (!m[0].length) { re.lastIndex++; continue; } this.ranges.push({ from: m.index, to: m.index + m[0].length }); if (this.ranges.length > 5000) break; }
    if (this.cur >= this.ranges.length) this.cur = this.ranges.length - 1;
    this.ranges.forEach((r, i) => this.marks.push(cm.markText(cm.posFromIndex(r.from), cm.posFromIndex(r.to), { className: i === this.cur ? "md-search-hit md-search-select" : "md-search-hit" })));
  }
  info() { return { count: this.ranges.length, current: this.cur }; }
  set(q: SearchQuery) {
    this.q = q; const cm = this.cm(); this.cur = -1; this.run();
    if (cm && this.ranges.length) { const at = cm.indexFromPos(cm.getCursor()); this.cur = Math.max(0, this.ranges.findIndex((r) => r.from >= at)); this.run(); this.scroll(); }
    return this.info();
  }
  private scroll() { const cm = this.cm(); const r = this.ranges[this.cur]; if (cm && r) cm.scrollIntoView({ from: cm.posFromIndex(r.from), to: cm.posFromIndex(r.to) }, 120); }
  go(dir: 1 | -1) { if (!this.ranges.length) return this.info(); this.cur = (this.cur + dir + this.ranges.length) % this.ranges.length; this.run(); this.scroll(); return this.info(); }
  replace(repl: string) {
    const cm = this.cm(); const r = this.ranges[this.cur]; if (!cm || !r || !this.q) return this.info();
    const text = cm.getValue().slice(r.from, r.to); const re = buildRegex(this.q)!;
    cm.replaceRange(this.q.regex ? text.replace(new RegExp(re.source, re.flags.replace("g", "")), repl) : repl, cm.posFromIndex(r.from), cm.posFromIndex(r.to));
    this.run(); this.scroll(); return this.info();
  }
  replaceAll(repl: string) {
    const cm = this.cm(); if (!cm || !this.q || !this.ranges.length) return { ...this.info(), replaced: 0 };
    const re = buildRegex(this.q)!; const n = this.ranges.length;
    const out = this.q.regex ? cm.getValue().replace(re, repl) : cm.getValue().replace(re, () => repl);
    cm.operation(() => { const c = cm.getCursor(); cm.setValue(out); cm.setCursor(c); });
    this.run(); return { ...this.info(), replaced: n };
  }
  clear() { this.q = null; this.run(); }
  currentRange() { return this.ranges[this.cur] ?? null; }
  selectCurrent() {
    const cm = this.cm(); const r = this.ranges[this.cur];
    if (cm && r) cm.setSelection(cm.posFromIndex(r.from), cm.posFromIndex(r.to));
  }
}

export class FindBar {
  el: HTMLElement; private find: HTMLInputElement; private repl: HTMLInputElement; private count: HTMLElement;
  private opts = { caseSensitive: false, regex: false };
  constructor(private pick: () => Searcher, private notify: (m: string) => void) {
    this.el = document.createElement("div"); this.el.id = "mdn-find"; this.el.className = "mdn-findbar"; this.el.style.display = "none";
    this.el.innerHTML = `<div class="fb-row"><input class="fb-find" placeholder="${t("Find")}" spellcheck="false"><span class="fb-count">0/0</span>
      <button class="fb-opt" data-opt="caseSensitive" title="${t("Match case")}">Aa</button><button class="fb-opt" data-opt="regex" title="${t("Regular expression")}">.*</button>
      <button data-act="prev" title="${t("Previous (Shift+Enter)")}">↑</button><button data-act="next" title="${t("Next (Enter)")}">↓</button><button data-act="close" title="${t("Close (Esc)")}">✕</button></div>
      <div class="fb-row fb-replace-row"><input class="fb-repl" placeholder="${t("Replace")}" spellcheck="false"><button data-act="replace">${t("Replace")}</button><button data-act="all">${t("Replace All")}</button></div>`;
    document.body.appendChild(this.el);
    this.find = this.el.querySelector(".fb-find")!; this.repl = this.el.querySelector(".fb-repl")!; this.count = this.el.querySelector(".fb-count")!;
    this.find.addEventListener("input", () => this.update());
    this.find.addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); this.show(this.pick().go(e.shiftKey ? -1 : 1)); } else if (e.key === "Escape") this.close(); });
    this.repl.addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); this.show(this.pick().replace(this.repl.value)); } else if (e.key === "Escape") this.close(); });
    this.el.addEventListener("mousedown", (e) => { if ((e.target as HTMLElement).tagName === "BUTTON") e.preventDefault(); });
    this.el.addEventListener("click", (e) => {
      const b = (e.target as HTMLElement).closest("button") as HTMLButtonElement | null; if (!b) return;
      if (b.dataset.opt) { const k = b.dataset.opt as "caseSensitive" | "regex"; this.opts[k] = !this.opts[k]; b.classList.toggle("active", this.opts[k]); this.update(); return; }
      const s = this.pick();
      switch (b.dataset.act) {
        case "prev": this.show(s.go(-1)); break; case "next": this.show(s.go(1)); break; case "close": this.close(); break;
        case "replace": this.show(s.replace(this.repl.value)); break;
        case "all": { const r = s.replaceAll(this.repl.value); this.show(r); this.notify(t("Replaced {n} occurrence(s)", { n: r.replaced ?? 0 })); break; }
      }
    });
  }
  get visible() { return this.el.style.display !== "none"; }
  queryText() { return this.find.value; }
  open(replace: boolean, seed?: string) {
    this.el.style.display = "block"; this.el.classList.toggle("with-replace", replace);
    if (seed && !seed.includes("\n")) this.find.value = seed;
    this.update();
    this.find.focus(); this.find.select();
    // CodeMirror may grab focus back during its own keydown handling: re-focus (without re-selecting)
    setTimeout(() => { if (document.activeElement !== this.find) this.find.focus(); }, 0);
  }
  close() { this.el.style.display = "none"; this.pick().selectCurrent?.(); this.pick().clear(); }
  update() {
    const q = { text: this.find.value, ...this.opts };
    const bad = q.regex && q.text && !buildRegex(q);
    this.find.classList.toggle("fb-error", !!bad);
    this.show(this.pick().set(q));
  }
  /** re-run against the other mode after a source/WYSIWYG toggle */
  refresh() { if (this.visible) this.update(); }
  private show(i: { count: number; current: number }) { this.count.textContent = i.count ? `${i.current + 1}/${i.count}` : "0/0"; this.el.classList.toggle("fb-none", !!this.find.value && !i.count); }
}
export type { Searcher, EditorSearch };
