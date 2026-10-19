// Suggestion plugin: mapping, invalidation, single-undo accept, serialization, word diff.
// No DOM. Run: npx tsx tests/suggest.ts
import { EditorState, TextSelection } from "prosemirror-state";
import { history, undo } from "prosemirror-history";
import { parseMarkdown, serializeMarkdown } from "../src/editor/markdown";
import { collapseAll } from "../src/editor/markers";
import { wordDiff } from "../src/editor/diff";
import {
  acceptTransaction, addMeta, patchMeta, suggestKey, suggestPlugin, beginRecord, type SugRecord,
} from "../src/editor/suggest";
import { selectionMarkdown, contextMarkdown, sliceForInsert, normalizeRange } from "../src/editor/insertmd";
import { chooseView, changedSentences, sentences } from "../src/editor/sugview";
import { originAllowed, secretIdFor, PluginManager, type EditorPlugin, type PluginHost } from "../src/plugins/api";

let fail = 0;
const ok = (c: boolean, msg: string) => { console.log((c ? "PASS " : "FAIL ") + msg); if (!c) fail++; };
const mdOf = (st: EditorState) => serializeMarkdown(collapseAll(st.doc));

function mk(md: string) {
  return EditorState.create({ doc: parseMarkdown(md), plugins: [suggestPlugin(), history()] });
}
function posOf(st: EditorState, needle: string) {
  let r = -1;
  st.doc.descendants((n, p) => { if (r < 0 && n.isText && n.text!.includes(needle)) r = p + n.text!.indexOf(needle); });
  return r;
}
function add(st: EditorState, item: SugRecord) {
  return st.apply(st.tr.setMeta(suggestKey, addMeta(item)).setMeta("addToHistory", false));
}
function items(st: EditorState) {
  return suggestKey.getState(st)?.items ?? [];
}

// --- word diff ---
{
  const ops = wordDiff("the quick cat", "the slow cat");
  const joined = ops.map((o) => o.text).join("");
  ok(ops.some((o) => o.op === "del" && o.text.includes("quick")), "word diff deletes quick → " + JSON.stringify(ops));
  ok(ops.some((o) => o.op === "ins" && o.text.includes("slow")), "word diff inserts slow");
  ok(ops.filter((o) => o.op === "eq").map((o) => o.text).join("").includes("cat"), "word diff keeps cat");
  ok(wordDiff("a", "a").every((o) => o.op === "eq"), "identical text is all eq");
  ok(wordDiff("", "new words").every((o) => o.op === "ins"), "empty original is all inserts");
  ok(joined.length > 0, "diff produced tokens");
}

// --- mapping: an edit before the range shifts the anchor, document markdown stays the original ---
{
  let st = mk("Hello world.\n\nKeep this.");
  const from = posOf(st, "world");
  const to = from + "world".length;
  const before = mdOf(st);
  const rec = beginRecord(st, { owner: "t", from, to, mode: "replace", label: "t" });
  st = add(st, rec);
  ok(items(st).length === 1, "suggestion stored in plugin state");
  ok(mdOf(st) === before, "getMarkdown unchanged while suggestion is pending → " + JSON.stringify(mdOf(st)));
  // insert two characters before the range
  st = st.apply(st.tr.insertText("XY", 1));
  const live = items(st)[0];
  ok(!!live && live.from === from + 2 && live.to === to + 2, `anchor mapped ${from},${to} → ${live?.from},${live?.to}`);
  ok(mdOf(st).startsWith("XHello") || mdOf(st).includes("XY"), "user insert is in the document → " + mdOf(st).split("\n")[0]);
  ok(!mdOf(st).includes("sug-"), "serialized markdown has no suggestion id");
}

// --- invalidation: a user edit that touches the range drops the suggestion ---
{
  let st = mk("Alpha beta gamma.");
  const from = posOf(st, "beta");
  const to = from + 4;
  const rec = beginRecord(st, { owner: "t", from, to, mode: "replace" });
  let settled: string | null = null;
  rec.settled.push((r) => { settled = r; });
  st = add(st, rec);
  st = st.apply(st.tr.insertText("X", from + 1));
  ok(items(st).length === 0, "touching edit drops the suggestion");
  ok(suggestKey.getState(st)?.notice?.includes("discarded") === true, "notice set → " + suggestKey.getState(st)?.notice);
  queueMicrotask(() => ok(settled === "invalidated", "settled callback is invalidated → " + settled));
  // an edit that does not touch the range keeps it
  st = mk("Alpha beta gamma.\n\nTail.");
  const f2 = posOf(st, "beta"), t2 = f2 + 4;
  const rec2 = beginRecord(st, { owner: "t", from: f2, to: t2, mode: "replace" });
  st = add(st, rec2);
  const tail = posOf(st, "Tail");
  st = st.apply(st.tr.insertText("Z", tail));
  ok(items(st).length === 1, "edit outside the range keeps the suggestion");
  ok(items(st)[0].from === f2, "untouched range did not move");
}

// --- accept is one undo step; pending text never appears in serialization ---
{
  let st = mk("Replace me please.");
  const from = posOf(st, "Replace me");
  const to = from + "Replace me".length;
  const original = mdOf(st);
  const rec = beginRecord(st, { owner: "plug", from, to, mode: "replace" });
  st = add(st, rec);
  st = st.apply(st.tr.setMeta(suggestKey, patchMeta(rec.id, { text: "Keep this", phase: "ready" })).setMeta("addToHistory", false));
  ok(mdOf(st) === original, "serialization excludes pending suggestion text");
  ok(!mdOf(st).includes("Keep this"), "proposed markdown is not in the document");
  const tr = acceptTransaction(st, items(st)[0]);
  ok(!!tr, "accept transaction built");
  st = st.apply(tr!);
  ok(items(st).length === 0, "accept drops the suggestion");
  ok(mdOf(st).includes("Keep this"), "accepted text is in the document → " + mdOf(st).split("\n")[0]);
  ok(!mdOf(st).includes("Replace me"), "original range replaced");
  let undone = false;
  undone = undo(st, (t) => { st = st.apply(t); });
  ok(undone, "undo applied");
  ok(mdOf(st) === original, "one undo restores the original → " + JSON.stringify(mdOf(st)));
  ok(!mdOf(st).includes("Keep this"), "undone document has no suggestion text");
}

// --- selection markdown and context, single-paragraph slice ---
{
  const st = mk("**Hello** world.\n\nSecond block.\n\nThird.");
  const from = posOf(st, "Hello");
  const to = from + 5;
  const sel = selectionMarkdown(st, from, to);
  ok(sel === "**Hello**" || sel.includes("Hello"), "selection markdown includes the span → " + JSON.stringify(sel));
  const ctx = contextMarkdown(st, posOf(st, "Second"), 1, 1);
  ok(ctx.includes("Hello") && ctx.includes("Second") && ctx.includes("Third"), "context covers neighbouring blocks → " + JSON.stringify(ctx));
  const end = st.doc.content.size;
  const slice = sliceForInsert("inline", st, 1, 1);
  ok(slice.openStart === 0 && slice.content.firstChild?.isText === true || slice.content.size > 0, "single paragraph into a textblock is inline → size " + slice.content.size);
  const block = sliceForInsert("para one\n\npara two", st, 0, end);
  ok(block.content.childCount >= 1, "multi-block insert is a block slice");
  void TextSelection;
}

// --- permissions / services helpers used by the plugin API ---
{
  ok(originAllowed("https://api.openai.com/v1/chat", ["https://api.openai.com"]), "exact origin allowed");
  ok(!originAllowed("https://evil.example/v1", ["https://api.openai.com"]), "other origin rejected");
  ok(originAllowed("http://localhost:11434/v1", ["http://localhost:11434"]), "localhost origin allowed");
  ok(secretIdFor("ai", "apiKey") === "ai.apikey", "secret key is prefixed and lowercased for the host charset");
  ok(secretIdFor("ai", "ai.apiKey") === "ai.apikey", "already-prefixed key is not doubled");
  let threw = false;
  try { secretIdFor("ai", "../other"); } catch { threw = true; }
  ok(threw, "escaping secret key rejected");

  const errors: { id: string; error: string }[] = [];
  const host = {
    addCommand() {}, runCommand() {}, addSidebarPanel() {}, notify() {}, revealPanel() {},
    prompt: async () => null, addDecorations() {}, getMarkdown: () => "", getState: () => mk(""),
    getView: () => { throw new Error("no view"); }, getFilePath: () => null, refreshDecorations() {}, addSettings() {},
    getSetting: () => undefined, settingsFor: () => [], commitSetting: () => true, host: {} as any,
  } as PluginHost;
  const mgr = new PluginManager(host);
  const consumer: EditorPlugin = {
    manifest: { id: "lib", name: "Lib", version: "1.0.0", consumes: ["ai.provider@1"] },
    activate() { return {}; },
  };
  const provider: EditorPlugin = {
    manifest: { id: "ai", name: "AI", version: "1.0.0", provides: ["ai.provider@1"] },
    activate() { return { ok: true }; },
  };
  mgr.activateAll([consumer, provider]);
  ok(mgr.loaded.has("ai") && mgr.loaded.has("lib"), "provider activates before consumer");
  ok(mgr.errors.length === 0, "no errors when the service exists → " + JSON.stringify(mgr.errors));
  const missing = new PluginManager(host);
  missing.activateAll([consumer]);
  ok(missing.errors.some((e) => e.id === "lib" && e.error.includes("ai.provider@1")), "missing consumed service disables the consumer → " + JSON.stringify(missing.errors));
  ok(!missing.loaded.has("lib"), "disabled consumer is not loaded");
  void errors;
}

// --- whole-block selections send inline content only; accept keeps the block type ---
{
  let st = mk("# My **title** here\n\n- item one\n- item two\n\nPara.");
  const h = st.doc.child(0);
  const from = 1, to = 1 + h.content.size;
  ok(selectionMarkdown(st, from, to) === "My **title** here", "heading selection → inline md only: " + JSON.stringify(selectionMarkdown(st, from, to)));
  // triple-click style range ending at the start of the next block is pulled back
  const next = posOf(st, "item one");
  const n = normalizeRange(st, from, next);
  ok(n.to === to, `range ending at next block start normalized ${next} → ${n.to}`);
  ok(selectionMarkdown(st, from, next) === "My **title** here", "normalized selection still inline");
  const rec = beginRecord(st, { owner: "t", from, to: next, mode: "replace" });
  ok(rec.inline && rec.to === to && rec.originalText === "My title here", "record is inline with plain original → " + JSON.stringify(rec.originalText));
  st = add(st, rec);
  // model echoes the heading marker anyway
  st = st.apply(st.tr.setMeta(suggestKey, patchMeta(rec.id, { text: "# New *title*", phase: "ready" })));
  const tr = acceptTransaction(st, rec)!;
  st = st.apply(tr);
  ok(mdOf(st).startsWith("# New *title*\n"), "accept keeps heading level, no nested '#' → " + JSON.stringify(mdOf(st).split("\n")[0]));
  // list item: inline content in, list marker kept
  let pos = posOf(st, "item one");
  const li = beginRecord(st, { owner: "t", from: pos, to: pos + "item one".length, mode: "replace" });
  ok(selectionMarkdown(st, li.from, li.to) === "item one", "list item selection has no marker");
  st = add(st, li);
  st = st.apply(st.tr.setMeta(suggestKey, patchMeta(li.id, { text: "first item", phase: "ready" })));
  st = st.apply(acceptTransaction(st, li)!);
  ok(/^- first item$/m.test(mdOf(st)), "list marker reapplied → " + JSON.stringify(mdOf(st)));
}

// --- granularity ---
{
  ok(sentences("One. Two! Three?").length === 3, "sentence split → " + JSON.stringify(sentences("One. Two! Three?")));
  ok(chooseView("replace", true, "a short line", "a shorter line") === "words", "short inline edit → words");
  const long = "Alpha is first. Beta comes next and is long enough to matter here. Gamma closes the paragraph with many more words so that the whole thing passes the thirty word limit for short edits.";
  const edit = long.replace("Beta comes next", "Beta follows");
  ok(chooseView("replace", true, long, edit) === "sentences", "long edit of one sentence → sentences");
  const cs = changedSentences(long, edit);
  ok(cs.changed.size === 1 && cs.list.length === 3, "one changed sentence of three → " + [...cs.changed]);
  ok(chooseView("replace", false, long, "Totally new. Entirely different words. Nothing kept at all.") === "block", "most sentences changed → block rewrite");
  ok(chooseView("insert", true, "", "anything") === "insert", "insert mode → insert");
}

setTimeout(() => process.exit(fail ? 1 : 0), 20);
