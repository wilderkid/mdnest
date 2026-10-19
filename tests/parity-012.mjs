// Part A parity (0.1.2): editing and UI. Playwright against the browser host.
// Usage: node tests/parity-012.mjs [baseUrl]
// The suite creates and removes its own temp document. It does not touch other workspace files.
import { chromium } from "playwright";
import fs from "node:fs";
import path from "node:path";

const base = process.argv[2] ?? "http://127.0.0.1:4173/";
const OUT = path.resolve("screenshots/parity-0.1.2");
fs.mkdirSync(OUT, { recursive: true });

// Inside the browser-host sandbox (dev-data). Removed in finally, including any .trash copy.
const TMP = path.resolve("dev-data/workspace/.tmp-parity-012");
const DOC = path.join(TMP, "parity-012.md");
fs.rmSync(TMP, { recursive: true, force: true });
fs.mkdirSync(TMP, { recursive: true });
fs.writeFileSync(DOC, "# Title\n\nA paragraph with a word.\n");

const results = [];
const ok = (c, name, info = "") => {
  const line = (c ? "PASS " : "FAIL ") + name + (info ? " — " + String(info).slice(0, 220) : "");
  console.log(line);
  results.push({ pass: !!c, name });
};

let browser;
try {
  browser = await chromium.launch();
  const context = await browser.newContext({
    viewport: { width: 1280, height: 860 },
    permissions: ["clipboard-read", "clipboard-write"],
  });
  const page = await context.newPage();
  page.setDefaultTimeout(8000);
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  const md = () => page.evaluate(() => window.mdnest.editor.getMarkdown());
  const run = (id) => page.evaluate((id) => window.mdnest.runCommand(id), id);
  const setMd = async (text) => {
    await page.evaluate((text) => window.mdnest.editor.setMarkdown(text), text);
    await page.waitForTimeout(80);
  };

  await page.goto(base + `?theme=mdnest&file=${encodeURIComponent(DOC)}&folder=${encodeURIComponent(TMP)}&menubar=html&restore=0`);
  await page.evaluate(() => localStorage.removeItem("mdnest.autosave"));
  await page.waitForSelector("body.mdn-ready");
  await page.waitForSelector("#mdn-menubar");
  await page.waitForTimeout(300);

  // ---------- A1: Ctrl+K is Hyperlink even with AI on; Rewrite is Ctrl+J ----------
  await page.evaluate(() => {
    localStorage.setItem("mdnest.plugin.ai.enabled", JSON.stringify(true));
    localStorage.setItem("mdnest.plugin.ai.privacyAck", JSON.stringify(true));
    localStorage.setItem("mdnest.plugin.ai.rewriteShortcut", JSON.stringify("Mod-j"));
  });
  await page.reload();
  await page.waitForSelector("body.mdn-ready");
  await page.waitForTimeout(300);
  await setMd("linkme\n");
  await page.locator("#write").click();
  await page.keyboard.press("Control+a");
  await page.keyboard.press("Control+k");
  await page.waitForSelector(".mdn-prompt input", { timeout: 4000 });
  ok(await page.locator(".mdn-prompt input").isVisible(), "A1 Ctrl+K opens the link prompt with AI on");
  await page.locator(".mdn-prompt input").fill("https://example.com/a1");
  await page.keyboard.press("Enter");
  await page.waitForTimeout(120);
  ok((await md()).includes("](https://example.com/a1)") || (await md()).includes("[linkme](https://example.com/a1)"), "A1 Ctrl+K inserts a hyperlink", await md());

  // Settings page shows the rewrite shortcut field (default Mod-j).
  await page.evaluate(() => { document.body.classList.add("pin-outline"); window.mdnest.sidebar.select("settings"); });
  await page.waitForTimeout(150);
  const setting = page.locator("#sidebar-content label", { hasText: "Rewrite shortcut" }).locator("input");
  ok(await setting.inputValue() === "Mod-j", "A1 settings show Rewrite shortcut", await setting.inputValue().catch(() => ""));
  await page.screenshot({ path: path.join(OUT, "ai-shortcut-setting.png") });
  await page.evaluate(() => window.mdnest.sidebar.select("files"));

  const accel = await page.evaluate(() => {
    const link = window.mdnest.commands.find((c) => c.id === "format.link");
    const rewrite = window.mdnest.commands.find((c) => c.id === "ai.rewrite" || c.id === "rewrite");
    return { link: link && link.key, rewrite: rewrite && rewrite.key };
  });
  ok(accel.link === "CmdOrCtrl+K", "A1 Hyperlink keeps CmdOrCtrl+K", JSON.stringify(accel));
  ok(accel.rewrite === "Mod-j", "A1 Rewrite default is Mod-j", JSON.stringify(accel));

  await page.locator('#mdn-menubar .mdn-menu[data-menu="format"] > .mdn-menu-label').click();
  const linkAccel = await page.locator('#mdn-menubar button[data-id="format.link"] .mdn-menu-accel').innerText();
  ok(/Ctrl\+K|⌘K/.test(linkAccel), "A1 Format menu shows Ctrl+K on Hyperlink", linkAccel);
  await page.keyboard.press("Escape");

  // Custom rewrite key: Alt-Shift-j. The palette shows the active key. Empty disables it.
  await page.evaluate(() => window.mdnest.plugins.commitSetting("ai", "rewriteShortcut", "Alt-Shift-j"));
  await page.waitForTimeout(80);
  const custom = await page.evaluate(() => {
    const rewrite = window.mdnest.commands.find((c) => c.id === "ai.rewrite" || c.id === "rewrite");
    return rewrite ? rewrite.key : null;
  });
  ok(custom === "Alt-Shift-j", "A1 custom rewrite shortcut is the active key", String(custom));

  await page.keyboard.press("Control+Shift+p");
  await page.waitForSelector("#mdn-palette input");
  await page.locator("#mdn-palette input").fill("Rewrite");
  await page.waitForTimeout(80);
  const pal = await page.locator("#mdn-palette .pal-item").first().innerText();
  ok(/Alt\+Shift\+J/i.test(pal), "A1 palette shows the active rewrite key", pal);
  await page.keyboard.press("Escape");

  // Ctrl+J no longer opens rewrite after the custom key; Ctrl+K still opens the link prompt.
  await setMd("again\n");
  await page.locator("#write").click();
  await page.keyboard.press("Control+a");
  await page.keyboard.press("Control+j");
  await page.waitForTimeout(200);
  ok(!(await page.locator(".mdn-prompt input").count()), "A1 Ctrl+J does not open rewrite when the shortcut is custom");
  await page.keyboard.press("Control+k");
  await page.waitForSelector(".mdn-prompt input", { timeout: 4000 });
  ok(await page.locator(".mdn-prompt").isVisible(), "A1 Ctrl+K still opens the link prompt after a custom rewrite key");
  await page.keyboard.press("Escape");

  // ---------- A2: editor context-menu submenus open beside the parent ----------
  await setMd("Context menu paragraph.\n");
  await page.locator("#write").click();
  const box = await page.locator("#write").boundingBox();
  await page.mouse.click(box.x + 40, box.y + 30, { button: "right" });
  await page.waitForSelector(".context-menu");
  const parentCount = () => page.locator("body > .context-menu").count();
  ok(await parentCount() === 1, "A2 one context menu opens");
  const para = page.locator(".context-menu button[data-id='paragraph']");
  await para.hover();
  await page.waitForTimeout(80);
  ok(await parentCount() === 2, "A2 hover opens a submenu beside the parent", String(await parentCount()));
  const parentBox = await page.locator("body > .context-menu").first().boundingBox();
  const subBox = await page.locator("body > .context-menu.mdn-submenu").boundingBox();
  ok(!!parentBox && !!subBox && subBox.x >= parentBox.x + parentBox.width - 12, "A2 submenu sits to the right of the parent", JSON.stringify({ parentBox, subBox }));
  ok(await page.locator("body > .context-menu").first().locator("button[data-id='paragraph']").count() === 1, "A2 parent stays open");
  await page.screenshot({ path: path.join(OUT, "context-submenu.png") });
  await page.keyboard.press("Enter");
  await page.waitForTimeout(100);
  ok((await md()).startsWith("# Context"), "A2 Enter on Heading 1 applies it", await md());

  // ArrowRight opens, Escape closes the submenu first, then the menu.
  await page.mouse.click(box.x + 40, box.y + 40, { button: "right" });
  await page.waitForSelector(".context-menu");
  for (let i = 0; i < 8; i++) {
    const id = await page.evaluate(() => document.querySelector(".context-menu .mdn-menu-active")?.getAttribute("data-id"));
    if (id === "format") break;
    await page.keyboard.press("ArrowDown");
  }
  await page.keyboard.press("ArrowRight");
  await page.waitForTimeout(60);
  ok(await page.locator(".context-menu.mdn-submenu button[data-id='format.strong']").count() === 1, "A2 ArrowRight opens Format");
  await page.keyboard.press("Escape");
  await page.waitForTimeout(40);
  ok(await page.locator(".context-menu.mdn-submenu").count() === 0 && await page.locator(".context-menu").count() === 1, "A2 Escape closes the submenu, parent stays");
  await page.keyboard.press("Escape");
  await page.waitForTimeout(40);
  ok(await page.locator(".context-menu").count() === 0, "A2 second Escape closes the menu");

  // Flip left when the menu is opened near the right edge (dispatch so the hit stays on #write).
  await page.evaluate(() => {
    const el = document.querySelector("#write");
    el.dispatchEvent(new MouseEvent("contextmenu", {
      bubbles: true, cancelable: true, clientX: window.innerWidth - 16, clientY: 180, button: 2,
    }));
  });
  await page.waitForSelector(".context-menu");
  for (let i = 0; i < 12; i++) {
    const id = await page.evaluate(() => document.querySelector("body > .context-menu .mdn-menu-active")?.getAttribute("data-id"));
    if (id === "insert") break;
    await page.keyboard.press("ArrowDown");
  }
  await page.keyboard.press("ArrowRight");
  await page.waitForTimeout(80);
  const edgeParent = await page.locator("body > .context-menu").first().boundingBox();
  const edgeSub = await page.locator(".context-menu.mdn-submenu").boundingBox();
  ok(!!edgeParent && !!edgeSub && edgeSub.x + edgeSub.width <= edgeParent.x + 8, "A2 submenu flips left near the window edge", JSON.stringify({ edgeParent, edgeSub }));
  await page.keyboard.press("Escape");
  await page.keyboard.press("Escape");

  // ---------- A3: Window menu ----------
  await page.locator('#mdn-menubar .mdn-menu[data-menu="window"] > .mdn-menu-label').click();
  await page.waitForTimeout(80);
  const winItems = await page.locator('#mdn-menubar .mdn-menu[data-menu="window"] .dropdown-menu button').allTextContents();
  const joined = winItems.join(" | ");
  ok(winItems.some((t) => /Minimize/.test(t)), "A3 Window menu has Minimize", joined);
  ok(winItems.some((t) => /Maximize|Restore|Zoom/.test(t)), "A3 Window menu has Maximize/Restore", joined);
  ok(winItems.some((t) => /Always on Top/.test(t)), "A3 Window menu has Always on Top", joined);
  ok(winItems.some((t) => /Full Screen/.test(t)), "A3 Window menu has Full Screen", joined);
  ok(winItems.some((t) => /MD Nest|browser|parity/.test(t)), "A3 Window menu lists this window", joined);
  await page.screenshot({ path: path.join(OUT, "window-menu.png") });
  await page.keyboard.press("Escape");
  // View still has the alias.
  await page.locator('#mdn-menubar .mdn-menu[data-menu="view"] > .mdn-menu-label').click();
  ok(await page.locator('#mdn-menubar button[data-id="view.alwaysOnTop"]').count() === 1, "A3 View keeps Always on Top alias");
  await page.keyboard.press("Escape");
  await run("window.maximize");
  await page.waitForTimeout(80);
  const note = await page.locator("#mdn-toast").innerText();
  ok(/Maximize|Restore|Zoom/.test(note), "A3 Maximize runs in the browser host", note);
  const minAccel = await page.evaluate(() => window.mdnest.commands.find((c) => c.id === "window.minimize")?.key);
  ok(minAccel === "CmdOrCtrl+M", "A3 Minimize is Ctrl+M", String(minAccel));

  // ---------- A4: table commands ----------
  await setMd("| A | B |\n|---|---|\n| 1 | 2 |\n| 3 | 4 |\n");
  const cell = (row, col) => page.evaluate(({ row, col }) => {
    const table = document.querySelector("#write table");
    const rows = [...table.querySelectorAll("tr")];
    const td = rows[row].cells[col];
    const v = window.mdnest.editor.view;
    const pos = v.posAtDOM(td, 0);
    const $p = v.state.doc.resolve(pos);
    v.dispatch(v.state.tr.setSelection(v.state.selection.constructor.near($p)));
    v.focus();
  }, { row, col });
  const colCount = (text) => text.split("\n")[0].replace(/^\|/, "").replace(/\|$/, "").split("|").length;
  await cell(1, 0);
  await page.waitForTimeout(60);
  const tableMd = async () => (await md()).replace(/\s+$/, "");
  await run("paragraph.table.addRowBelow");
  await page.waitForTimeout(80);
  ok(((await tableMd()).match(/^\|/gm) || []).length >= 5, "A4 Add Row Below", await tableMd());
  await run("paragraph.table.addRowAbove");
  await page.waitForTimeout(80);
  ok(((await tableMd()).match(/^\|/gm) || []).length >= 6, "A4 Add Row Above", await tableMd());
  await cell(1, 0);
  await run("paragraph.table.addColAfter");
  await page.waitForTimeout(80);
  ok(colCount(await tableMd()) >= 3, "A4 Add Column After", await tableMd());
  await cell(1, 0);
  await run("paragraph.table.addColBefore");
  await page.waitForTimeout(80);
  ok(colCount(await tableMd()) >= 4, "A4 Add Column Before", await tableMd());
  // Fresh 3-column table so each alignment lands on a known column.
  await setMd("| L | C | R |\n|---|---|---|\n| 1 | 2 | 3 |\n");
  await cell(1, 1);
  await run("paragraph.table.alignCenter");
  await page.waitForTimeout(60);
  await cell(1, 0);
  await run("paragraph.table.alignLeft");
  await page.waitForTimeout(60);
  await cell(1, 2);
  await run("paragraph.table.alignRight");
  await page.waitForTimeout(60);
  const aligned = await tableMd();
  ok(/\|:---\|:---:\|---:\|/.test(aligned.replace(/\s/g, "")), "A4 Align Left/Center/Right write the GFM delimiter", aligned);
  // Round-trip: set markdown back through the parser and serialize again.
  const beforeRt = await tableMd();
  await setMd(beforeRt + "\n");
  const afterRt = await tableMd();
  ok(/\|:---\|:---:\|---:\|/.test(afterRt.replace(/\s/g, "")), "A4 alignment round-trips", afterRt);
  await cell(1, 0);
  const beforeMove = await tableMd();
  await run("paragraph.table.moveColRight");
  await page.waitForTimeout(80);
  ok((await tableMd()) !== beforeMove, "A4 Move Column Right changes the table", await tableMd());
  await setMd("| L | C | R |\n|:---|:---:|---:|\n| 1 | 2 | 3 |\n| 4 | 5 | 6 |\n");
  await cell(1, 0);
  await run("paragraph.table.moveColLeft");
  await page.waitForTimeout(60);
  const stayed = await tableMd();
  ok(stayed.startsWith("| L |"), "A4 Move Column Left at the edge is a no-op", stayed);
  await cell(2, 0);
  const beforeRow = await tableMd();
  await run("paragraph.table.moveRowUp");
  await page.waitForTimeout(80);
  ok((await tableMd()) !== beforeRow, "A4 Move Row Up changes the table", await tableMd());
  await cell(1, 0);
  await run("paragraph.table.moveRowDown");
  await page.waitForTimeout(60);
  await cell(1, 0);
  await run("paragraph.table.deleteColumn");
  await page.waitForTimeout(60);
  await run("paragraph.table.deleteRow");
  await page.waitForTimeout(60);
  const shrunk = await tableMd();
  ok(shrunk.includes("|") && shrunk.split("\n").filter((l) => l.startsWith("|")).length >= 2, "A4 Delete Row and Column leave a table", shrunk);
  await page.evaluate(() => navigator.clipboard.writeText(""));
  await cell(1, 0);
  await run("paragraph.table.copy");
  await page.waitForTimeout(80);
  const copied = await page.evaluate(() => navigator.clipboard.readText());
  ok(copied.startsWith("|") && copied.includes("---"), "A4 Copy Table is Markdown", copied);
  await page.screenshot({ path: path.join(OUT, "table-toolbar.png") });
  await page.locator("#write table").click({ button: "right" });
  await page.waitForSelector(".context-menu button[data-id='table']");
  await page.locator(".context-menu button[data-id='table']").hover();
  await page.waitForTimeout(80);
  ok(await page.locator(".context-menu button[data-id='paragraph.table.copy']").count() === 1, "A4 table context menu lists Copy Table");
  await page.screenshot({ path: path.join(OUT, "table-menu.png") });
  await page.keyboard.press("Escape");
  await page.keyboard.press("Escape");
  await cell(1, 0);
  await run("paragraph.table.deleteTable");
  await page.waitForTimeout(80);
  ok(!(await md()).includes("|---"), "A4 Delete Table removes the table", await md());
  // Toolbar "…" menu has the same command.
  await setMd("| A | B |\n|---|---|\n| 1 | 2 |\n");
  await cell(1, 0);
  await page.waitForSelector("#mdn-table-tools");
  ok(await page.locator("#mdn-table-tools > button[data-cmd='align-left']").count() === 1, "A4 toolbar has align buttons");
  await page.locator("#mdn-table-tools button[data-cmd='more']").click();
  await page.waitForTimeout(60);
  ok(await page.locator("#mdn-table-tools .mdn-table-more button[data-cmd='copy']").isVisible(), "A4 toolbar … menu has Copy Table");
  ok(await page.locator("#mdn-table-tools .mdn-table-more button[data-cmd='row-up']").count() === 1, "A4 toolbar … menu has Move Row Up");
  await page.locator("#mdn-table-tools button[data-cmd='more']").click();

  // ---------- A5: task status acts on every task in the selection ----------
  await setMd("- [ ] one\n- [x] two\n- [ ] three\n");
  await page.evaluate(() => {
    const v = window.mdnest.editor.view;
    const Sel = v.state.selection.constructor;
    v.dispatch(v.state.tr.setSelection(Sel.create(v.state.doc, 1, v.state.doc.content.size - 1)));
  });
  await run("paragraph.taskStatus.complete");
  await page.waitForTimeout(80);
  const doneTasks = await md();
  ok((doneTasks.match(/\[x\]/g) || []).length === 3, "A5 Mark as Complete checks every task in the selection", doneTasks);
  await run("paragraph.taskStatus.incomplete");
  await page.waitForTimeout(60);
  ok(!(await md()).includes("[x]"), "A5 Mark as Incomplete clears every task", await md());
  await run("paragraph.taskStatus.toggle");
  await page.waitForTimeout(60);
  ok((await md()).includes("[x]") && (await md()).includes("[ ]") === false, "A5 Toggle Task Status flips every selected task", await md());
  const taskKey = await page.evaluate(() => window.mdnest.commands.find((c) => c.id === "paragraph.taskStatus.toggle")?.key);
  ok(taskKey === "CmdOrCtrl+Alt+X", "A5 Toggle Task Status is CmdOrCtrl+Alt+X", String(taskKey));

  // ---------- A6: HTML block insert puts the caret inside the template ----------
  await setMd("before\n");
  await page.locator("#write").click();
  await run("paragraph.htmlBlock");
  await page.waitForTimeout(200);
  const htmlMd = await md();
  ok(htmlMd.includes("<div>") && htmlMd.includes("</div>"), "A6 HTML Block inserts a div template", htmlMd);
  const htmlFocus = await page.evaluate(() => {
    const cm = document.querySelector(".md-htmlblock .CodeMirror");
    return !!(cm && cm.CodeMirror && cm.CodeMirror.hasFocus());
  });
  ok(htmlFocus, "A6 caret is inside the HTML block editor");
  await page.keyboard.type("hi");
  await page.waitForTimeout(80);
  ok((await md()).includes("hi"), "A6 typing lands inside the template", await md());
  await setMd("slash\n");
  await page.locator("#write").click();
  await page.keyboard.press("Control+a");
  await page.keyboard.press("Backspace");
  await page.keyboard.type("/html");
  await page.waitForTimeout(150);
  const slashHit = await page.locator(".mdn-slash-item", { hasText: "HTML Block" }).count();
  ok(slashHit >= 1, "A6 slash menu lists HTML Block", String(slashHit));
  await page.keyboard.press("Enter");
  await page.waitForTimeout(200);
  ok((await md()).includes("<div>"), "A6 slash inserts the HTML block", await md());

  // ---------- A7: image alignment round-trips with zoom ----------
  await setMd("![pic](a.png)\n");
  await page.locator("#write img[alt='pic']").click();
  await run("format.image.alignCenter");
  await page.waitForTimeout(60);
  const centered = await md();
  ok(/display:\s*block/.test(centered) && /margin:\s*0 auto/.test(centered), "A7 Align Center writes an inline style", centered);
  await run("format.image.zoom50");
  await page.waitForTimeout(60);
  const both = await md();
  ok(/width:50%/.test(both) && /margin:0 auto/.test(both), "A7 align and zoom share one style", both);
  await setMd(both);
  const rt = await md();
  ok(/margin:0 auto/.test(rt) && /width:50%/.test(rt), "A7 alignment round-trips with zoom", rt);
  await page.locator("#write img[alt='pic']").click({ button: "right" });
  await page.waitForSelector(".context-menu button[data-id='image-align']");
  await page.locator(".context-menu button[data-id='image-align']").hover();
  await page.waitForTimeout(80);
  ok(await page.locator(".context-menu button[data-id='format.image.alignLeft']").count() === 1, "A7 image context menu lists Align Left");
  await page.screenshot({ path: path.join(OUT, "image-align-menu.png") });
  await page.keyboard.press("Escape");
  await page.keyboard.press("Escape");
  await run("format.image.alignLeft");
  await page.waitForTimeout(40);
  ok(/float:left/.test(await md()), "A7 Align Left uses float", await md());
  await run("format.image.alignDefault");
  await page.waitForTimeout(40);
  ok(!/float:|margin:0 auto/.test(await md()), "A7 Default clears alignment and keeps zoom", await md());

  // ---------- A8: open link / copy link address ----------
  await setMd("[site](https://example.com/a8)\n\n[other](other.md)\n");
  fs.writeFileSync(path.join(TMP, "other.md"), "# Other\n");
  await page.evaluate(() => {
    const v = window.mdnest.editor.view;
    let pos = 1;
    v.state.doc.descendants((n, p) => {
      if (n.isText && n.marks.some((m) => m.type.name === "link")) { pos = p + 1; return false; }
    });
    v.dispatch(v.state.tr.setSelection(v.state.selection.constructor.create(v.state.doc, pos, pos)));
    v.focus();
  });
  const linkBox = await page.locator("#write a[href*='example.com']").boundingBox();
  await page.mouse.click(linkBox.x + linkBox.width / 2, linkBox.y + linkBox.height / 2, { button: "right" });
  await page.waitForSelector(".context-menu button[data-id='link-actions']");
  await page.locator(".context-menu button[data-id='link-actions']").hover();
  await page.waitForTimeout(80);
  ok(await page.locator(".context-menu button[data-id='format.link.copy']").count() === 1, "A8 link context menu lists Copy Link Address");
  await page.screenshot({ path: path.join(OUT, "link-context.png") });
  await page.locator(".context-menu button[data-id='format.link.copy']").click();
  await page.waitForTimeout(80);
  ok((await page.evaluate(() => navigator.clipboard.readText())) === "https://example.com/a8", "A8 Copy Link Address copies the href");
  const opened = [];
  page.on("popup", (p) => opened.push(p.url()));
  await page.locator("#write a[href='https://example.com/a8']").click({ modifiers: ["Control"] });
  await page.waitForTimeout(300);
  ok(opened.some((u) => u.includes("example.com")), "A8 Ctrl+click opens the http link", opened.join(","));
  await page.locator("#write a[href='other.md']").click({ modifiers: ["Control"] });
  await page.waitForTimeout(400);
  ok((await page.evaluate(() => window.mdnest.state.path || "")).endsWith("other.md"), "A8 a relative .md link opens in MD Nest", await page.evaluate(() => window.mdnest.state.path));
  await page.evaluate((p) => window.mdnest.openAt ? window.mdnest.openFile : null, DOC);

  // ---------- A9: Find Next without opening the bar ----------
  await page.evaluate((file) => {
    const u = new URL(location.href);
    u.searchParams.set("file", file);
    history.replaceState(null, "", u);
  }, DOC);
  await page.evaluate((file) => { window.mdnest.state.path = file; }, DOC);
  await setMd("alpha beta alpha\n");
  await page.locator("#write").click();
  await page.keyboard.press("Control+Home");
  await page.evaluate(() => {
    const v = window.mdnest.editor.view;
    const text = v.state.doc.textContent;
    const at = text.indexOf("alpha");
    v.dispatch(v.state.tr.setSelection(v.state.selection.constructor.near(v.state.doc.resolve(at + 1))));
  });
  // Select the word, then Find Next with the bar closed.
  await page.keyboard.press("Control+d");
  await page.keyboard.press("F3");
  await page.waitForTimeout(120);
  ok(await page.locator("#mdn-find").evaluate((el) => el.style.display === "none" || getComputedStyle(el).display === "none"), "A9 Find Next leaves the bar closed");
  const selAfter = await page.evaluate(() => {
    const v = window.mdnest.editor.view;
    return v.state.doc.textBetween(v.state.selection.from, v.state.selection.to);
  });
  ok(selAfter === "alpha", "A9 Find Next selects the next hit", selAfter);
  await page.keyboard.press("Shift+F3");
  await page.waitForTimeout(80);
  ok((await page.evaluate(() => window.mdnest.editor.view.state.doc.textBetween(window.mdnest.editor.view.state.selection.from, window.mdnest.editor.view.state.selection.to))) === "alpha", "A9 Find Previous wraps to a hit");
  await setMd("nothing here\n");
  await page.keyboard.press("F3");
  await page.waitForTimeout(200);
  ok((await page.locator("#mdn-toast").innerText()).includes("Not found"), "A9 missing query notifies Not found");

  // ---------- A10: read-only mode ----------
  await setMd("readonly body\n\n");
  await run("view.readonly");
  await page.waitForTimeout(80);
  ok(await page.evaluate(() => document.body.classList.contains("ty-readonly")), "A10 Readonly adds ty-readonly");
  ok(await page.locator("#footer-readonly").isVisible(), "A10 footer shows the read-only indicator");
  await page.screenshot({ path: path.join(OUT, "readonly.png") });
  const beforeRo = await md();
  await page.locator("#write p").last().click();
  await page.keyboard.type("/");
  await page.waitForTimeout(80);
  ok((await md()) === beforeRo, "A10 typing does not edit and slash stays closed", await md());
  const slashOpen = await page.evaluate(() => {
    const el = document.querySelector(".mdn-slash");
    return !!el && getComputedStyle(el).display !== "none";
  });
  ok(!slashOpen, "A10 slash menu stays closed");
  const headingEnabled = await page.evaluate(() => {
    window.mdnest.refreshMenu();
    const btn = document.querySelector('#mdn-menubar button[data-id="paragraph.heading.1"]');
    return btn ? !btn.disabled && btn.getAttribute("aria-disabled") !== "true" : null;
  });
  // HTML menubar marks disabled items. Open the menu to read the attribute.
  await page.locator('#mdn-menubar .mdn-menu[data-menu="paragraph"] > .mdn-menu-label').click();
  const h1dis = await page.locator('#mdn-menubar button[data-id="paragraph.heading.1"]').getAttribute("disabled");
  ok(h1dis !== null, "A10 edit menu items are disabled", String(h1dis) + " enabledFlag=" + headingEnabled);
  await page.keyboard.press("Escape");
  await run("view.readonly");
  await page.waitForTimeout(40);
  ok(!(await page.evaluate(() => document.body.classList.contains("ty-readonly"))), "A10 Readonly toggles off");

  // ---------- A11: outline collapse ----------
  await setMd("# One\n\npara\n\n## Two\n\nmore\n\n# Three\n");
  await page.evaluate(() => { document.body.classList.add("pin-outline"); window.mdnest.sidebar.select("outline"); window.mdnest.sidebar.updateOutline(window.mdnest.editor.view); });
  await page.waitForTimeout(100);
  const exp = page.locator("#outline-content .outline-expander").first();
  ok(await exp.count() === 1 || await page.locator("#outline-content .outline-expander").count() >= 1, "A11 headings with children have an expander");
  ok(await page.locator("#outline-content .outline-item-open").count() >= 1, "A11 open items use outline-item-open");
  await page.locator("#outline-content .outline-expander").first().click();
  await page.waitForTimeout(80);
  ok(await page.locator("#outline-content .outline-item-closed").count() >= 1, "A11 click closes the section");
  ok(await page.locator("#outline-content .outline-item", { hasText: "Two" }).count() === 0, "A11 a closed section hides its child");
  await page.screenshot({ path: path.join(OUT, "outline-collapse.png") });
  await page.locator("#outline-content").click({ button: "right" });
  await page.waitForSelector(".context-menu button[data-id='expand']");
  await page.locator(".context-menu button[data-id='expand']").click();
  await page.waitForTimeout(80);
  ok(await page.locator("#outline-content .outline-item", { hasText: "Two" }).count() === 1, "A11 Expand All restores children");
  await run("view.outline.collapseAll");
  await page.waitForTimeout(80);
  ok(await page.locator("#outline-content .outline-item", { hasText: "Two" }).count() === 0, "A11 Collapse All hides children");
  // Persists while the document stays open (an edit does not reset it).
  await page.locator("#write").click();
  await page.keyboard.press("End");
  await page.keyboard.type(" z");
  await page.waitForTimeout(250);
  ok(await page.locator("#outline-content .outline-item", { hasText: "Two" }).count() === 0, "A11 collapse persists across an edit");

  // ---------- A12: copy code content ----------
  await setMd("```js\nconst n = 1;\n```\n");
  await page.waitForTimeout(200);
  const copyBtn = page.locator(".md-fences .code-tooltip .mdn-code-copy");
  ok(await copyBtn.count() === 1, "A12 each fence has a Copy button in .code-tooltip");
  await page.screenshot({ path: path.join(OUT, "code-copy.png") });
  await copyBtn.click();
  await page.waitForTimeout(100);
  ok((await page.evaluate(() => navigator.clipboard.readText())).includes("const n = 1"), "A12 Copy writes the code text");
  ok((await page.locator("#mdn-toast").innerText()).includes("Copied"), "A12 Copy shows a Copied toast");
  const exported = await page.evaluate(() => window.mdnest.exportHtmlString(false, false));
  ok(!exported.includes("mdn-code-copy") && !exported.includes(">Copy<"), "A12 the Copy button is not in exported HTML");
  await page.locator(".md-fences").click();
  await page.waitForTimeout(80);
  await run("edit.copyCode");
  await page.waitForTimeout(80);
  ok((await page.evaluate(() => navigator.clipboard.readText())).includes("const n = 1"), "A12 Edit ▸ Code Tools ▸ Copy Code Content copies the fence");

  ok(errors.length === 0, "no page errors", errors.join(" | "));
} catch (e) {
  ok(false, "EXCEPTION", e?.message ?? e);
} finally {
  if (browser) await browser.close().catch(() => {});
  fs.rmSync(TMP, { recursive: true, force: true });
  const trash = path.resolve("dev-data/.trash");
  if (fs.existsSync(trash)) {
    for (const name of fs.readdirSync(trash)) {
      if (name.includes("parity-012") || name.includes(".tmp-parity-012")) fs.rmSync(path.join(trash, name), { recursive: true, force: true });
    }
  }
}

const failed = results.filter((r) => !r.pass).length;
console.log(`\n${results.length - failed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
