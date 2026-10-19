// Definitions typed as plain paragraphs become definition blocks as soon as the caret leaves them:
//   "[^label]: text"   → footnote_def (inline content kept, including formatting)
//   "[id]: url "title"" → link_def (and reference links elsewhere in the document re-resolve)
// Also: Enter inside a footnote definition never duplicates the label.
import { Plugin, PluginKey, EditorState, Transaction, TextSelection } from "prosemirror-state";
import { keymap } from "prosemirror-keymap";
import { Node as PMNode, Fragment } from "prosemirror-model";
import { schema } from "./schema";
import { md, refEnvFor, reparseInlineWithEnv } from "./markdown";

const FN_PREFIX = /^\[\^([^\]\s]+)\]:[ \t]?/;
const src = schema.marks.md_src;

/** replacement node for a paragraph that is really a definition, or null */
export function definitionFor(p: PMNode): PMNode | null {
  if (p.type !== schema.nodes.paragraph || !p.childCount) return null;
  let raw = false; p.descendants((n) => { if (src.isInSet(n.marks)) raw = true; });
  if (raw) return null; // still being edited as raw markdown
  const first = p.firstChild!;
  // markers re-parse turns a typed "[^1]" into a footnote_ref: [footnote_ref][":" + text…]
  if (first.type === schema.nodes.footnote_ref) {
    const second = p.childCount > 1 ? p.child(1) : null;
    if (second?.isText && second.text!.startsWith(":")) {
      const cut = first.nodeSize + (/^:[ \t]?/.exec(second.text!)![0].length);
      return schema.nodes.footnote_def.create({ label: first.attrs.label }, p.content.cut(cut));
    }
    return null;
  }
  if (first.isText) {
    const m = FN_PREFIX.exec(first.text!);
    if (m) return schema.nodes.footnote_def.create({ label: m[1] }, p.content.cut(m[0].length));
  }
  const text = p.textContent;
  if (text.startsWith("[") && !text.startsWith("[^") && /\]:/.test(text)) {
    const toks = md.parse(text, {});
    if (toks.length && toks.every((t: any) => t.type === "link_def")) return schema.nodes.link_def.create(null, schema.text(text));
  }
  return null;
}

function convert(state: EditorState): Transaction | null {
  const head = state.selection.head;
  const hits: { pos: number; node: PMNode; repl: PMNode }[] = [];
  state.doc.descendants((n, pos) => {
    if (n.type === schema.nodes.paragraph) {
      if (!(head >= pos && head <= pos + n.nodeSize)) { const r = definitionFor(n); if (r) hits.push({ pos, node: n, repl: r }); }
      return false;
    }
    return !n.isTextblock;
  });
  if (!hits.length) return null;
  const tr = state.tr;
  for (const h of hits.reverse()) tr.replaceWith(h.pos, h.pos + h.node.nodeSize, h.repl);
  if (hits.some((h) => h.repl.type === schema.nodes.link_def)) resolveRefs(tr);
  return tr.setMeta(defsKey, true);
}

/** after a new link definition: turn literal "[text][id]" in other blocks into reference links */
function resolveRefs(tr: Transaction) {
  const env = refEnvFor(tr.doc);
  const todo: { pos: number; node: PMNode; content: Fragment }[] = [];
  const links = (n: PMNode) => { let c = 0; n.descendants((x) => { c += x.marks.filter((m) => m.type.name === "link" && m.attrs.refType).length; }); return c; };
  tr.doc.descendants((n, pos) => {
    if (n.isTextblock) {
      if (!n.type.spec.code && /\[[^\]]*\]/.test(n.textContent)) {
        let raw = false; n.descendants((x) => { if (src.isInSet(x.marks)) raw = true; });
        const re = raw ? null : reparseInlineWithEnv(n, env);
        if (re && links(re) > links(n)) todo.push({ pos, node: n, content: re.content });
      }
      return false;
    }
    return true;
  });
  for (const t of todo.reverse()) tr.replaceWith(t.pos + 1, t.pos + t.node.nodeSize - 1, t.content);
}

export const defsKey = new PluginKey("md-defs");
export function defsPlugin() {
  return new Plugin({
    key: defsKey,
    appendTransaction(trs, _old, state) {
      if (!trs.some((t) => t.docChanged || t.selectionSet) || trs.some((t) => t.getMeta(defsKey))) return null;
      return convert(state);
    },
  });
}

/** Enter in a footnote definition: the text after the caret continues in a normal paragraph after the
 *  definition (no second "[^label]:"); on an empty definition, turn it into a paragraph. Enter on an
 *  empty last line of a link-definition block leaves the block. */
export function defsKeymap() {
  return keymap({
    Enter: (state, dispatch) => {
      const { $from, $to } = state.selection;
      const parent = $from.parent;
      if (parent.type === schema.nodes.footnote_def && $from.sameParent($to)) {
        if (!dispatch) return true;
        const tr = state.tr;
        if (!parent.content.size) { tr.setNodeMarkup($from.before(), schema.nodes.paragraph); dispatch(tr.scrollIntoView()); return true; }
        if (!state.selection.empty) tr.deleteSelection();
        const pos = tr.selection.from;
        tr.split(pos, 1, [{ type: schema.nodes.paragraph }]);
        // leading blanks of a paragraph would be dropped on reload anyway
        const $n = tr.selection.$from; const lead = /^[ \t]+/.exec($n.parent.textContent);
        if (lead && $n.parentOffset === 0) tr.delete($n.pos, $n.pos + lead[0].length);
        dispatch(tr.scrollIntoView());
        return true;
      }
      if (parent.type === schema.nodes.link_def && state.selection.empty && $from.parentOffset === parent.content.size && parent.textContent.endsWith("\n")) {
        if (!dispatch) return true;
        const tr = state.tr.delete($from.pos - 1, $from.pos);
        const after = tr.mapping.map($from.after());
        tr.insert(after, schema.nodes.paragraph.create());
        tr.setSelection(TextSelection.create(tr.doc, after + 1));
        dispatch(tr.scrollIntoView());
        return true;
      }
      return false;
    },
  });
}
