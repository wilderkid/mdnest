// 0.2.2 suite with REAL input (Playwright keyboard/mouse; no editor hooks for the action under test):
//   1 autosave  2 line breaks around blocks  3 keyboard block deletion  4 context-menu formatting  5 image size/align
// Needs `npx vite build` + `vite preview` on :4173. Run: node tests/real-input-022.mjs [base]
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { chromium } from "playwright";

const base = process.argv[2] ?? "http://127.0.0.1:4173/";
const ROOT = path.resolve(process.env.WS_ROOT ?? "dev-data/workspace");
const WS = path.join(ROOT, "real022-test");
const SHOTS = process.env.SHOTS ?? "";
let fail = 0, pass = 0;
const ok = (c, m, info = "") => { console.log((c ? "PASS " : "FAIL ") + m + (c || info === "" ? "" : " — " + String(typeof info === "string" ? info : JSON.stringify(info)).slice(0, 500))); c ? pass++ : fail++; };
fs.rmSync(WS, { recursive: true, force: true }); fs.mkdirSync(WS, { recursive: true });
const browser = await chromium.launch();
const errors = [];
const disk = (f) => fs.readFileSync(path.join(WS, f), "utf8");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function png(w, h) {
  const crcT = []; for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; crcT[n] = c >>> 0; }
  const crc = (b) => { let c = 0xffffffff; for (const x of b) c = crcT[(c ^ x) & 255] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
  const chunk = (t, d) => { const l = Buffer.alloc(4); l.writeUInt32BE(d.length); const td = Buffer.concat([Buffer.from(t), d]); const c = Buffer.alloc(4); c.writeUInt32BE(crc(td)); return Buffer.concat([l, td, c]); };
  const ih = Buffer.alloc(13); ih.writeUInt32BE(w, 0); ih.writeUInt32BE(h, 4); ih[8] = 8; ih[9] = 2;
  const raw = Buffer.alloc((w * 3 + 1) * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) { const o = y * (w * 3 + 1) + 1 + x * 3; raw[o] = 90 + (x * 100 / w) | 0; raw[o + 1] = 160 - (y * 60 / h) | 0; raw[o + 2] = 210; }
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", ih), chunk("IDAT", zlib.deflateSync(raw)), chunk("IEND", Buffer.alloc(0))]);
}
fs.writeFileSync(path.join(WS, "pic.png"), png(400, 240));

async function open(file, text, { lang = "en", clean = true, noFile = false } = {}) {
  if (text != null) fs.writeFileSync(path.join(WS, file), text);
  const ctx = await browser.newContext({ viewport: { width: 1200, height: 800 } });
  await ctx.grantPermissions(["clipboard-read", "clipboard-write"]);
  if (clean) await ctx.addInitScript(() => { if (!sessionStorage.getItem("t022")) { sessionStorage.setItem("t022", "1"); localStorage.clear(); } });
  const page = await ctx.newPage();
  page.on("pageerror", (e) => errors.push(file + ": " + e.message));
  page.url0 = `${base}?lang=${lang}&folder=${encodeURIComponent(WS)}${noFile ? "" : "&file=" + encodeURIComponent(path.join(WS, file))}`;
  await page.goto(page.url0);
  await page.waitForSelector("body.mdn-ready", { timeout: 30000 });
  await page.waitForTimeout(400);
  page.md = () => page.evaluate(() => window.mdnest.editor.getMarkdown());
  page.sel = () => page.evaluate(() => { const s = window.mdnest.editor.view.state.selection; return { t: s.toJSON().type, from: s.from, to: s.to, node: s.node?.type.name ?? s.$from.parent.type.name }; });
  page.clip = () => page.evaluate(() => navigator.clipboard.readText());
  page.reset = async (md) => { await page.evaluate((md) => window.mdnest.editor.setMarkdown(md), md); await page.waitForTimeout(150); };
  page.shot = async (name) => { if (SHOTS) await page.screenshot({ path: path.join(SHOTS, name) }); };
  return page;
}
async function ctxMenu(page, target, ids, opts = {}) {
  await target.click({ button: "right", ...opts }); await page.waitForTimeout(150);
  for (const id of ids.slice(0, -1)) { await page.locator(`.context-menu .mdn-menu-item[data-id="${id}"]`).hover(); await page.waitForTimeout(120); }
  await page.locator(`.context-menu .mdn-menu-item[data-id="${ids.at(-1)}"]`).click(); await page.waitForTimeout(250);
}
const word = (page, text = "world", nth = 0) => page.locator("#write p").nth(nth).getByText(text, { exact: false });
/** double-click a word inside the first paragraph: positions computed from a DOM Range so this is a real mouse double-click */
async function wordBox(page, w, scope = "#write") {
  return page.evaluate(([w, scope]) => {
    const root = document.querySelector(scope); const it = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    for (let n; (n = it.nextNode());) { const i = n.data.indexOf(w); if (i >= 0) { const r = document.createRange(); r.setStart(n, i); r.setEnd(n, i + w.length); const b = r.getBoundingClientRect(); return { x: b.x + b.width / 2, y: b.y + b.height / 2 }; } }
    return null;
  }, [w, scope]);
}
async function dblWord(page, w) { const b = await wordBox(page, w); await page.mouse.dblclick(b.x, b.y); await page.waitForTimeout(120); return b; }
async function rclickAt(page, b, ids) {
  await page.mouse.click(b.x, b.y, { button: "right" }); await page.waitForTimeout(150);
  for (const id of ids.slice(0, -1)) { await page.locator(`.context-menu .mdn-menu-item[data-id="${id}"]`).hover(); await page.waitForTimeout(120); }
  await page.locator(`.context-menu .mdn-menu-item[data-id="${ids.at(-1)}"]`).click(); await page.waitForTimeout(250);
}
async function caretEnd(page, sel) { await page.locator(sel).last().click(); await page.keyboard.press("End"); }

// =============== 4: context menu formatting ===============
{
  const page = await open("ctx.md", "Hello world here\n");
  const marks = [["format.strong", "Hello **world** here"], ["format.emphasis", "Hello *world* here"], ["format.underline", "Hello <u>world</u> here"],
    ["format.code", "Hello `world` here"], ["format.strike", "Hello ~~world~~ here"], ["format.highlight", "Hello ==world== here"]];
  for (const [id, want] of marks) {
    await page.reset("Hello world here\n");
    const b = await dblWord(page, "world");
    await rclickAt(page, b, ["format", id]);
    const md = (await page.md()).trim();
    ok(md === want, `ctx: Format > ${id.split(".")[1]} on a selected word`, md);
    if (id === "format.strong") await page.shot("after-ctx-format-bold.png");
  }
  // no selection: right-click inside a word formats that word (like Typora/Word)
  await page.reset("Hello world here\n");
  { const b = await wordBox(page, "world"); await page.mouse.click(b.x, b.y); await rclickAt(page, b, ["format", "format.emphasis"]); }
  ok((await page.md()).trim() === "Hello *world* here", "ctx: Format > Emphasis with only a caret in the word formats the word", await page.md());
  // multi-word drag selection survives the right-click
  await page.reset("Hello world here\n");
  { const a = await wordBox(page, "Hello"), c = await wordBox(page, "world"); await page.mouse.move(a.x - 18, a.y); await page.mouse.down(); await page.mouse.move(c.x + 20, c.y, { steps: 6 }); await page.mouse.up();
    await rclickAt(page, c, ["format", "format.strong"]); }
  ok((await page.md()).trim() === "**Hello world** here", "ctx: drag-selected range keeps its selection through the right-click", await page.md());
  await page.reset("Hello **world** here\n");
  { const b = await dblWord(page, "world"); await rclickAt(page, b, ["format", "format.clear"]); }
  ok((await page.md()).trim() === "Hello world here", "ctx: Format > Clear Format", await page.md());
  // shortcut and menu agree: Ctrl+B then menu Strong toggles back off
  await page.reset("Hello world here\n");
  { const b = await dblWord(page, "world"); await page.keyboard.press("Control+b"); await rclickAt(page, b, ["format", "format.strong"]); }
  ok((await page.md()).trim() === "Hello world here", "ctx: menu Strong toggles off what Ctrl+B set", await page.md());

  // paragraph submenu
  const paras = [["paragraph.heading.1", /^# Hello world here$/], ["paragraph.heading.2", /^## Hello world here$/], ["paragraph.heading.3", /^### Hello world here$/],
    ["paragraph.quote", /^> Hello world here$/], ["paragraph.taskList", /^[-*+] \[ \] Hello world here$/], ["paragraph.orderedList", /^1[.)] Hello world here$/],
    ["paragraph.unorderedList", /^[-*+] Hello world here$/]];
  for (const [id, re] of paras) {
    await page.reset("Hello world here\n");
    const b = await wordBox(page, "world"); await page.mouse.click(b.x, b.y);
    await rclickAt(page, b, ["paragraph", id]);
    const md = (await page.md()).trim();
    ok(re.test(md), `ctx: Paragraph > ${id.slice(10)}`, md);
  }
  await page.reset("# Hello world here\n");
  { const b = await wordBox(page, "world"); await page.mouse.click(b.x, b.y); await rclickAt(page, b, ["paragraph", "paragraph.paragraph"]); }
  ok((await page.md()).trim() === "Hello world here", "ctx: Paragraph > Paragraph turns a heading back", await page.md());
  await page.reset("Hello world here\n");
  { const b = await wordBox(page, "world"); await page.mouse.click(b.x, b.y); await rclickAt(page, b, ["paragraph", "paragraph.htmlBlock"]); }
  ok(await page.evaluate(() => { const d = window.mdnest.editor.view.state.doc, t = []; d.forEach((n) => t.push(n.type.name)); return t.includes("html_block"); }), "ctx: Paragraph > HTML Block (inserts an HTML block)", await page.md());
  await page.reset("Hello world here\n");
  { const b = await wordBox(page, "world"); await page.mouse.click(b.x, b.y); await rclickAt(page, b, ["paragraph", "paragraph.insertAfter"]); await page.keyboard.type("after"); }
  ok((await page.md()).trim() === "Hello world here\n\nafter", "ctx: Insert Paragraph After (caret moves there)", await page.md());
  await page.reset("Hello world here\n");
  { const b = await wordBox(page, "world"); await page.mouse.click(b.x, b.y); await rclickAt(page, b, ["paragraph", "paragraph.insertBefore"]); await page.keyboard.type("before"); }
  ok((await page.md()).trim() === "before\n\nHello world here", "ctx: Insert Paragraph Before", await page.md());
  await page.reset("A\n\nHello world here\n\nB\n");
  { const b = await wordBox(page, "world"); await page.mouse.click(b.x, b.y); await rclickAt(page, b, ["paragraph", "paragraph.deleteBlock"]); }
  ok((await page.md()).trim() === "A\n\nB", "ctx: Delete Block", await page.md());

  // insert submenu
  const inserts = [["paragraph.hr", /^(---|\*\*\*|___)$/m], ["paragraph.footnote", /\[\^1\]/], ["paragraph.toc", /^\[toc\]$/im], ["paragraph.codeFence", /^```/m], ["paragraph.mathBlock", /^\$\$/m]];
  for (const [id, re] of inserts) {
    await page.reset("Hello world here\n");
    const b = await wordBox(page, "here"); await page.mouse.click(b.x + 20, b.y);
    await rclickAt(page, b, ["insert", id]);
    await page.keyboard.press("Escape"); await page.waitForTimeout(100);
    const md = await page.md();
    ok(re.test(md), `ctx: Insert > ${id.slice(10)}`, md);
  }
  await page.reset("Hello world here\n");
  { const b = await wordBox(page, "here"); await page.mouse.click(b.x + 20, b.y); await rclickAt(page, b, ["insert", "paragraph.tableDialog"]);
    const dlg = await page.locator(".modal").count(); await page.keyboard.press("Enter"); await page.waitForTimeout(250);
    ok(dlg > 0 && /\|.*\|/.test(await page.md()), "ctx: Insert > Table… (dialog, Enter)", { dlg, md: await page.md() }); }
  await page.reset("Hello world here\n");
  { const b = await dblWord(page, "world"); await rclickAt(page, b, ["insert", "format.link"]); await page.waitForTimeout(150);
    await page.keyboard.type("https://example.org"); await page.keyboard.press("Enter"); await page.waitForTimeout(250); }
  ok(/\[world\]\(https:\/\/example\.org\)/.test(await page.md()), "ctx: Insert > Hyperlink on a selected word", await page.md());

  // clipboard items
  await page.reset("Hello world here\n");
  { const b = await dblWord(page, "world"); await rclickAt(page, b, ["copy"]); }
  ok((await page.clip()) === "world", "ctx: Copy", await page.clip());
  { const b = await dblWord(page, "world"); await rclickAt(page, b, ["cut"]); }
  ok((await page.clip()) === "world" && (await page.md()).trim().replace(/\s+/g, " ") === "Hello here", "ctx: Cut", [await page.clip(), await page.md()]);
  await page.evaluate(() => navigator.clipboard.writeText("PASTED"));
  { const b = await wordBox(page, "here"); await page.mouse.click(b.x + 20, b.y); await rclickAt(page, { x: b.x + 20, y: b.y }, ["paste"]); }
  ok((await page.md()).includes("herePASTED"), "ctx: Paste (clipboard text at the caret)", await page.md());
  await page.reset("Hello **world** here\n");
  { const b = await dblWord(page, "world"); await rclickAt(page, b, ["edit.copyMarkdown"]); }
  ok((await page.clip()).trim() === "**world**", "ctx: Copy as Markdown", await page.clip());
  await page.evaluate(() => navigator.clipboard.writeText("*plain*"));
  { const b = await wordBox(page, "here"); await page.mouse.click(b.x + 20, b.y); await rclickAt(page, { x: b.x + 20, y: b.y }, ["edit.pastePlain"]); }
  ok((await page.md()).includes("here\\*plain\\*") || (await page.md()).includes("here*plain*"), "ctx: Paste as Plain Text", await page.md());
  { const b = await wordBox(page, "Hello"); await rclickAt(page, b, ["edit.selectAll"]); const s = await page.sel(); ok(s.from <= 1 && s.to >= (await page.evaluate(() => window.mdnest.editor.view.state.doc.content.size)) - 1, "ctx: Select All", s); }

  // table + task + link submenus
  await page.reset("| a | b |\n|---|---|\n| 1 | 2 |\n");
  await rclickAt(page, await wordBox(page, "1", "#write td"), ["table", "paragraph.table.addRowBelow"]);
  const rows = async () => (await page.md()).trim().split("\n").length - 2;
  ok(await rows() === 2, "ctx: Table > Add Row Below", await page.md());
  await rclickAt(page, await wordBox(page, "1", "#write td"), ["table", "paragraph.table.alignCenter"]);
  ok(/:-+:/.test(await page.md()), "ctx: Table > Align Center", await page.md());
  await rclickAt(page, await wordBox(page, "1", "#write td"), ["table", "paragraph.table.deleteRow"]);
  ok(await rows() === 1, "ctx: Table > Delete Row", await page.md());
  await page.reset("- [ ] task one\n");
  await rclickAt(page, await wordBox(page, "task"), ["task-status", "paragraph.taskStatus.toggle"]);
  ok(/\[x\] task one/.test(await page.md()), "ctx: Task Status > Toggle", await page.md());
  await page.reset("See [the site](https://example.com/x) now\n");
  await rclickAt(page, await wordBox(page, "site"), ["link-actions", "format.link.copy"]);
  ok((await page.clip()) === "https://example.com/x", "ctx: Hyperlink Actions > Copy Link Address", await page.clip());
  await page.context().close();
}
// Chinese UI screenshot of the format submenu
if (SHOTS) {
  const page = await open("ctxzh.md", "你好 world 这里\n", { lang: "zh-CN" });
  const b = await dblWord(page, "world");
  await page.mouse.click(b.x, b.y, { button: "right" }); await page.waitForTimeout(150);
  await page.locator('.context-menu .mdn-menu-item[data-id="format"]').hover(); await page.waitForTimeout(250);
  await page.shot("after-ctx-format-menu-zh.png");
  await page.locator('.context-menu .mdn-menu-item[data-id="format.strong"]').click(); await page.waitForTimeout(250);
  { const w2 = await wordBox(page, "world"); await page.mouse.click(w2.x, w2.y); } await page.waitForTimeout(200); // caret inside: markers revealed
  ok((await page.md()).trim() === "你好 **world** 这里", "ctx (zh UI): 格式 > 加粗", await page.md());
  await page.shot("after-ctx-format-result-zh.png");
  await page.context().close();
}

// =============== 1: autosave ===============
{
  fs.writeFileSync(path.join(WS, "b.md"), "Other file\n");
  const page = await open("a.md", "Start\n");
  await page.locator('.mdn-rail-btn[data-id="settings"]').click(); await page.waitForTimeout(300);
  const sw = page.locator("#set-autosave");
  ok(await sw.count() === 1 && await sw.isChecked(), "autosave: Settings switch exists and is on by default");
  await sw.scrollIntoViewIfNeeded();
  await page.shot("after-autosave-setting.png");
  await page.locator('.mdn-rail-btn[data-id="files"]').click(); await page.waitForTimeout(200);
  await caretEnd(page, "#write p"); await page.keyboard.type(" more");
  await page.waitForTimeout(300);
  const chip1 = await page.locator(".saved-text").textContent();
  ok(/unsaved/i.test(chip1) && disk("a.md") === "Start\n", "autosave: not written immediately, footer shows Unsaved", chip1);
  await page.waitForTimeout(2200);
  const chip2 = await page.locator(".saved-text").textContent();
  ok(disk("a.md") === "Start more\n" && /saved/i.test(chip2) && !/unsaved/i.test(chip2), "autosave: written ~1.5 s after typing stops, footer shows Auto-saved", [disk("a.md"), chip2]);
  await page.shot("after-autosave-saved.png");
  // type slowly across several autosave + mtime-poll cycles: no caret jump / lost keys
  for (const ch of " slow typing across saves") { await page.keyboard.type(ch); await page.waitForTimeout(140); }
  await page.waitForTimeout(400);
  for (const ch of " again") { await page.keyboard.type(ch); await page.waitForTimeout(450); }
  await page.waitForTimeout(2300);
  ok(disk("a.md") === "Start more slow typing across saves again\n" && (await page.md()) === disk("a.md"), "autosave: typing across autosaves keeps caret and every key", disk("a.md"));
  const s1 = await page.sel(); await page.waitForTimeout(2500); const s2 = await page.sel();
  ok(s1.from === s2.from && s1.from === 42, "autosave: caret stays put after own save (no reload)", [s1, s2]);
  // switching files saves without a prompt
  await page.keyboard.type("!");
  await page.locator('#typora-sidebar .mdn-tree-item, #typora-sidebar [data-path]').filter({ hasText: /^b(\.md)?$/ }).first().click(); await page.waitForTimeout(600);
  ok(await page.locator(".modal").count() === 0 && disk("a.md").includes("again!") && (await page.md()).startsWith("Other file"), "autosave: switching files saves the current one (no dialog)", [await page.locator(".modal").count(), disk("a.md")]);
  // window blur / app hidden flushes immediately
  await caretEnd(page, "#write p"); await page.keyboard.type(" blur");
  const p2 = await page.context().newPage(); await p2.goto("about:blank"); await p2.bringToFront(); await page.waitForTimeout(350);
  const blurSaved = disk("b.md").includes("blur");
  if (!blurSaved) { await page.evaluate(() => window.dispatchEvent(new Event("blur"))); await page.waitForTimeout(300); }
  ok(disk("b.md") === "Other file blur\n", "autosave: leaving the window saves right away" + (blurSaved ? "" : " (headless: blur event)"), disk("b.md"));
  await p2.close(); await page.bringToFront();
  // turn it off with a real click
  await page.locator('.mdn-rail-btn[data-id="settings"]').click(); await page.waitForTimeout(300);
  await page.locator("#set-autosave").click(); await page.waitForTimeout(150);
  ok(!(await page.locator("#set-autosave").isChecked()), "autosave: switch turns off");
  await page.locator('.mdn-rail-btn[data-id="files"]').click(); await page.waitForTimeout(200);
  await caretEnd(page, "#write p"); await page.keyboard.type(" off"); await page.waitForTimeout(2500);
  ok(disk("b.md") === "Other file blur\n" && /unsaved/i.test(await page.locator(".saved-text").textContent()), "autosave off: nothing written, stays Unsaved", disk("b.md"));
  await page.keyboard.press("Control+s"); await page.waitForTimeout(400);
  ok(disk("b.md") === "Other file blur off\n", "autosave off: Ctrl+S still saves", disk("b.md"));
  await page.reload(); await page.waitForSelector("body.mdn-ready"); await page.waitForTimeout(300);
  await page.locator('.mdn-rail-btn[data-id="settings"]').click(); await page.waitForTimeout(300);
  ok(!(await page.locator("#set-autosave").isChecked()), "autosave: setting persists across restart");
  await page.locator("#set-autosave").click(); await page.waitForTimeout(150);
  await page.context().close();
}
{
  // untitled draft recovery
  const page = await open("none.md", null, { noFile: true });
  await page.keyboard.press("Control+n"); await page.waitForTimeout(300);
  await page.locator("#write").click(); await page.keyboard.type("Draft words that must survive");
  await page.waitForTimeout(1300);
  const chip = await page.locator(".saved-text").textContent();
  ok(/draft/i.test(chip), "draft: untitled doc shows 'Draft kept' (no prompt)", chip);
  await page.reload(); await page.waitForSelector("body.mdn-ready"); await page.waitForTimeout(600);
  const card = page.locator("#mdn-draft");
  ok(await card.isVisible(), "draft: after a crash/reload a restore card appears");
  await page.shot("after-autosave-draft-card.png");
  await card.locator("button").first().click(); await page.waitForTimeout(300);
  ok((await page.md()).includes("Draft words that must survive"), "draft: Restore brings the text back", await page.md());
  await page.reload(); await page.waitForSelector("body.mdn-ready"); await page.waitForTimeout(600);
  await page.locator("#mdn-draft button").last().click(); await page.waitForTimeout(200);
  await page.reload(); await page.waitForSelector("body.mdn-ready"); await page.waitForTimeout(600);
  ok(await page.locator("#mdn-draft").count() === 0, "draft: Discard removes it for good");
  await page.context().close();
}

// =============== 2: line breaks around blocks ===============
{
  const page = await open("nav.md", "x\n");
  const cases = [
    ["code last ↓", "Intro\n\n```js\nlet a = 1;\n```\n", async () => { await page.locator("#write .CodeMirror-line").first().click(); await page.keyboard.press("End"); await page.keyboard.press("ArrowDown"); }, "after", "Intro\n\n```js\nlet a = 1;\n```\n\nafter\n"],
    ["code last →", "Intro\n\n```js\nlet a = 1;\n```\n", async () => { await page.locator("#write .CodeMirror-line").first().click(); await page.keyboard.press("End"); await page.keyboard.press("ArrowRight"); }, "after", "Intro\n\n```js\nlet a = 1;\n```\n\nafter\n"],
    ["code first ↑", "```js\nlet a = 1;\n```\n\nText\n", async () => { await page.locator("#write .CodeMirror-line").first().click(); await page.keyboard.press("Home"); await page.keyboard.press("ArrowUp"); }, "before", "before\n\n```js\nlet a = 1;\n```\n\nText\n"],
    ["math last ↓", "Intro\n\n$$\nx^2\n$$\n", async () => { await page.locator("#write .md-math-block, #write [mdtype=math_block]").first().click(); await page.waitForTimeout(150); await page.keyboard.press("End"); await page.keyboard.press("ArrowDown"); }, "after", "Intro\n\n$$\nx^2\n$$\n\nafter\n"],
    ["mermaid last ↓", "Intro\n\n```mermaid\ngraph TD; A-->B\n```\n", async () => { await page.locator("#write .md-diagram, #write .mdn-mermaid, #write pre").first().click(); await page.waitForTimeout(200); await page.keyboard.press("Control+End"); await page.keyboard.press("ArrowDown"); }, "after", "Intro\n\n```mermaid\ngraph TD; A-->B\n```\n\nafter\n"],
    ["quote last ↓", "Para\n\n> quote line\n", async () => { await caretEnd(page, "#write blockquote p"); await page.keyboard.press("ArrowDown"); }, "out", "Para\n\n> quote line\n\nout\n"],
    ["list last ↓", "Para\n\n- one\n- two\n", async () => { await caretEnd(page, "#write li p"); await page.keyboard.press("ArrowDown"); }, "out", "Para\n\n- one\n- two\n\nout\n"],
    ["table last ↓", "| a | b |\n|---|---|\n| 1 | 2 |\n", async () => { await page.locator("#write td").first().click(); await page.keyboard.press("ArrowDown"); }, "below", "| a | b |\n|---|---|\n| 1 | 2 |\n\nbelow\n"],
    ["table first ↑", "| a | b |\n|---|---|\n| 1 | 2 |\n", async () => { await page.locator("#write th").first().click(); await page.keyboard.press("Home"); await page.keyboard.press("ArrowUp"); }, "above", "above\n\n| a | b |\n|---|---|\n| 1 | 2 |\n"],
    ["image-only last ↓", "Intro\n\n![pic](pic.png)\n", async () => { await page.locator("#write span.md-image img").click(); await page.keyboard.press("ArrowDown"); }, "after", "Intro\n\n![pic](pic.png)\n\nafter\n"],
    ["html block last ↓", "Intro\n\n<div>box</div>\n", async () => { await page.locator("#write .md-htmlblock").first().click(); await page.waitForTimeout(200); await page.keyboard.press("Control+End"); await page.keyboard.press("ArrowDown"); }, "after", "Intro\n\n<div>box</div>\n\nafter\n"],
    ["between two code blocks (gap cursor)", "```js\na\n```\n\n```py\nb\n```\n", async () => { await page.locator("#write .CodeMirror-line").first().click(); await page.keyboard.press("End"); await page.keyboard.press("ArrowDown"); }, "mid", "```js\na\n```\n\nmid\n\n```py\nb\n```\n"],
    ["Ctrl+Enter in a code block", "```js\na\n```\n\n```py\nb\n```\n", async () => { await page.locator("#write .CodeMirror-line").first().click(); await page.keyboard.press("Control+Enter"); }, "mid", "```js\na\n```\n\nmid\n\n```py\nb\n```\n"],
    ["Ctrl+Enter in a quote", "> q\n\nEnd\n", async () => { await caretEnd(page, "#write blockquote p"); await page.keyboard.press("Control+Enter"); }, "next", "> q\n\nnext\n\nEnd\n"],
    ["Ctrl+Enter in a list", "- one\n- two\n\nEnd\n", async () => { await page.locator("#write li p").first().click(); await page.keyboard.press("Control+Enter"); }, "next", "- one\n- two\n\nnext\n\nEnd\n"],
    ["Ctrl+Enter in a math block", "$$\nx\n$$\n\n$$\ny\n$$\n", async () => { await page.locator("#write .md-math-block, #write [mdtype=math_block]").first().click(); await page.waitForTimeout(150); await page.keyboard.press("Control+Enter"); }, "mid", "$$\nx\n$$\n\nmid\n\n$$\ny\n$$\n"],
    ["Enter twice exits a list", "- one\n", async () => { await caretEnd(page, "#write li p"); await page.keyboard.press("Enter"); await page.keyboard.press("Enter"); }, "out", "- one\n\nout\n"],
    ["Enter twice exits a quote", "> q\n", async () => { await caretEnd(page, "#write blockquote p"); await page.keyboard.press("Enter"); await page.keyboard.press("Enter"); }, "out", "> q\n\nout\n"],
    ["Shift+Enter soft break", "Line one\n", async () => { await caretEnd(page, "#write p"); await page.keyboard.press("Shift+Enter"); }, "two", "Line one\ntwo\n"],
  ];
  for (const [name, md, act, typed, want] of cases) {
    await page.reset(md); await page.waitForTimeout(200);
    await act(); await page.waitForTimeout(200);
    if (name.includes("gap")) { const s = await page.sel(); ok(s.t === "gapcursor", "blocks: " + name + " — caret is a gap cursor", s); if (SHOTS) await page.shot("after-gapcursor.png"); }
    await page.keyboard.type(typed); await page.waitForTimeout(150);
    const got = await page.md();
    ok(got === want, "blocks: " + name, got);
  }
  // code ↑ inside: first line ↑ from the second line stays inside; only the first line escapes
  await page.reset("Top\n\n```js\na\nb\n```\n");
  await page.locator("#write .CodeMirror-line").nth(1).click(); await page.keyboard.press("ArrowUp"); await page.keyboard.type("X");
  ok(/```js\nXa|```js\naX|```js\nX?a/.test(await page.md()) && (await page.md()).startsWith("Top\n\n```js\n"), "blocks: ↑ inside a code block moves between its lines", await page.md());
  await page.keyboard.press("Home"); await page.keyboard.press("ArrowUp"); await page.keyboard.type("Y");
  ok((await page.md()).startsWith("TopY\n\n```js"), "blocks: ↑ on the first code line leaves into the paragraph above", await page.md());
  // Shift+Enter survives a save + reopen
  await page.reset("Line one\n"); await caretEnd(page, "#write p"); await page.keyboard.press("Shift+Enter"); await page.keyboard.type("two");
  await page.keyboard.press("Control+s"); await page.waitForTimeout(400);
  await page.reload(); await page.waitForSelector("body.mdn-ready"); await page.waitForTimeout(400);
  ok(disk("nav.md") === "Line one\ntwo\n" && (await page.md()) === "Line one\ntwo\n" && (await page.locator("#write p").count()) === 1, "blocks: soft line break saved as a single newline and reopened as one paragraph", disk("nav.md"));
  await page.context().close();
}

// =============== 3: keyboard block deletion ===============
{
  const page = await open("del.md", "x\n");
  const backspaceAfter = [
    ["code block", "Intro\n\n```js\ncode\n```\n\nAfter\n", "code_block"],
    ["math block", "Intro\n\n$$\nx^2\n$$\n\nAfter\n", "math_block"],
    ["mermaid", "Intro\n\n```mermaid\ngraph TD; A-->B\n```\n\nAfter\n", "code_block"],
    ["HTML block", "Intro\n\n<div>box</div>\n\nAfter\n", "html_block"],
    ["table", "Intro\n\n| a | b |\n|---|---|\n| 1 | 2 |\n\nAfter\n", "table"],
    ["horizontal rule", "Intro\n\n---\n\nAfter\n", "horizontal_rule"],
    ["TOC", "Intro\n\n[TOC]\n\nAfter\n", "toc"],
    ["image", "Intro\n\n![pic](pic.png)\n\nAfter\n", "image"],
  ];
  for (const [name, md, type] of backspaceAfter) {
    await page.reset(md); await page.waitForTimeout(300);
    await page.locator("#write > p", { hasText: "After" }).click(); await page.keyboard.press("Home");
    await page.keyboard.press("Backspace"); await page.waitForTimeout(200);
    const s = await page.sel();
    const hl = await page.evaluate(() => !!document.querySelector("#write .ProseMirror-selectednode"));
    ok(s.t === "node" && s.node === type && hl, `delete: Backspace after a ${name} selects it (highlighted)`, s);
    if (name === "code block" && SHOTS) await page.shot("after-block-selected.png");
    await page.keyboard.press("Backspace"); await page.waitForTimeout(200);
    const got = (await page.md()).trim();
    ok(got === "Intro\n\nAfter" || got === "Intro\n\n\nAfter".replace(/\n\n\n/, "\n\n"), `delete: second Backspace removes the ${name}`, got);
  }
  for (const [name, md, type] of backspaceAfter.slice(0, 6)) {
    await page.reset(md.replace("Intro\n\n", "Intro\n\n").replace("\n\nAfter\n", "\n\nAfter\n")); await page.waitForTimeout(300);
    await caretEnd(page, "#write > p:first-child"); await page.keyboard.press("Delete"); await page.waitForTimeout(200);
    const s = await page.sel();
    await page.keyboard.press("Delete"); await page.waitForTimeout(200);
    ok(s.t === "node" && s.node === type && (await page.md()).trim() === "Intro\n\nAfter", `delete: Delete before a ${name} selects, then removes it`, [s, await page.md()]);
  }
  // empty blocks: Backspace turns them into a paragraph
  for (const [name, md, sel] of [["code", "Intro\n\n```js\n```\n", "#write .CodeMirror-line"], ["math", "Intro\n\n$$\n$$\n", "#write .md-math-block, #write [mdtype=math_block]"], ["HTML", "Intro\n\n<div></div>\n", "#write .md-htmlblock"]]) {
    await page.reset(md); await page.waitForTimeout(300);
    if (name === "HTML") {
      await page.locator(sel).first().click(); await page.waitForTimeout(200);
      await page.keyboard.press("Control+a"); await page.keyboard.press("Backspace"); await page.waitForTimeout(100);
    } else { await page.locator(sel).first().click(); await page.waitForTimeout(200); }
    await page.keyboard.press("Backspace"); await page.waitForTimeout(200);
    await page.keyboard.type("p");
    const got = await page.md();
    ok(got === "Intro\n\np\n", `delete: Backspace in an empty ${name} block turns it into a paragraph`, got);
  }
  // block handle: hover + click grip selects, Delete removes
  await page.reset("Intro\n\n| a | b |\n|---|---|\n| 1 | 2 |\n\nAfter\n"); await page.waitForTimeout(300);
  await page.locator("#write table").hover(); await page.waitForTimeout(250);
  const h = page.locator(".mdn-block-handle");
  ok(await h.isVisible(), "delete: hovering a block shows its grip handle");
  if (SHOTS) await page.shot("after-block-handle.png");
  await h.click(); await page.waitForTimeout(200);
  const hs = await page.sel();
  ok(hs.t === "node" && hs.node === "table", "delete: clicking the grip selects the whole table", hs);
  await page.keyboard.press("Delete"); await page.waitForTimeout(200);
  ok((await page.md()).trim() === "Intro\n\nAfter", "delete: Delete removes the grip-selected block", await page.md());
  await page.reset("Intro\n\n```js\ncode\n```\n\nAfter\n"); await page.waitForTimeout(300);
  await page.locator("#write .CodeMirror").hover(); await page.waitForTimeout(250); await page.locator(".mdn-block-handle").click(); await page.waitForTimeout(200);
  await page.keyboard.press("Backspace"); await page.waitForTimeout(200);
  ok((await page.md()).trim() === "Intro\n\nAfter", "delete: grip-select a code block + Backspace removes it", await page.md());
  // range selection over several blocks
  await page.reset("First para\n\n```js\ncode\n```\n\n| a | b |\n|---|---|\n| 1 | 2 |\n\n![pic](pic.png)\n\nLast para\n"); await page.waitForTimeout(400);
  { const a = await wordBox(page, "para"); await page.mouse.click(a.x + 30, a.y); const z = await wordBox(page, "Last"); await page.keyboard.down("Shift"); await page.mouse.click(z.x - 14, z.y); await page.keyboard.up("Shift"); }
  await page.waitForTimeout(150); await page.keyboard.press("Backspace"); await page.waitForTimeout(200);
  ok((await page.md()).trim() === "First paraLast para", "delete: a range spanning code/table/image is removed by Backspace", await page.md());
  // Ctrl+C / Ctrl+X on a selected block, then paste it back
  await page.reset("Intro\n\n```js\ncode\n```\n\nAfter\n"); await page.waitForTimeout(300);
  await page.locator("#write > p", { hasText: "After" }).click(); await page.keyboard.press("Home"); await page.keyboard.press("Backspace"); await page.waitForTimeout(150);
  await page.keyboard.press("Control+c"); await page.waitForTimeout(200);
  ok((await page.clip()).trim() === "```js\ncode\n```", "delete: Ctrl+C on a selected code block copies its Markdown", await page.clip());
  await page.keyboard.press("Control+x"); await page.waitForTimeout(200);
  ok((await page.md()).trim() === "Intro\n\nAfter", "delete: Ctrl+X cuts the selected block", await page.md());
  await caretEnd(page, "#write > p:last-child"); await page.keyboard.press("Enter"); await page.keyboard.press("Control+v"); await page.waitForTimeout(300);
  ok(/After\n\n```js\ncode\n```/.test(await page.md()), "delete: Ctrl+V pastes the cut block back as a code block", await page.md());
  // image cut via selection
  await page.reset("Intro\n\n![pic](pic.png)\n\nAfter\n"); await page.waitForTimeout(300);
  await page.locator("#write span.md-image img").click(); await page.keyboard.press("Control+x"); await page.waitForTimeout(200);
  ok(!(await page.md()).includes("pic.png") && (await page.clip()).includes("pic.png"), "delete: click an image + Ctrl+X cuts it", [await page.md(), await page.clip()]);
  await page.context().close();
}

// =============== 5: image size / alignment ===============
{
  const page = await open("img.md", "Intro text\n\n![pic](pic.png)\n\nAfter\n");
  const img = page.locator("#write span.md-image img");
  await img.click(); await page.waitForTimeout(200);
  ok(await page.locator(".mdn-imgbar").isVisible(), "image: clicking an image shows the size/align toolbar");
  const width = () => img.evaluate((e) => Math.round(e.getBoundingClientRect().width));
  const w100 = await width();
  for (const z of [25, 33, 50, 67, 75, 150, 200, 100]) {
    await page.locator('.mdn-imgbar [data-a=zoom]').click(); await page.waitForTimeout(150);
    await page.locator(`.context-menu .mdn-menu-item[data-id="zoom:${z}"]`).click(); await page.waitForTimeout(200);
    const md = await page.md(), w = await width();
    const want = z === 100 ? "![pic](pic.png)" : `<img src="pic.png" alt="pic" style="zoom:${z}%;" />`;
    ok(md.includes(want) && Math.abs(w - Math.min(w100 * z / 100, 99999)) <= 3 || (z === 200 && md.includes(want)), `image: toolbar zoom ${z}%`, [md, w, w100]);
  }
  await page.locator('.mdn-imgbar [data-a=center]').click(); await page.waitForTimeout(150);
  ok((await page.md()).includes('<img src="pic.png" alt="pic" style="display:block;margin:0 auto;" />'), "image: align center", await page.md());
  const cx = await img.evaluate((e) => { const r = e.getBoundingClientRect(), w = document.querySelector("#write").getBoundingClientRect(); return Math.abs((r.left + r.right) / 2 - (w.left + w.right) / 2); });
  ok(cx < 30, "image: centered image is visually centered", cx);
  await page.locator('.mdn-imgbar [data-a=right]').click(); await page.waitForTimeout(150);
  ok((await page.md()).includes('style="display:block;margin-left:auto;"'), "image: align right", await page.md());
  await page.locator('.mdn-imgbar [data-a=left]').click(); await page.waitForTimeout(150);
  ok((await page.md()).includes('style="display:block;margin-right:auto;"'), "image: align left", await page.md());
  await page.locator('.mdn-imgbar [data-a=width]').click(); await page.waitForTimeout(200);
  await page.keyboard.press("Control+a"); await page.keyboard.type("320"); await page.keyboard.press("Enter"); await page.waitForTimeout(250);
  ok((await page.md()).includes('<img src="pic.png" alt="pic" width="320" style="display:block;margin-right:auto;" />') && Math.abs((await width()) - 320) <= 2, "image: custom width 320 px", [await page.md(), await width()]);
  await page.locator('.mdn-imgbar [data-a=center]').click(); await page.waitForTimeout(150);
  await page.locator('.mdn-imgbar [data-a=zoom]').click(); await page.waitForTimeout(150);
  await page.locator('.context-menu .mdn-menu-item[data-id="zoom:50"]').click(); await page.waitForTimeout(200);
  if (SHOTS) await page.shot("after-image-toolbar.png");
  // drag the corner handle
  const g = await page.locator(".mdn-img-resize").boundingBox();
  await page.mouse.move(g.x + 5, g.y + 5); await page.mouse.down(); await page.mouse.move(g.x + 45, g.y + 20, { steps: 6 });
  const tip = await page.locator(".mdn-img-size-tip").isVisible();
  if (SHOTS) await page.shot("after-image-drag.png");
  await page.mouse.up(); await page.waitForTimeout(200);
  const dz = /zoom:(\d+)%/.exec(await page.md());
  ok(dz && +dz[1] > 50 && +dz[1] < 90 && tip, "image: dragging the corner handle resizes (size tip while dragging)", [await page.md(), tip]);
  // context menu image submenu
  await img.click({ button: "right" }); await page.waitForTimeout(150);
  await page.locator('.context-menu .mdn-menu-item[data-id="image-align"]').hover(); await page.waitForTimeout(150);
  await page.locator('.context-menu .mdn-menu-item[data-id="image-zoom"]').hover(); await page.waitForTimeout(150);
  await page.locator('.context-menu .mdn-menu-item[data-id="format.image.zoom33"]').click(); await page.waitForTimeout(200);
  ok((await page.md()).includes('style="display:block;margin:0 auto;zoom:33%;"'), "image: right-click > Image > Zoom > 33%", await page.md());
  await page.keyboard.press("Control+s"); await page.waitForTimeout(300);
  const saved = disk("img.md");
  await page.reload(); await page.waitForSelector("body.mdn-ready"); await page.waitForTimeout(500);
  const re = await page.md();
  const z2 = await page.locator("#write span.md-image img").evaluate((e) => getComputedStyle(e).zoom);
  ok(re === saved && saved === 'Intro text\n\n<img src="pic.png" alt="pic" style="display:block;margin:0 auto;zoom:33%;" />\n\nAfter\n' && Math.abs(+z2 - 0.33) < 0.01, "image: reopen round-trips byte for byte and renders at 33%", [saved, re, z2]);
  await page.locator("#write span.md-image img").click({ button: "right" }); await page.waitForTimeout(150);
  await page.locator('.context-menu .mdn-menu-item[data-id="image-align"]').hover(); await page.waitForTimeout(150);
  if (SHOTS) { await page.locator('.context-menu .mdn-menu-item[data-id="image-zoom"]').hover(); await page.waitForTimeout(200); await page.shot("after-image-context-menu.png"); await page.keyboard.press("Escape"); await page.waitForTimeout(100); await page.keyboard.press("Escape");
    await page.locator("#write span.md-image img").click({ button: "right" }); await page.waitForTimeout(150);
    await page.locator('.context-menu .mdn-menu-item[data-id="image-align"]').hover(); await page.waitForTimeout(150); }
  await page.locator('.context-menu .mdn-menu-item[data-id="format.image.reset"]').click(); await page.waitForTimeout(200);
  await page.locator('.mdn-imgbar [data-a=center]').click(); await page.waitForTimeout(150);
  ok((await page.md()) === "Intro text\n\n![pic](pic.png)\n\nAfter\n", "image: Original Size + un-align returns to plain ![]()", await page.md());
  await page.context().close();
}
{
  // foreign Typora-written tags are kept verbatim until changed
  const src = 'A\n\n<img src="pic.png" alt="x" style="zoom: 67%; border: 1px solid red" data-k="1">\n\nB\n';
  const page = await open("img2.md", src);
  await page.locator("#write > p").first().click(); await page.keyboard.press("End"); await page.keyboard.type("!"); await page.keyboard.press("Backspace");
  ok((await page.md()) === src, "image: untouched foreign <img> saved byte for byte", await page.md());
  await page.locator("#write span.md-image img").click(); await page.waitForTimeout(150);
  ok((await page.locator(".mdn-imgbar .z").textContent()).trim() === "67%", "image: toolbar reads Typora zoom 67%", await page.locator(".mdn-imgbar .z").textContent());
  await page.locator('.mdn-imgbar [data-a=zoom]').click(); await page.waitForTimeout(150);
  await page.locator('.context-menu .mdn-menu-item[data-id="zoom:50"]').click(); await page.waitForTimeout(200);
  ok((await page.md()).includes('<img src="pic.png" alt="x" style="zoom:50%;border: 1px solid red;" data-k="1" />'), "image: editing keeps foreign attributes/styles", await page.md());
  await page.context().close();
}

ok(errors.length === 0, "no page errors", errors);
await browser.close();
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
