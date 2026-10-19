// Find / replace over the ProseMirror document (WYSIWYG mode).
// Matches are computed per textblock (including code blocks); hits are shown with inline
// decorations (.md-search-hit / .md-search-select). CodeMirror node views mirror the
// decorations that fall inside them (see CodeView.update).
import { Plugin, PluginKey, EditorState, TextSelection } from "prosemirror-state";
import { Decoration, DecorationSet, EditorView } from "prosemirror-view";
import { Node as PMNode } from "prosemirror-model";

export interface SearchQuery { text: string; caseSensitive: boolean; regex: boolean }
export interface Match { from: number; to: number }
interface S { query: SearchQuery | null; matches: Match[]; current: number; decos: DecorationSet }
export const searchKey = new PluginKey<S>("md-search");

export function buildRegex(q: SearchQuery): RegExp | null {
  if (!q.text) return null;
  try { return new RegExp(q.regex ? q.text : q.text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), q.caseSensitive ? "gu" : "giu"); }
  catch { return null; }
}

export function findMatches(doc: PMNode, q: SearchQuery): Match[] {
  const re = buildRegex(q); if (!re) return [];
  const out: Match[] = [];
  doc.descendants((node, pos) => {
    if (!node.isTextblock) return true;
    // text with a 1:1 mapping to positions (non-text inline nodes → U+FFFC)
    let text = ""; const start = pos + 1;
    node.forEach((c) => { text += c.isText ? c.text! : "\uFFFC".repeat(c.nodeSize); });
    re.lastIndex = 0; let m: RegExpExecArray | null;
    while ((m = re.exec(text))) {
      if (m[0].length === 0) { re.lastIndex++; continue; }
      out.push({ from: start + m.index, to: start + m.index + m[0].length });
      if (out.length > 5000) return false;
    }
    return false;
  });
  return out;
}

function decorate(doc: PMNode, matches: Match[], current: number) {
  return DecorationSet.create(doc, matches.map((m, i) => { const cls = i === current ? "md-search-hit md-search-select" : "md-search-hit"; return Decoration.inline(m.from, m.to, { class: cls }, { mdSearch: cls }); }));
}

export function searchPlugin() {
  return new Plugin<S>({
    key: searchKey,
    state: {
      init: () => ({ query: null, matches: [], current: -1, decos: DecorationSet.empty }),
      apply(tr, prev, _old, state) {
        const meta = tr.getMeta(searchKey) as Partial<S> | undefined;
        if (!meta && !tr.docChanged) return prev;
        const query = meta && "query" in meta ? meta.query! : prev.query;
        if (!query || !query.text) return { query, matches: [], current: -1, decos: DecorationSet.empty };
        const matches = findMatches(state.doc, query);
        let current = meta?.current ?? prev.current;
        if (meta && "query" in meta && meta.current == null) {
          // first match at/after the selection
          const from = state.selection.from; current = matches.findIndex((m) => m.from >= from); if (current < 0) current = matches.length ? 0 : -1;
        }
        if (current >= matches.length) current = matches.length - 1;
        return { query, matches, current, decos: decorate(state.doc, matches, current) };
      },
    },
    props: { decorations: (state) => searchKey.getState(state)!.decos },
  });
}

/** controller used by the find bar */
export class EditorSearch {
  constructor(private view: EditorView) {}
  private get st() { return searchKey.getState(this.view.state)!; }
  set(q: SearchQuery) { this.view.dispatch(this.view.state.tr.setMeta(searchKey, { query: q })); return this.info(); }
  info() { return { count: this.st.matches.length, current: this.st.current }; }
  go(dir: 1 | -1) {
    const { matches, current } = this.st; if (!matches.length) return this.info();
    const next = (current + dir + matches.length) % matches.length;
    this.view.dispatch(this.view.state.tr.setMeta(searchKey, { current: next }));
    this.reveal(); return this.info();
  }
  reveal() {
    const m = this.st.matches[this.st.current]; if (!m) return;
    const dom = this.view.domAtPos(m.from); const el = (dom.node.nodeType === 1 ? dom.node : dom.node.parentElement) as HTMLElement;
    el?.scrollIntoView?.({ block: "center" });
  }
  replace(repl: string) {
    const { matches, current, query } = this.st; const m = matches[current]; if (!m || !query) return this.info();
    const text = this.view.state.doc.textBetween(m.from, m.to, "\uFFFC", "\uFFFC");
    const re = buildRegex(query)!; const r = query.regex ? text.replace(new RegExp(re.source, re.flags.replace("g", "")), repl) : repl;
    const tr = this.view.state.tr.insertText(r, m.from, m.to);
    tr.setMeta(searchKey, { current });
    this.view.dispatch(tr); this.reveal(); return this.info();
  }
  replaceAll(repl: string) {
    const { matches, query } = this.st; if (!query || !matches.length) return { ...this.info(), replaced: 0 };
    const re = buildRegex(query)!; const one = new RegExp(re.source, re.flags.replace("g", ""));
    const tr = this.view.state.tr;
    for (const m of [...matches].reverse()) {
      const text = tr.doc.textBetween(m.from, m.to, "\uFFFC", "\uFFFC");
      tr.insertText(query.regex ? text.replace(one, repl) : repl, m.from, m.to);
    }
    this.view.dispatch(tr); return { ...this.info(), replaced: matches.length };
  }
  clear() { this.view.dispatch(this.view.state.tr.setMeta(searchKey, { query: null })); }
  selectCurrent() {
    const m = this.st.matches[this.st.current]; if (!m) return;
    this.view.dispatch(this.view.state.tr.setSelection(TextSelection.create(this.view.state.doc, m.from, m.to)).scrollIntoView());
  }
}
export type { EditorState };
