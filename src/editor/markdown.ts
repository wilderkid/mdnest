// Markdown <-> ProseMirror bridge (md-bridge).
// Phase 1 uses prosemirror-markdown + markdown-it: token-stream -> node mapping maintained by the
// ProseMirror author, CommonMark-compliant, with GFM tables/strikethrough built into markdown-it.
// The bridge is isolated behind parseMarkdown()/serializeMarkdown() so it can be swapped for a
// micromark/mdast lossless bridge in Phase 2 without touching the editor.
import MarkdownIt from "markdown-it";
import markPlugin from "markdown-it-mark";
import { MarkdownParser, MarkdownSerializer, MarkdownSerializerState, defaultMarkdownSerializer } from "prosemirror-markdown";
import { Node as PMNode } from "prosemirror-model";
import { schema } from "./schema";

function mathPlugin(md: any) {
  // block: $$ ... $$ on their own lines
  md.block.ruler.before("fence", "math_block", (state, startLine, endLine, silent) => {
    const start = state.bMarks[startLine] + state.tShift[startLine];
    const max = state.eMarks[startLine];
    if (state.src.slice(start, max).trim() !== "$$") return false;
    let next = startLine;
    let found = false;
    while (++next < endLine) {
      const s = state.bMarks[next] + state.tShift[next];
      if (state.src.slice(s, state.eMarks[next]).trim() === "$$") { found = true; break; }
    }
    if (!found) return false;
    if (silent) return true;
    const tok = state.push("math_block", "div", 0);
    tok.block = true;
    tok.content = state.getLines(startLine + 1, next, state.tShift[startLine], false).replace(/\n$/, "");
    tok.map = [startLine, next + 1];
    state.line = next + 1;
    return true;
  }, { alt: ["paragraph", "reference", "blockquote", "list"] });
  // inline: $...$
  md.inline.ruler.after("escape", "math_inline", (state, silent) => {
    if (state.src[state.pos] !== "$" || state.src[state.pos + 1] === "$") return false;
    const end = state.src.indexOf("$", state.pos + 1);
    if (end < 0) return false;
    const content = state.src.slice(state.pos + 1, end);
    if (!content.trim() || /^\s|\s$/.test(content)) return false;
    if (!silent) { const t = state.push("math_inline", "span", 0); t.content = content; }
    state.pos = end + 1;
    return true;
  });
}

function frontMatterPlugin(md: any) {
  md.block.ruler.before("hr", "front_matter", (state, startLine, endLine, silent) => {
    if (startLine !== 0) return false;
    const line0 = state.src.slice(state.bMarks[0], state.eMarks[0]);
    if (line0 !== "---") return false;
    let next = 0;
    while (++next < endLine) {
      const l = state.src.slice(state.bMarks[next], state.eMarks[next]);
      if (l === "---" || l === "...") break;
    }
    if (next >= endLine) return false;
    if (silent) return true;
    const tok = state.push("front_matter", "pre", 0);
    tok.block = true;
    tok.content = state.getLines(1, next, 0, false).replace(/\n$/, "");
    tok.map = [0, next + 1];
    state.line = next + 1;
    return true;
  });
}

/**
 * Typora-style inline marks that CommonMark does not define:
 * `<u>…</u>`, `^x^` superscript, `~x~` subscript (not `~~strike~~`).
 * Inline `<!-- … -->` is kept as a comment token instead of being flattened to text.
 */
function typoraMarks(md: any) {
  md.inline.ruler.before("html_inline", "underline_html", (state: any, silent: boolean) => {
    const m = /^<u>([\s\S]*?)<\/u>/.exec(state.src.slice(state.pos));
    if (!m || state.pos + m[0].length > state.posMax) return false;
    if (m[1].includes("<")) return false;
    if (!silent) {
      state.push("u_open", "u", 1);
      const t = state.push("text", "", 0); t.content = m[1];
      state.push("u_close", "u", -1);
    }
    state.pos += m[0].length;
    return true;
  });
  md.inline.ruler.before("emphasis", "superscript", (state: any, silent: boolean) => {
    const src = state.src;
    if (src.charCodeAt(state.pos) !== 0x5e) return false;
    if (src.charCodeAt(state.pos + 1) === 0x5e || src.charCodeAt(state.pos + 1) === 0x20) return false;
    const end = src.indexOf("^", state.pos + 1);
    if (end < 0 || end === state.pos + 1) return false;
    const inner = src.slice(state.pos + 1, end);
    if (!inner || /\s/.test(inner) || inner.includes("^")) return false;
    if (!silent) {
      state.push("sup_open", "sup", 1);
      const t = state.push("text", "", 0); t.content = inner;
      state.push("sup_close", "sup", -1);
    }
    state.pos = end + 1;
    return true;
  });
  md.inline.ruler.before("emphasis", "subscript", (state: any, silent: boolean) => {
    const src = state.src;
    if (src.charCodeAt(state.pos) !== 0x7e) return false;
    if (src.charCodeAt(state.pos + 1) === 0x7e) return false;
    let i = state.pos + 1;
    while (i < state.posMax && src.charCodeAt(i) !== 0x7e && src.charCodeAt(i) !== 0x20 && src.charCodeAt(i) !== 0x0a) i++;
    if (i === state.pos + 1 || src.charCodeAt(i) !== 0x7e || src.charCodeAt(i + 1) === 0x7e) return false;
    const inner = src.slice(state.pos + 1, i);
    if (!inner) return false;
    if (!silent) {
      state.push("sub_open", "sub", 1);
      const t = state.push("text", "", 0); t.content = inner;
      state.push("sub_close", "sub", -1);
    }
    state.pos = i + 1;
    return true;
  });
  const html = md.inline.ruler.__rules__.find((r: any) => r.name === "html_inline");
  if (html) {
    const orig = html.fn;
    md.inline.ruler.at("html_inline", (state: any, silent: boolean) => {
      const m = /^<!--([\s\S]*?)-->/.exec(state.src.slice(state.pos));
      if (m && state.pos + m[0].length <= state.posMax) {
        if (!silent) {
          const t = state.push("html_comment", "span", 0);
          t.content = m[1];
        }
        state.pos += m[0].length;
        return true;
      }
      return orig(state, silent);
    });
  }
}

function typoraExtras(md: any) {
  md.core.ruler.push("mdnest_extras", (state) => {
    const t = state.tokens;
    for (let i = 0; i < t.length; i++) {
      // [TOC]
      if (t[i].type === "paragraph_open" && t[i + 1]?.type === "inline" && t[i + 1].content.trim().toUpperCase().replace(/\\/g, "") === "[TOC]") {
        const toc = new state.Token("toc", "div", 0); toc.block = true;
        t.splice(i, 3, toc);
        continue;
      }
      // task list items
      if (t[i].type === "list_item_open" && t[i + 1]?.type === "paragraph_open" && t[i + 2]?.type === "inline") {
        const inl = t[i + 2];
        const m = /^\[([ xX])\][ \t]/.exec(inl.content);
        if (m) {
          t[i].attrSet("checked", m[1] === " " ? "false" : "true");
          inl.content = inl.content.slice(m[0].length);
          const first = inl.children?.[0];
          if (first && first.type === "text") first.content = first.content.replace(/^\[([ xX])\][ \t]/, "");
        }
      }
      // inline html -> literal text (kept verbatim on save)
      if (t[i].type === "inline" && t[i].children) {
        for (const c of t[i].children!) if (c.type === "html_inline") { c.type = "text"; }
      }
    }
  });
}

/**
 * Footnotes, kept in place (unlike markdown-it-footnote, which moves definitions to the end):
 *   inline `[^label]` → footnote_ref token; block `[^label]: text` (+ continuation lines) → footnote_def.
 */
function footnotePlugin(md: any) {
  const DEF = /^\[\^([^\]\s]+)\]:[ \t]?/;
  md.block.ruler.before("reference", "footnote_def", (state: any, startLine: number, endLine: number, silent: boolean) => {
    if (state.sCount[startLine] - state.blkIndent >= 4) return false;
    const start = state.bMarks[startLine] + state.tShift[startLine], max = state.eMarks[startLine];
    const m = DEF.exec(state.src.slice(start, max)); if (!m) return false;
    if (silent) return true;
    const lines = [state.src.slice(start + m[0].length, max)];
    let next = startLine + 1;
    const terms = state.md.block.ruler.getRules("paragraph");
    while (next < endLine && !state.isEmpty(next)) {
      const s = state.bMarks[next] + state.tShift[next]; const l = state.src.slice(s, state.eMarks[next]);
      if (state.sCount[next] - state.blkIndent < 4) {
        if (DEF.test(l)) break;
        const old = state.parentType; state.parentType = "paragraph";
        const stop = terms.some((r: any) => r(state, next, endLine, true));
        state.parentType = old; if (stop) break;
      }
      lines.push(l); next++;
    }
    const open = state.push("footnote_def_open", "div", 1);
    open.meta = { label: m[1], tight: next < endLine && !state.isEmpty(next) }; open.block = true; open.map = [startLine, next];
    const inl = state.push("inline", "", 0); inl.content = lines.join("\n"); inl.map = [startLine, next]; inl.children = [];
    state.push("footnote_def_close", "div", -1);
    state.line = next;
    return true;
  }, { alt: ["paragraph", "reference"] });
  md.inline.ruler.before("link", "footnote_ref", (state: any, silent: boolean) => {
    if (state.src.charCodeAt(state.pos) !== 0x5b || state.src.charCodeAt(state.pos + 1) !== 0x5e) return false;
    const m = /^\[\^([^\]\s]+)\]/.exec(state.src.slice(state.pos, state.posMax)); if (!m) return false;
    if (!silent) { const t = state.push("footnote_ref", "sup", 0); t.meta = { label: m[1] }; }
    state.pos += m[0].length;
    return true;
  });
}

/**
 * Reference-style links/images: markdown-it resolves them and drops the definitions. We keep both:
 * runs of `[id]: url "title"` lines become a link_def block (raw text, saved verbatim) and every
 * link/image token records how it was written (full `[t][id]`, collapsed `[t][]`, shortcut `[t]`).
 */
function referencePlugin(md: any) {
  const rules = md.block.ruler.__rules__;
  const orig = rules.find((r: any) => r.name === "reference").fn;
  md.block.ruler.at("reference", (state: any, startLine: number, endLine: number, silent: boolean) => {
    if (silent) return orig(state, startLine, endLine, true);
    if (!orig(state, startLine, endLine, false)) return false;
    const isFootnote = (l: number) => state.src.slice(state.bMarks[l] + state.tShift[l], state.bMarks[l] + state.tShift[l] + 2) === "[^";
    while (state.line < endLine && !state.isEmpty(state.line) && state.sCount[state.line] - state.blkIndent < 4 && !isFootnote(state.line)) {
      if (!orig(state, state.line, endLine, false)) break;
    }
    const tok = state.push("link_def", "div", 0); tok.block = true; tok.map = [startLine, state.line];
    tok.content = state.getLines(startLine, state.line, state.blkIndent, false).replace(/\n+$/, "");
    return true;
  });
  const wrap = (name: string, bang: number) => {
    const fn = md.inline.ruler.__rules__.find((r: any) => r.name === name).fn;
    md.inline.ruler.at(name, (state: any, silent: boolean) => {
      const start = state.pos, n0 = state.tokens.length;
      if (!fn(state, silent)) return false;
      if (silent) return true;
      const end = state.pos; const save = state.pos; state.pos = start;
      const labelEnd = state.md.helpers.parseLinkLabel(state, start + bang, !bang);
      state.pos = save;
      // (pending text is flushed as a text token first, so search for the link/image token)
      let tok: any = null;
      for (let i = n0; i < state.tokens.length; i++) if (state.tokens[i].type === (bang ? "image" : "link_open")) { tok = state.tokens[i]; break; }
      if (labelEnd < 0 || !tok) return true;
      const after = labelEnd + 1;
      let meta: any = null;
      if (end === after) meta = { refType: "shortcut", ref: null };
      else if (state.src[after] === "[") {
        const label = state.src.slice(after + 1, end - 1);
        meta = label ? { refType: "full", ref: label } : { refType: "collapsed", ref: null };
      }
      if (meta) tok.meta = { ...(tok.meta || {}), ...meta };
      return true;
    });
  };
  wrap("link", 0); wrap("image", 1);
}

export const md = new MarkdownIt("commonmark", { html: true })
  .enable(["table", "strikethrough"])
  .use(markPlugin).use(mathPlugin).use(frontMatterPlugin).use(footnotePlugin).use(referencePlugin).use(typoraMarks).use(typoraExtras);

/** markdown-it env holding the link reference definitions found in `doc` (for re-parsing fragments) */
export function refEnvFor(doc: PMNode): any {
  const defs: string[] = [];
  doc.descendants((n) => { if (n.type.name === "link_def") defs.push(n.textContent); return n.isBlock && !n.isTextblock; });
  const env: any = {};
  if (defs.length) md.parse(defs.join("\n\n"), env);
  return env;
}

const listIsTight = (tokens: any[], i: number) => {
  while (++i < tokens.length) if (tokens[i].type !== "list_item_open") return tokens[i].hidden;
  return false;
};

export const parser = new MarkdownParser(schema, md, {
  blockquote: { block: "blockquote" },
  paragraph: { block: "paragraph" },
  list_item: { block: "list_item", getAttrs: (tok) => ({ checked: tok.attrGet("checked") == null ? null : tok.attrGet("checked") === "true" }) },
  bullet_list: { block: "bullet_list", getAttrs: (t, tokens, i) => ({ tight: listIsTight(tokens, i), bullet: t.markup || "-" }) },
  ordered_list: { block: "ordered_list", getAttrs: (tok, tokens, i) => ({ order: +(tok.attrGet("start") || 1), tight: listIsTight(tokens, i) }) },
  heading: { block: "heading", getAttrs: (tok) => ({ level: +tok.tag.slice(1) }) },
  code_block: { block: "code_block", noCloseToken: true },
  fence: { block: "code_block", getAttrs: (tok) => ({ params: tok.info || "" }), noCloseToken: true },
  math_block: { block: "math_block", noCloseToken: true },
  front_matter: { block: "front_matter", noCloseToken: true },
  toc: { node: "toc" },
  html_block: { node: "html_block", getAttrs: (tok) => ({ html: tok.content }) },
  hr: { node: "horizontal_rule" },
  image: { node: "image", getAttrs: (tok) => {
    const style = tok.attrGet("style") || "";
    const zoom = (/width:\s*(\d+)%/.exec(style) || /zoom:\s*(\d+)%/.exec(style) || [])[1] || null;
    return { src: tok.attrGet("src"), title: tok.attrGet("title") || null, alt: tok.children?.[0]?.content || null, refType: tok.meta?.refType ?? null, ref: tok.meta?.ref ?? null, zoom };
  } },
  html_comment: { mark: "comment", noCloseToken: true },
  sup: { mark: "superscript" },
  sub: { mark: "subscript" },
  u: { mark: "underline" },
  footnote_ref: { node: "footnote_ref", getAttrs: (tok) => ({ label: tok.meta.label }) },
  footnote_def: { block: "footnote_def", getAttrs: (tok) => ({ label: tok.meta.label, tight: !!tok.meta.tight }) },
  link_def: { block: "link_def", noCloseToken: true },
  hardbreak: { node: "hard_break" },
  math_inline: { node: "inline_math", getAttrs: (tok) => ({ tex: tok.content }) },
  em: { mark: "em" },
  strong: { mark: "strong" },
  s: { mark: "strike" },
  mark: { mark: "highlight" },
  link: { mark: "link", getAttrs: (tok) => ({ href: tok.attrGet("href"), title: tok.attrGet("title") || null, refType: tok.meta?.refType ?? null, ref: tok.meta?.ref ?? null }) },
  code_inline: { mark: "code", noCloseToken: true },
  table: { block: "table" },
  thead: { ignore: true },
  tbody: { ignore: true },
  tr: { block: "table_row" },
  th: { block: "table_header", getAttrs: (tok) => ({ align: (/text-align:\s*(\w+)/.exec(tok.attrGet("style") || "") || [])[1] || null }) },
  td: { block: "table_cell", getAttrs: (tok) => ({ align: (/text-align:\s*(\w+)/.exec(tok.attrGet("style") || "") || [])[1] || null }) },
});

// prosemirror-markdown turns soft line breaks into spaces, which rewrites every wrapped paragraph on
// save; keep them as "\n" (rendered as a space in export, as a line break while editing).
(parser as any).tokenHandlers.softbreak = (state: any) => state.addText("\n");
const d = defaultMarkdownSerializer;
// ---- minimal bracket escaping ----
// prosemirror-markdown escapes every literal "[" / "]", so e.g. an undefined reference "[x][missing]"
// would be saved as "\[x\]\[missing\]". For each textblock we also render a candidate without bracket
// escapes and keep it when it re-parses (with the document's link definitions) to identical content.
const MSS: any = MarkdownSerializerState;
const origEsc = MSS.prototype.esc;
MSS.prototype.esc = function (str: string, startOfLine = false) {
  if (!this.noBracketEsc) return origEsc.call(this, str, startOfLine);
  const parts = str.split(/([\[\]])/);
  return parts.map((p, i) => (p === "[" || p === "]") ? p : origEsc.call(this, p, startOfLine && i === 0)).join("");
};
let serializeEnv: any = null; // markdown-it env of the document being serialized (null: always escape)
function minimalInline(node: PMNode, options: any = {}): string | null {
  if (!serializeEnv || !/[\[\]]/.test(node.textContent)) return null;
  const sub = new MSS(serializer.nodes, serializer.marks, options); sub.noBracketEsc = true;
  sub.renderInline(node);
  const cand: string = sub.out;
  try {
    const d = (parser as any).parse(cand, { references: serializeEnv.references });
    if (d.childCount === 1 && d.firstChild.type.name === "paragraph" && d.firstChild.content.eq(node.content)) return cand;
  } catch { /* fall back */ }
  return null;
}
/** re-parse a textblock's inline content against `env` (used when a new link definition appears) */
export function reparseInlineWithEnv(node: PMNode, env: any): PMNode | null {
  const sub = new MSS(serializer.nodes, serializer.marks, {}); sub.noBracketEsc = true;
  sub.renderInline(node);
  try {
    const d = (parser as any).parse(sub.out, { references: env.references });
    if (d.childCount === 1 && d.firstChild.type.name === "paragraph") return d.firstChild;
  } catch { /* ignore */ }
  return null;
}
function renderInlineMinimal(state: MarkdownSerializerState, node: PMNode) {
  const cand = minimalInline(node, (state as any).options);
  if (cand == null) state.renderInline(node); else state.text(cand, false);
}
function serializeCellInline(state: MarkdownSerializerState, cell: PMNode) {
  let out = minimalInline(cell);
  if (out == null) { const sub = new MSS(serializer.nodes, serializer.marks, {}); sub.renderInline(cell); out = sub.out as string; }
  return out.replace(/\|/g, "\\|").replace(/\n/g, " ").trim();
}

export const serializer = new MarkdownSerializer({
  ...d.nodes,
  front_matter(state, node) { state.write("---\n"); state.text(node.textContent, false); state.ensureNewLine(); state.write("---"); state.closeBlock(node); },
  math_block(state, node) { state.write("$$\n"); state.text(node.textContent, false); state.ensureNewLine(); state.write("$$"); state.closeBlock(node); },
  toc(state, node) { state.write("[TOC]"); state.closeBlock(node); },
  html_block(state, node) { state.text(node.attrs.html.replace(/\n$/, ""), false); state.closeBlock(node); },
  inline_math(state, node) { state.write("$" + node.attrs.tex + "$"); },
  paragraph(state, node) { renderInlineMinimal(state, node); state.closeBlock(node); },
  heading(state, node) { state.write(state.repeat("#", node.attrs.level) + " "); renderInlineMinimal(state, node); state.closeBlock(node); },
  footnote_ref(state, node) { state.write("[^" + node.attrs.label + "]"); },
  footnote_def(state, node) {
    const st: any = state;
    if (st.closed && st.closed.type === node.type && st.closed.attrs.tight) st.flushClose(1);
    // continuation lines are indented 4 spaces (also accepted lazily when parsing)
    state.wrapBlock("    ", "[^" + node.attrs.label + "]: ", node, () => renderInlineMinimal(state, node));
  },
  link_def(state, node) { state.text(node.textContent, false); state.closeBlock(node); },
  image(state, node, parent, index) {
    const a = node.attrs;
    if (a.zoom && !a.refType) {
      const alt = state.esc(a.alt || "");
      const src = a.src || "";
      const title = a.title ? ` "${String(a.title).replace(/"/g, '\\"')}"` : "";
      state.write(`<img src="${src}" alt="${alt}"${title ? ` title="${String(a.title).replace(/"/g, "&quot;")}"` : ""} style="width:${a.zoom}%;zoom:${a.zoom}%">`);
      return;
    }
    if (!a.refType) return (d.nodes.image as any)(state, node, parent, index);
    state.write("![" + state.esc(a.alt || "") + "]" + (a.refType === "full" ? "[" + a.ref + "]" : a.refType === "collapsed" ? "[]" : ""));
  },
  list_item(state, node) {
    if (node.attrs.checked !== null) state.write(node.attrs.checked ? "[x] " : "[ ] ");
    state.renderContent(node);
  },
  table(state, node) {
    const rows: string[][] = []; const aligns: (string | null)[] = [];
    node.forEach((row, _o, ri) => {
      const cells: string[] = [];
      row.forEach((cell) => { cells.push(serializeCellInline(state, cell)); if (ri === 0) aligns.push(cell.attrs.align); });
      rows.push(cells);
    });
    const cols = Math.max(...rows.map((r) => r.length));
    const line = (r: string[]) => "| " + Array.from({ length: cols }, (_, i) => r[i] ?? "").join(" | ") + " |";
    const sep = "|" + Array.from({ length: cols }, (_, i) => { const a = aligns[i]; return a === "center" ? ":---:" : a === "right" ? "---:" : a === "left" ? ":---" : "---"; }).join("|") + "|";
    state.write(line(rows[0])); state.ensureNewLine(); state.write(sep);
    for (const r of rows.slice(1)) { state.ensureNewLine(); state.write(line(r)); }
    state.closeBlock(node);
  },
  table_row() {}, table_cell() {}, table_header() {},
}, {
  ...d.marks,
  strike: { open: "~~", close: "~~", mixable: true, expelEnclosingWhitespace: true },
  highlight: { open: "==", close: "==", mixable: true, expelEnclosingWhitespace: true },
  underline: { open: "<u>", close: "</u>", mixable: true, expelEnclosingWhitespace: true },
  superscript: { open: "^", close: "^", mixable: true, expelEnclosingWhitespace: true },
  subscript: { open: "~", close: "~", mixable: true, expelEnclosingWhitespace: true },
  comment: { open: "<!--", close: "-->", mixable: true },
  link: {
    open(state, mark, parent, index) {
      if (mark.attrs.refType) { (state as any).inAutolink = false; return "["; }
      return (d.marks.link.open as any)(state, mark, parent, index);
    },
    close(state, mark, parent, index) {
      const a = mark.attrs;
      if (a.refType) { (state as any).inAutolink = undefined; return a.refType === "full" ? "][" + a.ref + "]" : a.refType === "collapsed" ? "][]" : "]"; }
      return (d.marks.link.close as any)(state, mark, parent, index);
    },
    mixable: (d.marks.link as any).mixable,
  },
  md_src: { open: "", close: "" }, // never reached: raw regions are collapsed before serializing
});

export function parseMarkdown(src: string): PMNode {
  const doc = parser.parse(src.replace(/\r\n/g, "\n"));
  return doc ?? schema.node("doc", null, [schema.node("paragraph")]);
}
export function serializeMarkdown(doc: PMNode): string {
  serializeEnv = refEnvFor(doc);
  try { return serializer.serialize(doc, { tightLists: true }).replace(/\s*$/, "\n"); }
  finally { serializeEnv = null; }
}
