import { inputRules, wrappingInputRule, textblockTypeInputRule, InputRule } from "prosemirror-inputrules";
import { MarkType, NodeType, Schema } from "prosemirror-model";
import { keymap } from "prosemirror-keymap";
import { toggleMark, setBlockType, wrapIn, chainCommands, exitCode, baseKeymap } from "prosemirror-commands";
import { undo, redo } from "prosemirror-history";
import { splitListItem, liftListItem, sinkListItem, wrapInList } from "prosemirror-schema-list";
import { goToNextCell } from "prosemirror-tables";
import { arrowHandler } from "./codeview";
import { inRawRegion } from "./markers";
import { EditorState, TextSelection } from "prosemirror-state";

/** Ctrl+B etc.: toggle the real mark, or — inside a raw region — wrap/unwrap literal delimiters */
function fmt(mark: MarkType, delim: string) {
  const toggle = toggleMark(mark);
  return (state: EditorState, dispatch?: any, view?: any) => {
    if (!inRawRegion(state)) return toggle(state, dispatch, view);
    const { from, to } = state.selection; const d = delim.length;
    const doc = state.doc;
    if (dispatch) {
      const before = from >= d ? doc.textBetween(from - d, from) : "", after = doc.textBetween(to, Math.min(to + d, doc.content.size));
      let tr = state.tr;
      if (before === delim && after === delim) { tr = tr.delete(to, to + d).delete(from - d, from); tr.setSelection(TextSelection.create(tr.doc, from - d, to - d)); }
      else { tr = tr.insertText(delim, to).insertText(delim, from); tr.setSelection(TextSelection.create(tr.doc, from + d, to + d)); }
      dispatch(tr.scrollIntoView());
    }
    return true;
  };
}

function markRule(re: RegExp, type: MarkType) {
  return new InputRule(re, (state, match, start, end) => {
    if (inRawRegion(state)) return null; // raw Markdown is being edited literally
    const inner = match[2]; if (!inner) return null;
    const tr = state.tr; const textStart = start + match[0].indexOf(inner);
    tr.replaceWith(start, end, state.schema.text(inner, [type.create()]));
    tr.removeStoredMark(type);
    void textStart; return tr;
  });
}

export function buildInputRules(s: Schema) {
  const n = s.nodes, m = s.marks;
  return inputRules({ rules: [
    wrappingInputRule(/^\s*>\s$/, n.blockquote),
    wrappingInputRule(/^(\d+)\.\s$/, n.ordered_list, (mm) => ({ order: +mm[1] }), (mm, node) => node.childCount + node.attrs.order == +mm[1]),
    wrappingInputRule(/^\s*([-+*])\s$/, n.bullet_list, (mm) => ({ bullet: mm[1] })),
    new InputRule(/^\[( |x)\]\s$/, (state, match, start, end) => {
      const $s = state.doc.resolve(start);
      for (let d = $s.depth; d > 0; d--) if ($s.node(d).type === n.list_item) {
        return state.tr.delete(start, end).setNodeMarkup($s.before(d), undefined, { checked: match[1] === "x" });
      }
      return null;
    }),
    textblockTypeInputRule(/^```([^\s`]*)\s$/, n.code_block, (mm) => ({ params: mm[1] })),
    textblockTypeInputRule(/^\$\$\s$/, n.math_block),
    textblockTypeInputRule(/^(#{1,6})\s$/, n.heading, (mm) => ({ level: mm[1].length })),
    new InputRule(/^(?:---|\*\*\*|___)$/, (state, _m, start, end) => {
      const $s = state.doc.resolve(start); if ($s.parent.type !== n.paragraph) return null;
      return state.tr.replaceRangeWith($s.before(), $s.after(), n.horizontal_rule.create()).scrollIntoView();
    }),
    markRule(/(\*\*|__)([^*_]+)\1$/, m.strong),
    markRule(/(?<![*\w])(\*|_)([^*_\s][^*_]*)\1$/, m.em),
    markRule(/(`)([^`]+)`$/, m.code),
    markRule(/(~~)([^~]+)~~$/, m.strike),
    markRule(/(==)([^=]+)==$/, m.highlight),
    new InputRule(/(?<!\$)\$([^$\s][^$]*)\$$/, (state, match, start, end) => inRawRegion(state) ? null : state.tr.replaceWith(start, end, n.inline_math.create({ tex: match[1] }))),
  ]});
}

export function buildKeymaps(s: Schema, extra: { toggleSource: () => void; save: () => void; saveAs: () => void; open: () => void; openFolder: () => void; palette: () => void }) {
  const n = s.nodes, m = s.marks;
  const heading = (l: number) => setBlockType(n.heading, { level: l });
  const keys: Record<string, any> = {
    "Mod-z": undo, "Shift-Mod-z": redo, "Mod-y": redo,
    "Mod-b": fmt(m.strong, "**"), "Mod-i": fmt(m.em, "*"), "Shift-Mod-`": fmt(m.code, "`"), "Alt-Shift-5": fmt(m.strike, "~~"),
    "Mod-0": setBlockType(n.paragraph), "Mod-1": heading(1), "Mod-2": heading(2), "Mod-3": heading(3), "Mod-4": heading(4), "Mod-5": heading(5), "Mod-6": heading(6),
    "Shift-Mod-q": wrapIn(n.blockquote), "Shift-Mod-]": wrapInList(n.bullet_list), "Shift-Mod-[": wrapInList(n.ordered_list),
    "Shift-Mod-k": setBlockType(n.code_block),
    Enter: splitListItem(n.list_item), "Mod-[": liftListItem(n.list_item), "Mod-]": sinkListItem(n.list_item),
    Tab: chainCommands(goToNextCell(1), sinkListItem(n.list_item)), "Shift-Tab": chainCommands(goToNextCell(-1), liftListItem(n.list_item)),
    "Shift-Enter": chainCommands(exitCode, (st: any, d: any) => { d?.(st.tr.replaceSelectionWith(n.hard_break.create()).scrollIntoView()); return true; }),
    ArrowLeft: arrowHandler("left"), ArrowRight: arrowHandler("right"), ArrowUp: arrowHandler("up"), ArrowDown: arrowHandler("down"),
    "Mod-/": () => { extra.toggleSource(); return true; },
    "Mod-s": () => { extra.save(); return true; }, "Shift-Mod-s": () => { extra.saveAs(); return true; },
    "Mod-o": () => { extra.open(); return true; }, "Shift-Mod-o": () => { extra.openFolder(); return true; },
    "Shift-Mod-p": () => { extra.palette(); return true; },
  };
  return [keymap(keys), keymap(baseKeymap)];
}
