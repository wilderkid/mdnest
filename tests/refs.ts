// Footnotes + reference-style links/images: parsing, round-trip, marker editing. Run: npx tsx tests/refs.ts
import { readFileSync } from "node:fs";
import { EditorState, TextSelection } from "prosemirror-state";
import { DOMSerializer } from "prosemirror-model";
import { parseMarkdown, serializeMarkdown } from "../src/editor/markdown";
import { markersPlugin, collapseAll, srcRanges } from "../src/editor/markers";
let fail = 0;
const ok = (c: boolean, msg: string) => { console.log((c ? "PASS " : "FAIL ") + msg); if (!c) fail++; };
const rt = (s: string) => serializeMarkdown(parseMarkdown(s));
const types = (s: string) => { const t: string[] = []; parseMarkdown(s).descendants((n) => { t.push(n.type.name); }); return t; };

const fx = readFileSync(new URL("./fixtures/refs-footnotes.md", import.meta.url), "utf8");
ok(rt(fx) === fx, "fixture round-trips byte-identical");
const doc = parseMarkdown(fx);
const links: any[] = []; doc.descendants((n) => { n.marks.forEach((m) => m.type.name === "link" && links.push(m.attrs)); if (n.type.name === "image") links.push(n.attrs); });
ok(links.some((a) => a.refType === "full" && a.ref === "gh" && a.href === "https://github.com" && a.title === "GitHub"), "full ref link resolved + kept");
ok(links.some((a) => a.refType === "collapsed" && a.href === "https://typora.io"), "collapsed ref (case-insensitive label)");
ok(links.some((a) => a.refType === "shortcut" && a.href === "https://example.com/docs"), "shortcut ref");
ok(links.some((a) => a.src === "./assets/logo.png" && a.refType === "full" && a.ref === "img"), "image by reference");
ok(links.some((a) => !a.refType && a.href === "https://example.com"), "inline link unchanged");
const t = types(fx);
ok(t.filter((x) => x === "footnote_ref").length === 3 && t.filter((x) => x === "footnote_def").length === 2 && t.includes("link_def"), "footnote refs/defs + link_def nodes");

for (const [name, src] of [
  ["footnote in list item", "- item[^a]\n- two\n\n[^a]: note\n"],
  ["ref link in table cell", "| a | b |\n|---|---|\n| [x][r] | y |\n\n[r]: https://r.r\n"],
  ["defs in blockquote", "> see [q][]\n>\n> [q]: https://q.q\n"],
  ["separated footnote defs", "t[^1][^2]\n\n[^1]: one\n\n[^2]: two\n"],
  ["footnote without def", "dangling[^x] ref\n"],
  ["soft line breaks kept", "line one\nline two\n"],
] as [string, string][]) ok(rt(src) === src, name + " → " + JSON.stringify(rt(src)));

for (const [name, src] of [
  ["undefined ref stays byte-identical", "a [nope][missing] b\n"],
  ["undefined shortcut/collapsed refs", "see [this] and [that][] here\n"],
  ["literal brackets in heading", "# Title [draft]\n"],
  ["escaped brackets that would form a ref stay escaped", "x \\[gh\\] y\n\n[gh]: https://g.h\n"],
  ["escaped def-like line stays escaped", "\\[id\\]: https://x.y\n"],
  ["brackets in table cell", "| a | b |\n|---|---|\n| [x] | [y][z] |\n"],
  ["task-like text in paragraph", "plain [ ] box\n"],
] as [string, string][]) ok(rt(src) === src, name + " → " + JSON.stringify(rt(src)));
// DOM contract (theme classes)
const { JSDOM } = await import("jsdom").catch(() => ({ JSDOM: null as any }));
if (JSDOM) {
  const w = new JSDOM("").window as any;
  const frag = DOMSerializer.fromSchema(doc.type.schema).serializeFragment(doc.content, { document: w.document });
  const div = w.document.createElement("div"); div.appendChild(frag);
  ok(!!div.querySelector("sup.md-footnote a[href='#dfref-footnote-1']"), "sup.md-footnote > a");
  ok(!!div.querySelector(".md-def-footnote .md-def-name") && div.querySelector(".md-def-footnote .md-def-content")?.textContent?.includes("First footnote"), ".md-def-footnote/.md-def-name/.md-def-content");
  ok(!!div.querySelector(".md-def-link"), ".md-def-link block");
} else console.log("SKIP DOM checks (no jsdom)");

// marker editing: caret on a ref link shows [text][id]; editing the label keeps resolution
const mk = (md: string) => EditorState.create({ doc: parseMarkdown(md), plugins: [markersPlugin()] });
const posOf = (st: EditorState, needle: string, d = 0) => { let r = -1; st.doc.descendants((n, p) => { if (r < 0 && n.isText && n.text!.includes(needle)) r = p + n.text!.indexOf(needle) + d; }); return r; };
let st = mk("go [here][a] now\n\nnext\n\n[a]: https://a.a\n[b]: https://b.b\n");
st = st.apply(st.tr.setSelection(TextSelection.create(st.doc, posOf(st, "here", 2))));
const raw = srcRanges(st.doc).map((r) => st.doc.textBetween(r.from, r.to));
ok(raw[0] === "[here][a]", "ref link expands to raw → " + JSON.stringify(raw));
const r0 = srcRanges(st.doc)[0];
st = st.apply(st.tr.insertText("b", r0.to - 2, r0.to - 1)); // [here][a] → [here][b]
st = st.apply(st.tr.setSelection(TextSelection.create(st.doc, posOf(st, "next", 1))));
let href: string | null = null; st.doc.descendants((n) => { const m = n.marks.find((m) => m.type.name === "link"); if (m) href = m.attrs.href; });
ok(href === "https://b.b" && serializeMarkdown(collapseAll(st.doc)).startsWith("go [here][b] now"), "edited label re-resolves against doc definitions → " + href);
// footnote ref: caret next to it reveals [^1]
st = mk("text[^1] more\n\n[^1]: fn\n");
st = st.apply(st.tr.setSelection(TextSelection.create(st.doc, posOf(st, "text", 4) + 1)));
const raw2 = srcRanges(st.doc).map((r) => st.doc.textBetween(r.from, r.to));
ok(raw2[0] === "[^1]", "footnote ref reveals [^1] → " + JSON.stringify(raw2));
st = st.apply(st.tr.setSelection(TextSelection.create(st.doc, posOf(st, "fn", 1))));
let fr = 0; st.doc.descendants((n) => { if (n.type.name === "footnote_ref") fr++; });
ok(fr === 1 && srcRanges(st.doc).length === 0, "collapses back to footnote_ref");
console.log(fail ? `${fail} FAILED` : "all passed");
process.exit(fail ? 1 : 0);
