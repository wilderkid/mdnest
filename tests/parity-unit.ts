// Unit tests for part-3 marks, input rules, and a few edit operations.
// Usage: npx tsx tests/parity-unit.ts
import { parseMarkdown, serializeMarkdown } from "../src/editor/markdown";
import { schema } from "../src/editor/schema";
import { EditorState, TextSelection } from "prosemirror-state";
import { blockEnterRule, tableCells, taskListFromParagraph } from "../src/editor/blockenter";

let failed = 0;
const ok = (c: boolean, name: string, info = "") => {
  console.log((c ? "PASS " : "FAIL ") + name + (info ? " — " + info : ""));
  if (!c) failed++;
};

function round(src: string): string {
  return serializeMarkdown(parseMarkdown(src));
}

ok(round("<u>hi</u>\n") === "<u>hi</u>\n", "underline round-trip", JSON.stringify(round("<u>hi</u>\n")));
ok(round("a ^2^ b\n") === "a ^2^ b\n", "superscript round-trip", JSON.stringify(round("a ^2^ b\n")));
ok(round("H~2~O\n") === "H~2~O\n", "subscript round-trip", JSON.stringify(round("H~2~O\n")));
ok(round("~~strike~~\n") === "~~strike~~\n", "strike still round-trips beside subscript", JSON.stringify(round("~~strike~~\n")));
ok(round("see <!-- note --> here\n") === "see <!-- note --> here\n", "comment round-trip", JSON.stringify(round("see <!-- note --> here\n")));

const doc = parseMarkdown("x ^2^ y\n");
ok(!!doc.descendants && hasMark(doc, "superscript"), "superscript mark parsed");
ok(hasMark(parseMarkdown("<u>z</u>\n"), "underline"), "underline mark parsed");
ok(hasMark(parseMarkdown("H~2~O\n"), "subscript"), "subscript mark parsed");
ok(hasMark(parseMarkdown("see <!--c--> here\n"), "comment"), "comment mark parsed");

function hasMark(node: any, name: string): boolean {
  let found = false;
  node.descendants((n: any) => { if (n.marks?.some((m: any) => m.type.name === name)) found = true; });
  return found;
}

{
  const doc = parseMarkdown("[ ]\n");
  let st = EditorState.create({ doc, selection: TextSelection.create(doc, 1) });
  const tr = taskListFromParagraph(st, ["[ ] ", " "] as unknown as RegExpMatchArray, 1, 4);
  ok(!!tr, "taskListFromParagraph returns a transaction");
  if (tr) st = st.apply(tr);
  ok(/- \[ \]/.test(serializeMarkdown(st.doc)), "input [ ] + space → task list", serializeMarkdown(st.doc));
}

ok(tableCells("| a | b |")?.join(",") === "a,b", "tableCells splits a header row");
ok(tableCells("| --- | --- |") === null, "tableCells rejects a separator row");

{
  const doc = parseMarkdown("| a | b |\n");
  const end = doc.firstChild!.nodeSize - 1;
  let st = EditorState.create({ doc, selection: TextSelection.create(doc, end) });
  const ran = blockEnterRule(st, (tr) => { st = st.apply(tr); });
  const out = serializeMarkdown(st.doc);
  ok(ran && out.includes("| a | b |") && /\|[\s:-]+\|/.test(out), "Enter on | a | b | creates a table", JSON.stringify(out));
}

{
  // A lone `---` parses as a rule. The live editor still has a paragraph until Enter.
  const doc = schema.node("doc", null, [schema.node("paragraph", null, [schema.text("---")])]);
  let st = EditorState.create({ doc, selection: TextSelection.create(doc, 4) });
  const ran = blockEnterRule(st, (tr) => { st = st.apply(tr); });
  ok(ran && st.doc.firstChild?.type.name === "front_matter", "--- + Enter on first line → front matter", st.doc.firstChild?.type.name);
}

{
  const doc = parseMarkdown("para\n\n---\n");
  // caret in the last paragraph
  let pos = 0;
  doc.descendants((n, p) => { if (n.isTextblock && n.textContent === "---") pos = p + n.content.size; });
  let st = EditorState.create({ doc, selection: TextSelection.create(doc, pos) });
  blockEnterRule(st, (tr) => { st = st.apply(tr); });
  ok(serializeMarkdown(st.doc).includes("\n---\n") && st.doc.firstChild?.type.name !== "front_matter", "--- + Enter elsewhere stays a rule", serializeMarkdown(st.doc));
}

{
  // Heading level ± is a setBlockType: paragraph → h1, h2 → h3. Checked via the schema command
  // without loading the editor (which pulls CodeMirror).
  const { setBlockType } = await import("prosemirror-commands");
  let st = EditorState.create({ doc: parseMarkdown("Hello\n"), selection: TextSelection.create(parseMarkdown("Hello\n"), 1) });
  setBlockType(schema.nodes.heading, { level: 1 })(st, (tr) => { st = st.apply(tr); });
  ok(serializeMarkdown(st.doc).startsWith("# Hello"), "increase heading from paragraph", serializeMarkdown(st.doc));
  let st2 = EditorState.create({ doc: parseMarkdown("## Hello\n"), selection: TextSelection.create(parseMarkdown("## Hello\n"), 1) });
  setBlockType(schema.nodes.heading, { level: 3 })(st2, (tr) => { st2 = st2.apply(tr); });
  ok(serializeMarkdown(st2.doc).startsWith("### Hello"), "decrease heading deepens", serializeMarkdown(st2.doc));
}

console.log(failed ? `\n${failed} failed` : "\nall passed");
process.exit(failed ? 1 : 0);
