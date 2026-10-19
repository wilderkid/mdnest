// mdnest document schema. DOM output follows the public Typora theme DOM contract
// (semantic tags + cid/mdtype attributes + span[md-inline] wrappers) so gallery themes apply.
import { Schema, NodeSpec, MarkSpec } from "prosemirror-model";
import { tableNodes } from "prosemirror-tables";

let cidCounter = 0;
export const nextCid = () => "n" + ++cidCounter;

const block = (mdtype: string, tag: string, extra: Record<string, string> = {}) =>
  (_n: any) => [tag, { mdtype, ...extra }, 0] as any;

const nodes: Record<string, NodeSpec> = {
  doc: { content: "front_matter? block+" },
  front_matter: {
    content: "text*", marks: "", code: true, defining: true,
    parseDOM: [{ tag: "pre.md-meta-block", preserveWhitespace: "full" }],
    toDOM: () => ["pre", { class: "md-meta-block md-end-block", mdtype: "meta_block" }, 0],
  },
  paragraph: {
    content: "inline*", group: "block",
    parseDOM: [{ tag: "p" }],
    toDOM: () => ["p", { mdtype: "paragraph", class: "md-end-block md-p" }, 0],
  },
  heading: {
    attrs: { level: { default: 1 } }, content: "inline*", group: "block", defining: true,
    parseDOM: [1, 2, 3, 4, 5, 6].map((l) => ({ tag: "h" + l, attrs: { level: l } })),
    toDOM: (n) => ["h" + n.attrs.level, { mdtype: "heading", class: "md-end-block md-heading" }, 0],
  },
  blockquote: {
    content: "block+", group: "block", defining: true,
    parseDOM: [{ tag: "blockquote" }], toDOM: block("blockquote", "blockquote"),
  },
  horizontal_rule: {
    group: "block", parseDOM: [{ tag: "hr" }],
    toDOM: () => ["hr", { mdtype: "hr" }],
  },
  code_block: {
    attrs: { params: { default: "" } }, content: "text*", marks: "", group: "block", code: true, defining: true,
    parseDOM: [{ tag: "pre", preserveWhitespace: "full", getAttrs: (d: any) => ({ params: d.getAttribute("lang") || "" }) }],
    toDOM: (n) => ["pre", { class: "md-fences md-end-block", mdtype: "fences", lang: n.attrs.params }, ["code", 0]],
  },
  math_block: {
    content: "text*", marks: "", group: "block", code: true, defining: true,
    parseDOM: [{ tag: "div.md-math-block", preserveWhitespace: "full" }],
    toDOM: () => ["div", { class: "md-math-block md-end-block", mdtype: "math_block" }, ["pre", 0]],
  },
  toc: {
    group: "block", atom: true, selectable: true,
    parseDOM: [{ tag: "div.md-toc" }], toDOM: () => ["div", { class: "md-toc", mdtype: "toc" }],
  },
  html_block: {
    attrs: { html: { default: "" } }, group: "block", atom: true,
    toDOM: () => ["div", { class: "md-htmlblock md-rawblock", mdtype: "html_block" }],
  },
  ordered_list: {
    attrs: { order: { default: 1 }, tight: { default: true } }, content: "list_item+", group: "block",
    parseDOM: [{ tag: "ol" }],
    toDOM: (n) => ["ol", { start: n.attrs.order == 1 ? null : n.attrs.order, mdtype: "list", class: "ol-list" }, 0],
  },
  bullet_list: {
    attrs: { tight: { default: true }, bullet: { default: "-" } }, content: "list_item+", group: "block",
    parseDOM: [{ tag: "ul" }],
    toDOM: (n) => ["ul", { mdtype: "list", class: "ul-list" }, 0],
  },
  list_item: {
    attrs: { checked: { default: null } }, content: "block+", defining: true,
    parseDOM: [{ tag: "li" }],
    toDOM: (n) => n.attrs.checked === null
      ? ["li", { mdtype: "list_item" }, 0]
      : ["li", { mdtype: "list_item", class: "md-task-list-item task-list-item " + (n.attrs.checked ? "task-list-done" : "task-list-not-done") },
          ["input", { type: "checkbox", ...(n.attrs.checked ? { checked: "checked" } : {}) }], ["div", { class: "md-task-content" }, 0]],
  },
  text: { group: "inline" },
  image: {
    inline: true, attrs: { src: {}, alt: { default: null }, title: { default: null } }, group: "inline", draggable: true,
    parseDOM: [{ tag: "img[src]", getAttrs: (d: any) => ({ src: d.getAttribute("src"), title: d.getAttribute("title"), alt: d.getAttribute("alt") }) }],
    toDOM: (n) => ["span", { "md-inline": "image", class: "md-image" }, ["img", { src: resolveImageSrc(n.attrs.src), alt: n.attrs.alt, title: n.attrs.title }]],
  },
  inline_math: {
    inline: true, group: "inline", atom: true, attrs: { tex: { default: "" } },
    toDOM: (n) => ["span", { "md-inline": "inline_math", class: "md-inline-math" }, n.attrs.tex],
  },
  hard_break: {
    inline: true, group: "inline", selectable: false,
    parseDOM: [{ tag: "br" }], toDOM: () => ["br"],
  },
  ...(tableNodes({
    tableGroup: "block", cellContent: "inline*",
    cellAttributes: { align: { default: null, getFromDOM: (d: any) => d.style.textAlign || null,
      setDOMAttr: (v: any, attrs: any) => { if (v) attrs.style = (attrs.style || "") + `text-align:${v};`; } } },
  }) as any),
};
// add mdtype attributes to table nodes for theme compatibility
const wrap = (name: string, mdtype: string, cls?: string) => {
  const orig = nodes[name].toDOM!;
  nodes[name] = { ...nodes[name], toDOM: (n: any) => { const r: any = orig(n); if (Array.isArray(r)) {
      const extra = { mdtype, ...(cls ? { class: cls } : {}) };
      // spec is [tag, attrs?, ...children]: attrs is a plain object, children are arrays or 0
      if (r[1] && typeof r[1] === "object" && !Array.isArray(r[1])) r[1] = { ...r[1], ...extra }; else r.splice(1, 0, extra);
    } return r; } };
};
wrap("table", "table", "md-table");
wrap("table_row", "table_row");
wrap("table_cell", "table_cell");
wrap("table_header", "table_cell");

const inlineMark = (type: string, tag: string): MarkSpec => ({
  parseDOM: [{ tag }],
  toDOM: () => ["span", { "md-inline": type }, [tag, 0]] as any,
});

const marks: Record<string, MarkSpec> = {
  link: {
    attrs: { href: {}, title: { default: null } }, inclusive: false,
    parseDOM: [{ tag: "a[href]", getAttrs: (d: any) => ({ href: d.getAttribute("href"), title: d.getAttribute("title") }) }],
    toDOM: (m) => ["span", { "md-inline": "link" }, ["a", { href: m.attrs.href, title: m.attrs.title }, 0]] as any,
  },
  em: inlineMark("em", "em"),
  strong: inlineMark("strong", "strong"),
  strike: inlineMark("del", "del"),
  highlight: inlineMark("highlight", "mark"),
  code: { ...inlineMark("code", "code"), excludes: "_", code: true } as MarkSpec,
  // Raw-markdown region: while the caret is inside a formatted span, the span is replaced by its
  // Markdown source carrying this mark; it is re-parsed into real marks when the caret leaves.
  md_src: { inclusive: true, excludes: "", parseDOM: [], toDOM: () => ["span", { class: "md-expand md-src" }, 0] as any },
};

export let imageBase = "";
export function setImageBase(b: string) { imageBase = b; }
export function resolveImageSrc(src: string) {
  if (!src || /^(https?:|data:|blob:|\/)/.test(src) || !imageBase) return src;
  return imageBase + src;
}

export const schema = new Schema({ nodes, marks });
