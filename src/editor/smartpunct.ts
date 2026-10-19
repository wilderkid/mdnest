// Smart punctuation, off by default (Typora converts on input only when the option is on).
// Straight quotes become curly quotes, honouring apostrophes. `--` → – and `---` → —.
// `...` → …. Never in code, inline code, math, or a link href. Each conversion is its own
// history step, so Ctrl+Z restores the characters that were typed.

import { InputRule } from "prosemirror-inputrules";
import { closeHistory } from "prosemirror-history";
import { EditorState, Plugin, PluginKey, TextSelection } from "prosemirror-state";
import { EditorView } from "prosemirror-view";

export const SMART_PUNCT_KEY = "mdnest.smartPunct";

export function smartPunctOn(): boolean {
  if (typeof localStorage === "undefined") return false;
  return localStorage.getItem(SMART_PUNCT_KEY) === "1";
}

function blocked(state: EditorState): boolean {
  const { $from } = state.selection;
  if ($from.parent.type.spec.code) return true;
  const name = $from.parent.type.name;
  if (name === "code_block" || name === "math_block" || name === "inline_math" || name === "front_matter") return true;
  const marks = state.storedMarks || $from.marks();
  if (marks.some((m) => m.type.spec.code || m.type.name === "code" || m.type.name === "link")) return true;
  return false;
}

/** Opening quote when the previous character is start, whitespace, or an opening bracket. */
export function curlyQuote(prev: string, ch: '"' | "'"): string {
  const open = !prev || /[\s([{«“‘]$/.test(prev);
  if (ch === '"') return open ? "\u201C" : "\u201D";
  // Apostrophe inside a word (letter or digit on the left) stays a right single quote,
  // which is also the apostrophe glyph.
  return open ? "\u2018" : "\u2019";
}

export function smartPunctRules(): InputRule[] {
  // Quotes typed with auto-pair off still go through input rules. Dashes and ellipses are
  // handled in smartPunctPlugin, which runs before prosemirror-inputrules' /--$/ rule.
  const quote = (ch: '"' | "'") => new InputRule(new RegExp("\\" + ch + "$"), (state, _match, start, end) => {
    if (!smartPunctOn() || blocked(state)) return null;
    const prev = start > 0 ? state.doc.textBetween(start - 1, start) : "";
    return closeHistory(state.tr).insertText(curlyQuote(prev, ch), start, end);
  });
  return [quote('"'), quote("'")];
}

const smartPunctKey = new PluginKey("smartPunct");

interface LastConv { at: number; original: string; glyph: string }

/**
 * Convert `--` / `---` / `...` before other input rules see the keystroke.
 * Two hyphens become an en dash as soon as the second is typed, so a third hyphen
 * upgrades that en dash to an em dash. A line that is only hyphens is left alone
 * so it can still become a horizontal rule or front matter.
 * Each conversion is its own history step. Backspace immediately after restores
 * the characters that were typed.
 */
export function smartPunctPlugin() {
  return new Plugin({
    key: smartPunctKey,
    state: {
      init: (): LastConv | null => null,
      apply(tr, prev): LastConv | null {
        const meta = tr.getMeta(smartPunctKey);
        if (meta === "clear") return null;
        if (meta) return meta as LastConv;
        if (tr.docChanged || tr.selectionSet) return null;
        return prev;
      },
    },
    props: {
      handleTextInput(view, from, to, text) {
        if (!smartPunctOn() || text.length !== 1 || view.composing) return false;
        if (blocked(view.state)) return false;
        if (text !== "-" && text !== ".") return false;
        return convertRun(view, from, to, text);
      },
      handleKeyDown(view, event) {
        if (event.key !== "Backspace" || view.composing || !smartPunctOn()) return false;
        const last = smartPunctKey.getState(view.state) as LastConv | null;
        if (!last) return false;
        const { from, empty } = view.state.selection;
        if (!empty || from !== last.at + last.glyph.length) return false;
        if (view.state.doc.textBetween(last.at, from) !== last.glyph) return false;
        event.preventDefault();
        const tr = closeHistory(view.state.tr).insertText(last.original, last.at, from);
        tr.setSelection(TextSelection.create(tr.doc, last.at + last.original.length));
        tr.setMeta(smartPunctKey, "clear");
        view.dispatch(tr.scrollIntoView());
        return true;
      },
    },
  });
}

function convertRun(view: EditorView, from: number, to: number, text: string): boolean {
  if (from !== to) return false;
  const $from = view.state.doc.resolve(from);
  const prev = $from.parent.textBetween(Math.max(0, $from.parentOffset - 2), $from.parentOffset);
  const seq = prev + text;
  const line = $from.parent.textBetween(0, $from.parentOffset) + text;
  // A paragraph of only hyphens is a rule or front matter, not a dash.
  const onlyHyphens = /^\s*-+$/.test(line);
  let take = 0;
  let glyph = "";
  if (text === "-" && !onlyHyphens && (seq.endsWith("\u2013-") || seq.endsWith("---"))) {
    take = seq.endsWith("---") ? 3 : 2;
    glyph = "\u2014";
  } else if (text === "-" && !onlyHyphens && seq.endsWith("--")) {
    take = 2;
    glyph = "\u2013";
  } else if (text === "." && seq.endsWith("...")) {
    take = 3;
    glyph = "\u2026";
  } else return false;
  const start = from - (take - 1);
  if (start < $from.start()) return false;
  const original = text.repeat(take);
  // Land the typed character as its own history event, then replace the whole run
  // as the next event. One undo restores the characters that were typed.
  view.dispatch(closeHistory(view.state.tr).insertText(text, from, to));
  const end = from + text.length;
  const tr = closeHistory(view.state.tr).setMeta("smart-punct", true).insertText(glyph, start, end);
  tr.setSelection(TextSelection.create(tr.doc, start + glyph.length));
  tr.setMeta(smartPunctKey, { at: start, original, glyph } satisfies LastConv);
  view.dispatch(tr.scrollIntoView());
  return true;
}
