// Core slash items. Registered at startup whether or not AI is on.
// The AI item is registered by the AI plugin and still appears when AI is on.
import type { EditorView } from "prosemirror-view";
import { TextSelection } from "prosemirror-state";
import { setBlockType, wrapIn } from "prosemirror-commands";
import { wrapInList } from "prosemirror-schema-list";
import { schema } from "./schema";
import { registerSlashItem } from "./slash";
import { insertTable } from "./tabletools";

export interface SlashHost {
  insertImage: () => void;
  promptLink: (from: number) => void;
}

function replaceBlock(view: EditorView, from: number, fn: (state: any, dispatch?: any) => boolean) {
  view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, Math.max(1, Math.min(from, view.state.doc.content.size - 1)))));
  fn(view.state, view.dispatch);
  view.focus();
}

function replaceTop(view: EditorView, nodes: any | any[]) {
  const { $from } = view.state.selection;
  const at = $from.depth ? $from.before(1) : $from.pos;
  const end = $from.depth ? $from.after(1) : $from.pos;
  const list = Array.isArray(nodes) ? nodes : [nodes];
  view.dispatch(view.state.tr.replaceWith(at, end, list).scrollIntoView());
  view.focus();
}

export function insertTask(view: EditorView) {
  const item = schema.nodes.list_item.create({ checked: false }, schema.nodes.paragraph.create());
  replaceTop(view, schema.nodes.bullet_list.create(null, item));
}

export function insertMermaid(view: EditorView) {
  const node = schema.nodes.code_block.create({ params: "mermaid" }, schema.text("graph LR\n  A --> B"));
  replaceTop(view, [node, schema.nodes.paragraph.create()]);
}

export function insertFootnote(view: EditorView) {
  let n = 1;
  view.state.doc.descendants((node) => { if (node.type.name === "footnote_def" || node.type.name === "footnote_ref") n++; });
  const label = String(n);
  const ref = schema.nodes.footnote_ref.create({ label });
  const def = schema.nodes.footnote_def.create({ label }, schema.text("note"));
  let tr = view.state.tr.replaceSelectionWith(ref);
  tr = tr.insert(tr.doc.content.size, def);
  view.dispatch(tr.scrollIntoView());
  view.focus();
}

export function insertLinkRef(view: EditorView) {
  const id = "ref";
  const link = schema.text("link", [schema.marks.link.create({ href: "", refType: "full", ref: id })]);
  let tr = view.state.tr.replaceSelectionWith(link, false);
  const def = schema.nodes.link_def.create(null, schema.text(`[${id}]: https://example.com`));
  tr = tr.insert(tr.doc.content.size, def);
  view.dispatch(tr.scrollIntoView());
  view.focus();
}

export function insertFrontMatter(view: EditorView) {
  if (view.state.doc.firstChild?.type === schema.nodes.front_matter) return;
  const fm = schema.nodes.front_matter.create();
  view.dispatch(view.state.tr.insert(0, fm).scrollIntoView());
  view.focus();
}

export function insertAlert(view: EditorView, kind: string) {
  const quote = schema.nodes.blockquote.create(null, [
    schema.nodes.paragraph.create(null, schema.text(`[!${kind}]`)),
    schema.nodes.paragraph.create(),
  ]);
  replaceTop(view, quote);
}

export function insertHr(view: EditorView) {
  replaceTop(view, [schema.nodes.horizontal_rule.create(), schema.nodes.paragraph.create()]);
}

export function insertToc(view: EditorView) {
  replaceTop(view, [schema.nodes.toc.create(), schema.nodes.paragraph.create()]);
}

/** Register every core item on the live editor. */
export function registerCoreSlash(view: EditorView, host: SlashHost) {
  const items: { id: string; title: string; hint: string; run: (from: number) => void }[] = [
    { id: "h1", title: "Heading 1", hint: "h1 heading", run: (from) => replaceBlock(view, from, setBlockType(schema.nodes.heading, { level: 1 })) },
    { id: "h2", title: "Heading 2", hint: "h2 heading", run: (from) => replaceBlock(view, from, setBlockType(schema.nodes.heading, { level: 2 })) },
    { id: "h3", title: "Heading 3", hint: "h3 heading", run: (from) => replaceBlock(view, from, setBlockType(schema.nodes.heading, { level: 3 })) },
    { id: "h4", title: "Heading 4", hint: "h4 heading", run: (from) => replaceBlock(view, from, setBlockType(schema.nodes.heading, { level: 4 })) },
    { id: "h5", title: "Heading 5", hint: "h5 heading", run: (from) => replaceBlock(view, from, setBlockType(schema.nodes.heading, { level: 5 })) },
    { id: "h6", title: "Heading 6", hint: "h6 heading", run: (from) => replaceBlock(view, from, setBlockType(schema.nodes.heading, { level: 6 })) },
    { id: "paragraph", title: "Paragraph", hint: "paragraph text", run: (from) => replaceBlock(view, from, setBlockType(schema.nodes.paragraph)) },
    { id: "bullet", title: "Bullet List", hint: "bullet ul list", run: (from) => replaceBlock(view, from, wrapInList(schema.nodes.bullet_list)) },
    { id: "numbered", title: "Numbered List", hint: "numbered ol ordered", run: (from) => replaceBlock(view, from, wrapInList(schema.nodes.ordered_list)) },
    { id: "task", title: "Task List", hint: "task checkbox todo", run: () => insertTask(view) },
    { id: "quote", title: "Quote", hint: "quote blockquote", run: (from) => replaceBlock(view, from, wrapIn(schema.nodes.blockquote)) },
    { id: "table", title: "Table", hint: "table grid", run: () => { insertTable(3, 3)(view.state, view.dispatch); view.focus(); } },
    { id: "code", title: "Code Block", hint: "code fence", run: (from) => replaceBlock(view, from, setBlockType(schema.nodes.code_block)) },
    { id: "math", title: "Math Block", hint: "math latex $$", run: (from) => replaceBlock(view, from, setBlockType(schema.nodes.math_block)) },
    { id: "mermaid", title: "Mermaid Diagram", hint: "mermaid diagram", run: () => insertMermaid(view) },
    { id: "hr", title: "Horizontal Line", hint: "hr rule line", run: () => insertHr(view) },
    { id: "toc", title: "Table of Contents", hint: "toc contents", run: () => insertToc(view) },
    { id: "footnote", title: "Footnote", hint: "footnote note", run: () => insertFootnote(view) },
    { id: "linkref", title: "Link Reference", hint: "link reference ref", run: () => insertLinkRef(view) },
    { id: "image", title: "Image…", hint: "image picture", run: () => host.insertImage() },
    { id: "link", title: "Link", hint: "link url", run: (from) => host.promptLink(from) },
    { id: "frontmatter", title: "Front Matter", hint: "front matter yaml", run: () => insertFrontMatter(view) },
    { id: "alert", title: "Callout/Alert", hint: "alert callout note", run: () => insertAlert(view, "NOTE") },
  ];
  for (const it of items) {
    registerSlashItem(view, { id: it.id, title: it.title, hint: it.hint, owner: "core", run: ({ from }) => it.run(from) });
  }
}
