// Unit tests for editable markers (no DOM needed). Run: npx tsx tests/markers.ts
import { EditorState, TextSelection } from "prosemirror-state";
import { parseMarkdown, serializeMarkdown } from "../src/editor/markdown";
import { markersPlugin, collapseAll, srcRanges } from "../src/editor/markers";
let fail = 0;
const ok = (c: boolean, msg: string) => { console.log((c ? "PASS " : "FAIL ") + msg); if (!c) fail++; };
const mk = (md: string) => EditorState.create({ doc: parseMarkdown(md), plugins: [markersPlugin()] });
const posOf = (st: EditorState, needle: string, delta = 0) => { let r = -1; st.doc.descendants((n, p) => { if (r < 0 && n.isText && n.text!.includes(needle)) r = p + n.text!.indexOf(needle) + delta; }); return r; };
const raw = (st: EditorState) => srcRanges(st.doc).map((r) => st.doc.textBetween(r.from, r.to));
const md = (st: EditorState) => serializeMarkdown(collapseAll(st.doc)).trim();

let st = mk("Plain then **bold** and *it* and [link](https://x.y) end.\n\nSecond para.");
st = st.apply(st.tr.setSelection(TextSelection.create(st.doc, posOf(st, "bold", 2))));
ok(raw(st)[0] === "**bold**", "caret in bold expands to **bold** → " + JSON.stringify(raw(st)));
ok(st.doc.textBetween(st.selection.from - 4, st.selection.from) === "**bo", "caret kept between 'bo|ld' → " + st.doc.textBetween(st.selection.from - 4, st.selection.from + 4));
// delete the closing ** → bold removed after leaving
const end = srcRanges(st.doc)[0].to;
st = st.apply(st.tr.delete(end - 2, end));
ok(raw(st)[0] === "**bold", "raw now **bold");
st = st.apply(st.tr.setSelection(TextSelection.create(st.doc, posOf(st, "Second", 1))));
ok(srcRanges(st.doc).length === 0, "leaving collapses raw region");
ok(md(st).startsWith("Plain then \\*\\*bold and *it*"), "unbalanced ** becomes literal text → " + md(st).split("\n")[0]);
// type delimiters around a plain word → becomes formatting
st = mk("make me strong please");
const a = posOf(st, "me"), b = a + 2;
st = st.apply(st.tr.insertText("**", b).insertText("**", a));
st = st.apply(st.tr.setSelection(TextSelection.create(st.doc, 1)));
ok(md(st) === "make **me** strong please", "typed ** delimiters (no raw region) → " + md(st));
// typing ** inside a raw region turns into bold when leaving
st = mk("x *em* y\n\nnext");
st = st.apply(st.tr.setSelection(TextSelection.create(st.doc, posOf(st, "em", 1))));
ok(raw(st)[0] === "*em*", "em expands");
const r0 = srcRanges(st.doc)[0];
st = st.apply(st.tr.insertText("*", r0.to).insertText("*", r0.from));
st = st.apply(st.tr.setSelection(TextSelection.create(st.doc, posOf(st, "next", 1))));
ok(md(st).startsWith("x **em** y"), "em → strong after leaving → " + md(st).split("\n")[0]);
// link
st = mk("go [here](https://a.b \"T\") now");
st = st.apply(st.tr.setSelection(TextSelection.create(st.doc, posOf(st, "here", 4))));
ok(raw(st)[0] === '[here](https://a.b "T")', "link expands with caret inside text → " + raw(st)[0] + " caret char before=" + st.doc.textBetween(st.selection.from - 1, st.selection.from));
// nested
st = mk("a **b *c* d** e");
st = st.apply(st.tr.setSelection(TextSelection.create(st.doc, posOf(st, "c", 1))));
ok(raw(st)[0] === "**b *c* d**", "nested expands whole outer span → " + raw(st)[0]);
// inline math
st = mk("math $x^2$ here");
st = st.apply(st.tr.setSelection(TextSelection.create(st.doc, posOf(st, "math ", 5))));
ok(raw(st)[0] === "$x^2$", "inline math adjacent expands to $x^2$ → " + JSON.stringify(raw(st)));
// serialization while expanded is lossless
ok(md(st) === "math $x^2$ here", "serialize while expanded → " + md(st));
// move from one span to another in the same block
st = mk("a **bb** c *dd* e");
st = st.apply(st.tr.setSelection(TextSelection.create(st.doc, posOf(st, "bb", 1))));
const target = posOf(st, "dd", 1);
st = st.apply(st.tr.setSelection(TextSelection.create(st.doc, target)));
ok(JSON.stringify(raw(st)) === '["*dd*"]', "switching spans: first collapses, second expands → " + JSON.stringify(raw(st)));
ok(st.doc.textBetween(st.selection.from - 2, st.selection.from + 2) === "*dd*".slice(0, 4) || st.doc.textBetween(st.selection.from - 2, st.selection.from) === "*d", "caret lands inside dd → " + st.doc.textBetween(st.selection.from - 2, st.selection.from) + "|");
ok(md(st) === "a **bb** c *dd* e", "doc intact → " + md(st));
process.exit(fail ? 1 : 0);
