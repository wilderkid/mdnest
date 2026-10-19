// Pure unit tests for Part A (0.1.2): image alignment, task status.
// Usage: npx tsx tests/parity-012-unit.ts
import { parseMarkdown, serializeMarkdown } from "../src/editor/markdown";
import { imageAlignFromStyle, imageStyle, imageZoomFromStyle } from "../src/editor/imagestyle";
import { setTaskStatus } from "../src/editor/editops";
import { EditorState, TextSelection } from "prosemirror-state";

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

console.log(`\n${failed ? failed + " failed" : "all passed"}`);
process.exit(failed ? 1 : 0);
