import { inputRules, wrappingInputRule, textblockTypeInputRule, InputRule } from "prosemirror-inputrules";
import { MarkType, NodeType, Schema } from "prosemirror-model";
import { keymap } from "prosemirror-keymap";
import { toggleMark, setBlockType, wrapIn, chainCommands, exitCode, baseKeymap } from "prosemirror-commands";
import { undo, redo } from "prosemirror-history";
import { splitListItem, liftListItem, sinkListItem, wrapInList } from "prosemirror-schema-list";
import { goToNextCell, addRowAfter, isInTable } from "prosemirror-tables";
import { arrowHandler } from "./codeview";
import { inRawRegion } from "./markers";
import { EditorState, TextSelection } from "prosemirror-state";
import { blockEnterRule, taskListFromParagraph } from "./blockenter";
import { smartPunctRules } from "./smartpunct";
export { tableCells } from "./blockenter";

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
    new InputRule(/^\[([ xX])\]\s$/, taskListFromParagraph),
    textblockTypeInputRule(/^```([^\s`]*)\s$/, n.code_block, (mm) => ({ params: mm[1] })),
    textblockTypeInputRule(/^\$\$\s$/, n.math_block),
    textblockTypeInputRule(/^(#{1,6})\s$/, n.heading, (mm) => ({ level: mm[1].length })),
    new InputRule(/^(?:---|\*\*\*|___)$/, (state, match, start) => {
      const $s = state.doc.resolve(start); if ($s.parent.type !== n.paragraph) return null;
      // First-line `---` waits for Enter so it can become YAML front matter.
      if (match[0] === "---" && $s.index(0) === 0 && state.doc.firstChild?.type !== n.front_matter) return null;
      return state.tr.replaceRangeWith($s.before(), $s.after(), n.horizontal_rule.create()).scrollIntoView();
    }),
    markRule(/(\*\*|__)([^*_]+)\1$/, m.strong),
    markRule(/(?<![*\w])(\*|_)([^*_\s][^*_]*)\1$/, m.em),
    markRule(/(`)([^`]+)`$/, m.code),
    markRule(/(~~)([^~]+)~~$/, m.strike),
    markRule(/(==)([^=]+)==$/, m.highlight),
    markRule(/(<u>)([^<]+)<\/u>$/, m.underline),
    markRule(/(\^)([^^\s]+)\^$/, m.superscript),
    markRule(/(?<!~)(~)([^~\s]+)~(?!~)$/, m.subscript),
    new InputRule(/(?<!\$)\$([^$\s][^$]*)\$$/, (state, match, start, end) => inRawRegion(state) ? null : state.tr.replaceWith(start, end, n.inline_math.create({ tex: match[1] }))),
    ...smartPunctRules(),
  ]});
}


export function buildKeymaps(s: Schema, extra: { toggleSource: () => void; save: () => void; saveAs: () => void; open: () => void; openFolder: () => void; palette: () => void; claimed?: (id: string) => boolean }) {
  const n = s.nodes, m = s.marks;
  const heading = (l: number) => setBlockType(n.heading, { level: l });
  // The shell dispatcher owns these. Skip when it already ran the matching command.
  const skip = (id: string, fn: any) => (st: any, d: any, v: any) => extra.claimed?.(id) ? true : fn(st, d, v);
  const keys: Record<string, any> = {
    "Mod-Enter": (st: any, d: any) => isInTable(st) ? addRowAfter(st, d) : exitCode(st, d),
    // The shell dispatcher also binds Mod-z. If it already undid, swallow this so one Ctrl+Z
    // reverts a single conversion instead of two history steps.
    "Mod-z": (st: any, d: any, v: any) => undo(st, d, v),
    "Shift-Mod-z": skip("edit.redo", redo), "Mod-y": skip("edit.redo", redo),
    "Mod-b": skip("format.strong", fmt(m.strong, "**")), "Mod-i": skip("format.emphasis", fmt(m.em, "*")),
    "Shift-Mod-`": skip("format.code", fmt(m.code, "`")), "Alt-Shift-5": skip("format.strike", fmt(m.strike, "~~")),
    "Mod-0": skip("paragraph.paragraph", setBlockType(n.paragraph)),
    "Mod-1": skip("paragraph.heading.1", heading(1)), "Mod-2": skip("paragraph.heading.2", heading(2)),
    "Mod-3": skip("paragraph.heading.3", heading(3)), "Mod-4": skip("paragraph.heading.4", heading(4)),
    "Mod-5": skip("paragraph.heading.5", heading(5)), "Mod-6": skip("paragraph.heading.6", heading(6)),
    "Shift-Mod-q": skip("paragraph.quote", wrapIn(n.blockquote)),
    "Shift-Mod-]": skip("paragraph.unorderedList", wrapInList(n.bullet_list)),
    "Shift-Mod-[": skip("paragraph.orderedList", wrapInList(n.ordered_list)),
    "Shift-Mod-k": skip("paragraph.codeFence", setBlockType(n.code_block)),
    Enter: chainCommands(blockEnterRule, splitListItem(n.list_item)),
    "Mod-[": liftListItem(n.list_item), "Mod-]": sinkListItem(n.list_item),
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
