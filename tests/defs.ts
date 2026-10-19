// Typed definitions become blocks on leave; Enter in footnote definitions. Run: npx tsx tests/defs.ts
import { EditorState, TextSelection } from "prosemirror-state";
import { parseMarkdown, serializeMarkdown } from "../src/editor/markdown";
import { markersPlugin, collapseAll } from "../src/editor/markers";
import { defsPlugin, defsKeymap } from "../src/editor/defs";
let fail = 0;
const ok = (c: boolean, msg: string) => { console.log((c ? "PASS " : "FAIL ") + msg); if (!c) fail++; };
const km = defsKeymap();
const mk = (md: string) => EditorState.create({ doc: parseMarkdown(md), plugins: [markersPlugin(), defsPlugin(), km] });
const posOf = (st: EditorState, needle: string, d = 0) => { let r = -1; st.doc.descendants((n, p) => { if (r < 0 && n.isText && n.text!.includes(needle)) r = p + n.text!.indexOf(needle) + d; }); return r; };
const md = (st: EditorState) => serializeMarkdown(collapseAll(st.doc));
const types = (st: EditorState) => { const t: string[] = []; st.doc.forEach((n) => t.push(n.type.name)); return t.join(","); };
const typeAt = (st: EditorState, pos: number, text: string) => { for (const ch of text) { st = st.apply(st.tr.insertText(ch, pos)); pos++; } return st; };
const enter = (st: EditorState) => { let out = st; (km.props.handleKeyDown as any)({ state: st, dispatch: (tr: any) => { out = st.apply(tr); } }, { key: "Enter", keyCode: 13, shiftKey: false, altKey: false, ctrlKey: false, metaKey: false } as any); return out; };
const sel = (st: EditorState, pos: number) => st.apply(st.tr.setSelection(TextSelection.create(st.doc, pos)));

// 1. typed footnote definition
let st = mk("Text with a note[^1].\n\nlast\n");
let p = posOf(st, "last") + 4;
st = st.apply(st.tr.split(p)); p += 2;
st = typeAt(sel(st, p), p, "[^1]: The *note* text");
ok(types(st).endsWith("paragraph"), "while caret inside: still a paragraph → " + types(st));
st = sel(st, 2);
ok(types(st) === "paragraph,paragraph,footnote_def", "leaving → footnote_def → " + types(st));
ok(md(st) === "Text with a note[^1].\n\nlast\n\n[^1]: The *note* text\n", "markdown → " + JSON.stringify(md(st)));
// 2. typed link definition resolves an earlier literal reference
st = mk("See [the docs][d] now.\n\nlast\n");
ok(!JSON.stringify(st.doc.toJSON()).includes('"link"'), "undefined ref is literal before the definition exists");
p = posOf(st, "last") + 4; st = st.apply(st.tr.split(p)); p += 2;
st = typeAt(sel(st, p), p, "[d]: https://docs.example");
st = sel(st, 2);
ok(types(st) === "paragraph,paragraph,link_def", "leaving → link_def → " + types(st));
let href = ""; st.doc.descendants((n) => { const m = n.marks.find((x) => x.type.name === "link"); if (m) href = m.attrs.href; });
ok(href === "https://docs.example", "earlier [the docs][d] now resolves → " + href);
ok(md(st) === "See [the docs][d] now.\n\nlast\n\n[d]: https://docs.example\n", "markdown → " + JSON.stringify(md(st)));
// not a definition: stays a paragraph
st = mk("x\n\n[nope]: has spaces in dest and more\n");
st = sel(st, 1);
st = st.apply(st.tr.insertText("y", 1));
ok(types(st) === "paragraph,paragraph", "invalid definition text stays a paragraph → " + types(st));
// 3. Enter in the middle of a footnote definition → rest goes to a new paragraph, no duplicate label
st = mk("a[^n]\n\n[^n]: first half second half\n");
p = posOf(st, " second");
st = enter(sel(st, p));
ok(types(st) === "paragraph,footnote_def,paragraph", "Enter mid-definition → def + paragraph → " + types(st));
ok(md(st) === "a[^n]\n\n[^n]: first half\n\nsecond half\n", "no duplicate [^n]: → " + JSON.stringify(md(st)));
// Enter at the end → empty paragraph after
st = mk("a[^n]\n\n[^n]: note\n");
st = enter(sel(st, posOf(st, "note", 4)));
ok(types(st) === "paragraph,footnote_def,paragraph" && st.selection.$from.parent.type.name === "paragraph", "Enter at end → new paragraph, caret there");
// Enter on an empty definition → becomes a paragraph
st = mk("a[^n]\n\n[^n]: x\n");
const x = posOf(st, "x"); st = st.apply(st.tr.delete(x, x + 1));
st = enter(sel(st, x));
ok(types(st) === "paragraph,paragraph", "Enter on empty def → paragraph → " + types(st));
console.log(fail ? `${fail} FAILED` : "all passed");
process.exit(fail ? 1 : 0);
