// Pure unit tests for 0.1.2: image alignment, task status, encodings, line endings.
// Usage: npx tsx tests/parity-012-unit.ts
import { parseMarkdown, serializeMarkdown } from "../src/editor/markdown";
import { imageAlignFromStyle, imageStyle, imageZoomFromStyle } from "../src/editor/imagestyle";
import { setTaskStatus } from "../src/editor/editops";
import { EditorState, TextSelection } from "prosemirror-state";
import { applyEol, decodeAs, detectEol, encodeText, openBytes, type SaveEncoding } from "../src/editor/encoding";
import { curlyQuote } from "../src/editor/smartpunct";

let failed = 0;
const ok = (c: boolean, name: string, info = "") => {
  console.log((c ? "PASS " : "FAIL ") + name + (info ? " — " + info : ""));
  if (!c) failed++;
};

ok(imageStyle(null, "center") === "display:block;margin:0 auto", "center style");
ok(imageStyle("50", "center") === "display:block;margin:0 auto;width:50%;zoom:50%", "center plus zoom");
ok(imageStyle("50", "left").includes("float:left") && imageStyle("50", "left").includes("width:50%"), "left plus zoom");
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

console.log(`\n${failed ? failed + " failed" : "all passed"}`);
process.exit(failed ? 1 : 0);
