// Auto-pair brackets, quotes, and (optionally) Markdown delimiters.
// Typora defaults: brackets/quotes on, Markdown syntax off. Never inside code or math.
import { Plugin, TextSelection } from "prosemirror-state";
import { EditorView } from "prosemirror-view";
import { inRawRegion } from "./markers";

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
  if (inRawRegion(view.state)) return true;
  if (view.state.storedMarks?.some((m) => m.type.spec.code) || $from.marks().some((m) => m.type.spec.code)) return true;
  return false;
}

function pairs(): Record<string, string> {
  return pairMarkdownOn() ? { ...BRACKETS, ...MD_PAIRS } : { ...BRACKETS };
}

export function autoPairPlugin() {
  return new Plugin({
    props: {
      handleTextInput(view, from, to, text) {
        if (!pairBracketsOn() && !pairMarkdownOn()) return false;
        if (text.length !== 1 || view.composing || blocked(view)) return false;
        const map = pairBracketsOn() ? pairs() : (pairMarkdownOn() ? MD_PAIRS : {});
        const close = map[text];
        const next = view.state.doc.textBetween(to, Math.min(to + text.length, view.state.doc.content.size));
        // Typing the closer over an auto-inserted one skips it.
        if (Object.values(map).includes(text) && next === text && from === to) {
          view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, from + 1)).scrollIntoView());
          return true;
        }
        if (!close || from !== to) return false;
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
