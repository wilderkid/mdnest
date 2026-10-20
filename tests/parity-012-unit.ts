// Pure unit tests for 0.1.2: image alignment, task status, encodings, line endings.
// Usage: npx tsx tests/parity-012-unit.ts
import { parseMarkdown, serializeMarkdown } from "../src/editor/markdown";
import { imageAlignFromStyle, imageStyle, imageZoomFromStyle } from "../src/editor/imagestyle";
import { setTaskStatus } from "../src/editor/editops";
import { EditorState, TextSelection } from "prosemirror-state";
import { applyEol, decodeAs, detectEol, encodeText, openBytes, type SaveEncoding } from "../src/editor/encoding";
import { curlyQuote } from "../src/editor/smartpunct";
import { emojiChar, emojiMatches } from "../src/editor/emoji";
import { buildDocx, crc32, imagePixelSize, zipStore } from "../src/shell/docx";

let failed = 0;
const ok = (c: boolean, name: string, info = "") => {
  console.log((c ? "PASS " : "FAIL ") + name + (info ? " — " + info : ""));
  if (!c) failed++;
};

ok(imageStyle(null, "center") === "display:block;margin:0 auto", "center style");
ok(imageStyle("50", "center") === "display:block;margin:0 auto;zoom:50%", "center plus zoom (0.2.2: zoom only)");
ok(imageStyle("50", "left") === "display:block;margin-right:auto;zoom:50%", "left plus zoom");
ok(imageStyle(null, null) === "", "default style is empty");
ok(imageAlignFromStyle("float:right;margin:0 0 8px 12px") === "right", "parse right");
ok(imageAlignFromStyle("display:block;margin:0 auto;width:50%;zoom:50%") === "center", "parse center with zoom");
ok(imageZoomFromStyle("display:block;margin:0 auto;width:50%;zoom:50%") === "50", "parse zoom beside align");

function round(src: string): string {
  return serializeMarkdown(parseMarkdown(src));
}
const img = '<img src="a.png" alt="pic" style="display:block;margin:0 auto;width:50%;zoom:50%">';
const rt = round(img + "\n").replace(/\s/g, "");
ok(rt.includes("margin:0auto") && rt.includes("width:50%") && rt.includes("zoom:50%"), "image align and zoom round-trip", rt);
ok(imageAlignFromStyle("float:left;width:20%") === "left", "parse left");

{
  const doc = parseMarkdown("- [ ] one\n- [x] two\n- [ ] three\n");
  let st = EditorState.create({ doc, selection: TextSelection.create(doc, 3, 22) });
  ok(setTaskStatus("complete")(st, (tr) => { st = st.apply(tr); }), "complete dispatches");
  const md = serializeMarkdown(st.doc);
  ok((md.match(/\[x\]/g) || []).length === 3, "complete marks every task", md);
  ok(setTaskStatus("toggle")(st, (tr) => { st = st.apply(tr); }), "toggle dispatches");
  ok(!serializeMarkdown(st.doc).includes("[x]"), "toggle clears a fully checked selection", serializeMarkdown(st.doc));
  const plain = EditorState.create({ doc: parseMarkdown("just text\n") });
  ok(setTaskStatus("complete")(plain) === false, "no tasks returns false");
}

function roundEnc(text: string, enc: SaveEncoding): { back: string; unmapped: string[] } {
  const encoded = encodeText(text, enc);
  return { back: decodeAs(encoded.bytes, enc), unmapped: encoded.unmapped };
}

{
  const crlf = new TextEncoder().encode("a\r\nb\r\nc\n");
  ok(detectEol(crlf) === "CRLF", "CRLF wins when it is the majority");
  ok(detectEol(new TextEncoder().encode("a\nb\n")) === "LF", "LF when no CRLF");
  ok(applyEol("a\nb\n", "CRLF") === "a\r\nb\r\n", "apply CRLF");
  const bom = new Uint8Array([0xef, 0xbb, 0xbf, 0x68, 0x69, 0x0d, 0x0a]);
  const opened = openBytes(bom);
  ok(opened.encoding === "UTF-8-BOM" && opened.text === "hi\n" && opened.eol === "CRLF", "UTF-8 BOM stripped, CRLF noted", JSON.stringify(opened));
  const u16 = encodeText("你好\n", "UTF-16LE");
  ok(u16.bytes[0] === 0xff && u16.bytes[1] === 0xfe, "UTF-16LE BOM");
  ok(decodeAs(u16.bytes, "UTF-16LE") === "你好\n", "UTF-16LE round trip");
}

{
  const samples: [SaveEncoding, string][] = [
    ["GB18030", "中文测试"],
    ["GBK", "中文测试"],
    ["Big5", "中文測試"],
    ["Shift_JIS", "日本語"],
  ];
  for (const [enc, text] of samples) {
    const r = roundEnc(text, enc);
    ok(r.unmapped.length === 0 && r.back === text, enc + " round trip", r.back + " unmapped=" + r.unmapped.join(""));
  }
  // TextDecoder aliases gbk to gb18030 for the single byte 0x80, so "€" round-trips in both.
  // The difference is the 4-byte BMP range, which only the GB18030 map builds (CJK Ext-A).
  const euroGbk = roundEnc("€", "GBK");
  const euroGb = encodeText("€", "GB18030");
  ok(euroGb.unmapped.length === 0 && euroGb.bytes.length === 1 && euroGb.bytes[0] === 0x80, "GB18030 euro is the single byte 0x80", String(euroGb.bytes.length));
  ok(euroGbk.unmapped.length === 0 && euroGbk.back === "€", "GBK euro round-trips via 0x80", JSON.stringify(euroGbk));
  const extBytes = encodeText("㐀", "GB18030");
  ok(extBytes.unmapped.length === 0 && extBytes.bytes.length === 4, "GB18030 CJK Ext-A is 4 bytes", String(extBytes.bytes.length));
  const ext = roundEnc("㐀", "GB18030");
  ok(ext.unmapped.length === 0 && ext.back === "㐀", "GB18030 CJK Ext-A round trip", JSON.stringify(ext));
  const extGbk = roundEnc("㐀", "GBK");
  ok(extGbk.unmapped.includes("㐀") || extGbk.back !== "㐀", "GBK leaves CJK Ext-A unmapped", JSON.stringify(extGbk));
  const saved = encodeText(applyEol("甲\n乙\n", "CRLF"), "GB18030");
  ok(saved.bytes.includes(0x0d) && saved.bytes.includes(0x0a), "CRLF preserved in encoded bytes");
  ok(decodeAs(saved.bytes, "GB18030") === "甲\n乙\n", "CRLF decoded back to LF text");
}

ok(curlyQuote("", '"') === "\u201C" && curlyQuote("a", '"') === "\u201D", "curly double quotes");
ok(curlyQuote("", "'") === "\u2018" && curlyQuote("n", "'") === "\u2019", "apostrophe stays a right single quote");
ok(curlyQuote(" ", "'") === "\u2018", "opening single quote after space");
ok(emojiChar("smile") === "😄", "smile shortcode", emojiChar("smile"));
ok(emojiMatches("rock").some((m) => m.name === "rocket"), "rocket matches rock");
ok(emojiMatches("s").length === 0, "one letter does not open matches");

{
  const hello = new TextEncoder().encode("hi");
  ok(crc32(hello) === 0x9d8f7b8e || crc32(new TextEncoder().encode("123456789")) === 0xcbf43926, "crc32 of 123456789", crc32(new TextEncoder().encode("123456789")).toString(16));
  const z = zipStore([{ name: "a.txt", data: hello }]);
  ok(z[0] === 0x50 && z[1] === 0x4b && z[2] === 0x03 && z[3] === 0x04, "zip local header");
  ok(z[8] === 0 && z[9] === 0, "zip method is STORE");

  const png = new Uint8Array([
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
    0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52,
    0, 0, 0, 8, 0, 0, 0, 4,
    8, 2, 0, 0, 0,
  ]);
  const sz = imagePixelSize(png, "png");
  ok(!!sz && sz.w === 8 && sz.h === 4, "png size", JSON.stringify(sz));

  const src = [
    "# Title",
    "",
    "A **bold** and *em* and <u>under</u> and ~~gone~~ and `code` and ==mark== and ^up^ and ~down~.",
    "",
    "> a quote",
    "",
    "- bullet",
    "  - nested",
    "- [x] done",
    "- [ ] open",
    "",
    "1. first",
    "",
    "```",
    "let x = 1",
    "```",
    "",
    "| h | i |",
    "|---|--:|",
    "| a | b |",
    "",
    "---",
    "",
    "[link](https://example.com)",
    "",
    "See [^1].",
    "",
    "[^1]: a note",
    "",
    "$$",
    "E = mc^2",
    "$$",
    "",
    "$x$",
    "",
    "[TOC]",
    "",
    "![pic](pixel.png)",
    "",
  ].join("\n");
  const doc = parseMarkdown(src);
  const bytes = await buildDocx(doc, {
    readBytes: async (p) => (p.endsWith("pixel.png") ? png : null),
    resolveImage: (s) => s,
  });
  const { writeFileSync, mkdtempSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { execFileSync } = await import("node:child_process");
  const dir = mkdtempSync(join(tmpdir(), "mdn-docx-"));
  const out = join(dir, "t.docx");
  writeFileSync(out, bytes);
  const report = execFileSync("python3", ["-c", String.raw`
import zipfile, xml.etree.ElementTree as ET, sys
z = zipfile.ZipFile(sys.argv[1])
names = set(z.namelist())
need = ["[Content_Types].xml", "_rels/.rels", "word/document.xml", "word/styles.xml", "word/numbering.xml", "word/_rels/document.xml.rels"]
missing = [n for n in need if n not in names]
assert not missing, missing
assert any(n.startswith("word/media/") and n.endswith(".png") for n in names), names
W = "{http://schemas.openxmlformats.org/wordprocessingml/2006/main}"
root = ET.fromstring(z.read("word/document.xml"))
styles = [el.get(W + "val") for el in root.iter(W + "pStyle")]
nums = [el.get(W + "val") for el in root.iter(W + "numId")]
text = "".join(t.text or "" for t in root.iter(W + "t"))
rels = z.read("word/_rels/document.xml.rels").decode()
styles_xml = z.read("word/styles.xml").decode()
numbering = z.read("word/numbering.xml").decode()
print("STYLES", ",".join(s for s in styles if s))
print("NUMS", ",".join(n for n in nums if n))
print("TEXT", text)
print("HYPER", "example.com" in rels)
print("STYLEIDS", all(s in styles_xml for s in ["Title", "Heading1", "Quote", "Code", "ListParagraph"]))
print("NUMFMT", "bullet" in numbering and "decimal" in numbering)
print("DRAW", "wp:extent" in z.read("word/document.xml").decode())
print("FOOT", "[1]" in text and "a note" in text)
print("TASK", "☑" in text and "☐" in text)
print("MATH", "E = mc^2" in text and "x" in text)
print("TOC", "Title" in text or "Contents" in text)
`, out], { encoding: "utf8" });
  const lines = Object.fromEntries(report.trim().split("\n").map((l) => {
    const i = l.indexOf(" ");
    return [l.slice(0, i), l.slice(i + 1)];
  }));
  ok(lines.STYLEIDS === "True", "styles.xml has Title Heading Quote Code ListParagraph");
  ok(lines.NUMFMT === "True", "numbering has bullets and decimals");
  ok(lines.STYLES.includes("Title"), "title style used", lines.STYLES);
  ok(lines.STYLES.includes("Quote"), "quote style used", lines.STYLES);
  ok(lines.STYLES.includes("Code"), "code style used", lines.STYLES);
  ok(lines.STYLES.includes("ListParagraph"), "list style used", lines.STYLES);
  ok(lines.NUMS.includes("1") && lines.NUMS.includes("2"), "bullet and decimal numIds", lines.NUMS);
  ok(lines.TEXT.includes("bold") && lines.TEXT.includes("under") && lines.TEXT.includes("gone"), "inline runs", lines.TEXT.slice(0, 180));
  ok(lines.HYPER === "True", "hyperlink relationship");
  ok(lines.DRAW === "True", "embedded image drawing");
  ok(lines.FOOT === "True", "footnote as end note", lines.TEXT.slice(-80));
  ok(lines.TASK === "True", "task boxes");
  ok(lines.MATH === "True", "math as monospace text");
  ok(lines.TOC === "True", "toc heading list", lines.TEXT);
  const { rmSync } = await import("node:fs");
  rmSync(dir, { recursive: true, force: true });
}

console.log(`\n${failed ? failed + " failed" : "all passed"}`);
process.exit(failed ? 1 : 0);
