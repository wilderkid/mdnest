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

function typoraExtras(md: any) {
  md.core.ruler.push("mdnest_extras", (state) => {
    const t = state.tokens;
    for (let i = 0; i < t.length; i++) {
      // [TOC]
      if (t[i].type === "paragraph_open" && t[i + 1]?.type === "inline" && t[i + 1].content.trim().toUpperCase() === "[TOC]") {
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

export const md = new MarkdownIt("commonmark", { html: true })
  .enable(["table", "strikethrough"])
  .use(markPlugin).use(mathPlugin).use(frontMatterPlugin).use(typoraExtras);

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
  image: { node: "image", getAttrs: (tok) => ({ src: tok.attrGet("src"), title: tok.attrGet("title") || null, alt: tok.children?.[0]?.content || null }) },
  hardbreak: { node: "hard_break" },
  math_inline: { node: "inline_math", getAttrs: (tok) => ({ tex: tok.content }) },
  em: { mark: "em" },
  strong: { mark: "strong" },
  s: { mark: "strike" },
  mark: { mark: "highlight" },
  link: { mark: "link", getAttrs: (tok) => ({ href: tok.attrGet("href"), title: tok.attrGet("title") || null }) },
  code_inline: { mark: "code", noCloseToken: true },
  table: { block: "table" },
  thead: { ignore: true },
  tbody: { ignore: true },
  tr: { block: "table_row" },
  th: { block: "table_header", getAttrs: (tok) => ({ align: (/text-align:\s*(\w+)/.exec(tok.attrGet("style") || "") || [])[1] || null }) },
  td: { block: "table_cell", getAttrs: (tok) => ({ align: (/text-align:\s*(\w+)/.exec(tok.attrGet("style") || "") || [])[1] || null }) },
});

const d = defaultMarkdownSerializer;
function serializeCellInline(state: MarkdownSerializerState, cell: PMNode) {
  const sub = new (MarkdownSerializerState as any)(serializer.nodes, serializer.marks, {});
  sub.renderInline(cell);
  return (sub as any).out.replace(/\|/g, "\\|").replace(/\n/g, " ").trim();
}

export const serializer = new MarkdownSerializer({
  ...d.nodes,
  front_matter(state, node) { state.write("---\n"); state.text(node.textContent, false); state.ensureNewLine(); state.write("---"); state.closeBlock(node); },
  math_block(state, node) { state.write("$$\n"); state.text(node.textContent, false); state.ensureNewLine(); state.write("$$"); state.closeBlock(node); },
  toc(state, node) { state.write("[TOC]"); state.closeBlock(node); },
  html_block(state, node) { state.text(node.attrs.html.replace(/\n$/, ""), false); state.closeBlock(node); },
  inline_math(state, node) { state.write("$" + node.attrs.tex + "$"); },
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
});

export function parseMarkdown(src: string): PMNode {
  const doc = parser.parse(src.replace(/\r\n/g, "\n"));
  return doc ?? schema.node("doc", null, [schema.node("paragraph")]);
}
export function serializeMarkdown(doc: PMNode): string {
  return serializer.serialize(doc, { tightLists: true }).replace(/\s*$/, "\n");
}
