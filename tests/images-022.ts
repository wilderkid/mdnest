// 0.2.2 image size/alignment serialization: lossless round-trip, Typora-compatible output.
// Usage: npx tsx tests/images-022.ts
import { Transform } from "prosemirror-transform";
import { parseMarkdown, serializeMarkdown } from "../src/editor/markdown";
import { parseImgTag } from "../src/editor/imagestyle";

let fail = 0, pass = 0;
const ok = (c: boolean, m: string, info?: unknown) => { console.log((c ? "PASS " : "FAIL ") + m + (c || info === undefined ? "" : " — " + JSON.stringify(info))); c ? pass++ : fail++; };
const same = [
  "![a](x.png)\n",
  "![t](a.png \"tt\")\n",
  "![ref][r]\n\n[r]: a.png\n",
  '<img src="x.png" alt="a" style="zoom:50%;" />\n',
  'Text <img src="x.png" alt="a" style="zoom:50%;"> more\n',
  '<img src="x.png" alt="a" style="width:50%;zoom:50%">\n',
  '<img src="y.png" alt="b" width="300" height="200" class="k">\n',
  '<img src="z.png" alt="c" style="display:block;margin:0 auto;zoom:67%;" />\n',
  "<img src='q.png' alt='single'>\n",
  "Two ![a](a.png) and ![b](b.png) inline\n",
];
for (const c of same) { const out = serializeMarkdown(parseMarkdown(c)); ok(out === c, "round-trip " + JSON.stringify(c), out); }

function edit(md: string, attrs: Record<string, unknown>, nth = 0) {
  const doc = parseMarkdown(md);
  const ps: number[] = []; doc.descendants((n, p) => { if (n.type.name === "image") ps.push(p); });
  const n = doc.nodeAt(ps[nth])!;
  const tr = new Transform(doc).setNodeMarkup(ps[nth], undefined, { ...n.attrs, ...attrs });
  return serializeMarkdown(tr.doc);
}
const z50 = edit("![a](x.png)\n", { zoom: "50" });
ok(z50 === '<img src="x.png" alt="a" style="zoom:50%;" />\n', "zoom 50% → Typora's <img style=\"zoom:50%;\" />", z50);
const c = edit(z50, { align: "center" });
ok(c === '<img src="x.png" alt="a" style="display:block;margin:0 auto;zoom:50%;" />\n', "center + zoom", c);
ok(edit(c, { zoom: null, align: null }) === "![a](x.png)\n", "restore + default align → plain ![]() again", edit(c, { zoom: null, align: null }));
const w = edit("![a](x.png \"T\")\n", { width: "320", align: "right" });
ok(w === '<img src="x.png" alt="a" title="T" style="display:block;margin-left:auto;" width="320" />\n', "custom width + right", w);
ok(serializeMarkdown(parseMarkdown(w)) === w, "custom width + right re-opens identically");
const pw = parseImgTag(w)!;
ok(pw.width === "320" && pw.align === "right" && pw.title === "T", "parsed back: width/align/title", pw);
const keep = edit('<img src="y.png" alt="b" width="300" height="200" class="k">\n', { zoom: "75", width: null });
ok(keep === '<img src="y.png" alt="b" height="200" class="k" style="zoom:75%;" />\n', "editing an HTML image keeps its other attributes", keep);
const legacy = edit('<img src="x.png" alt="a" style="width:50%;zoom:50%">\n', { zoom: "25" });
ok(legacy === '<img src="x.png" alt="a" style="zoom:25%;" />\n', "0.1.x width%+zoom% image rewritten to plain zoom when changed", legacy);
const second = edit("Two ![a](a.png) and ![b](b.png) inline\n", { zoom: "33" }, 1);
ok(second === 'Two ![a](a.png) and <img src="b.png" alt="b" style="zoom:33%;" /> inline\n', "only the edited inline image becomes HTML", second);
const lt = edit("![a<b](x.png)\n", { zoom: "50" });
ok(/alt="a&lt;b"/.test(lt) && serializeMarkdown(parseMarkdown(lt)) === lt, "alt text is escaped and round-trips", lt);
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
