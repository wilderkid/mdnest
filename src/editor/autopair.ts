// Auto-pair brackets, quotes, and (optionally) Markdown delimiters.
// Typora defaults: brackets/quotes on, Markdown syntax off. Never inside code or math.
import { Plugin, TextSelection } from "prosemirror-state";
import { EditorView } from "prosemirror-view";

export const PAIR_BRACKETS_KEY = "mdnest.autoPair.brackets";
export const PAIR_MARKDOWN_KEY = "mdnest.autoPair.markdown";

export function pairBracketsOn(): boolean {
  return localStorage.getItem(PAIR_BRACKETS_KEY) !== "0";
}
export function pairMarkdownOn(): boolean {
  return localStorage.getItem(PAIR_MARKDOWN_KEY) === "1";
}

const BRACKETS: Record<string, string> = { "(": ")", "[": "]", "{": "}", '"': '"', "'": "'" };
const MD_PAIRS: Record<string, string> = { "*": "*", _: "_", "`": "`", "~": "~", "=": "=" };

function blocked(view: EditorView): boolean {
  const { $from } = view.state.selection;
  if ($from.parent.type.spec.code) return true;
  const name = $from.parent.type.name;
  if (name === "code_block" || name === "math_block" || name === "inline_math" || name === "front_matter") return true;
  // md_src is the expanded-source wrapper (e.g. while typing [TOC]). It is not a code span.
  // Only real code marks block pairing.
  const codeMark = (m: { type: { name: string; spec: { code?: boolean } } }) => m.type.spec.code && m.type.name !== "md_src";
  if (view.state.storedMarks?.some(codeMark) || $from.marks().some(codeMark)) return true;
  return false;
}

function $start(view: EditorView, from: number): number {
  try { return view.state.doc.resolve(from).start(); } catch { return Math.max(0, from - 8); }
}

function pairs(): Record<string, string> {
  return pairMarkdownOn() ? { ...BRACKETS, ...MD_PAIRS } : { ...BRACKETS };
}

/** Skip a typed closer that is already the next character. Called from a DOM listener that
 * outlives plugin views, because setMarkdown replaces EditorState and would otherwise drop it. */
export function skipAutoCloser(view: EditorView, ev: Event): void {
  const e = ev as InputEvent;
  if (e.inputType !== "insertText" || !e.data || e.data.length !== 1) return;
  if (!pairBracketsOn() && !pairMarkdownOn()) return;
  if (view.composing || blocked(view)) return;
  const text = e.data;
  const map = pairBracketsOn() ? pairs() : (pairMarkdownOn() ? MD_PAIRS : {});
  if (!Object.values(map).includes(text)) return;
  const dom = view.domAtPos(view.state.selection.from);
  const node = dom.node.nodeType === 3 ? dom.node : dom.node.childNodes[dom.offset] ?? dom.node;
  const offset = dom.node.nodeType === 3 ? dom.offset : 0;
  const live = node.nodeType === 3 ? (node.textContent || "").slice(offset, offset + text.length) : "";
  const { from, to, empty } = view.state.selection;
  const pmNext = empty ? view.state.doc.textBetween(to, Math.min(to + text.length, view.state.doc.content.size)) : "";
  if (live !== text && pmNext !== text) return;
  e.preventDefault();
  e.stopPropagation();
  const pos = view.posAtDOM(node, offset + text.length);
  view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, pos)).scrollIntoView());
}

export function autoPairPlugin() {
  return new Plugin({
    view(editorView) {
      // handleTextInput runs after the browser has queued the character, so returning true
      // there does not stop a skipped closer from landing. Swallow it before the editor sees it.
      const onBefore = (ev: Event) => skipAutoCloser(editorView, ev);
      editorView.dom.addEventListener("beforeinput", onBefore, true);
      return { destroy() { editorView.dom.removeEventListener("beforeinput", onBefore, true); } };
    },
    props: {
      handleTextInput(view, from, to, text) {
        if (!pairBracketsOn() && !pairMarkdownOn()) return false;
        if (text.length !== 1 || view.composing || blocked(view)) return false;
        const map = pairBracketsOn() ? pairs() : (pairMarkdownOn() ? MD_PAIRS : {});
        const close = map[text];
        const before = view.state.doc.textBetween($start(view, from), from);
        const next = view.state.doc.textBetween(to, Math.min(to + text.length, view.state.doc.content.size));
        const isCloser = Object.values(map).includes(text);
        // Fallback if beforeinput did not fire (programmatic insertText).
        if (from === to && isCloser && next === text) {
          view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, from + 1)).scrollIntoView());
          return true;
        }
        if (!close || from !== to) return false;
        // Pair "[" only as the first character of an empty paragraph.
        if (text === "[" && (before.length > 0 || view.state.doc.resolve(from).parent.content.size > 0)) return false;
        if ((text === "*" || text === "_" || text === "`" || text === "~" || text === "=") && before.endsWith(text)) return false;
        const tr = view.state.tr.insertText(text + close, from, to);
        tr.setSelection(TextSelection.create(tr.doc, from + 1));
        view.dispatch(tr.scrollIntoView());
        return true;
      },
      handleKeyDown(view, event) {
        if (event.key !== "Backspace" || view.composing) return false;
        if (!pairBracketsOn() && !pairMarkdownOn()) return false;
        if (blocked(view)) return false;
        const { from, to, empty } = view.state.selection;
        if (!empty) return false;
        const map = pairBracketsOn() ? pairs() : MD_PAIRS;
        const before = from > 0 ? view.state.doc.textBetween(from - 1, from) : "";
        const after = view.state.doc.textBetween(from, Math.min(from + 1, view.state.doc.content.size));
        if (map[before] === after) {
          event.preventDefault();
          view.dispatch(view.state.tr.delete(from - 1, from + 1).scrollIntoView());
          return true;
        }
        return false;
      },
    },
  });
}
