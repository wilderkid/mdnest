// Part 3: slash menu, input rules, editing shortcuts, toolbar, context menu, table dialog.
// Usage: node tests/parity-insert.mjs [baseUrl]
import { chromium } from "playwright";
import fs from "node:fs";
import path from "node:path";

const base = process.argv[2] ?? "http://127.0.0.1:4173/";
const WS = path.resolve("dev-data/workspace");
const OUT = path.resolve("screenshots/parity");
fs.mkdirSync(OUT, { recursive: true });
const DOC = path.join(WS, "parity-insert.md");
fs.writeFileSync(DOC, "# Insert\n\nA paragraph.\n");

const results = [];
const ok = (c, name, info = "") => {
  const line = (c ? "PASS " : "FAIL ") + name + (info ? " — " + String(info).slice(0, 200) : "");
  console.log(line);
  results.push({ pass: !!c, name });
};

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1280, height: 860 } });
page.setDefaultTimeout(8000);
const errors = [];
page.on("pageerror", (e) => errors.push(e.message));
const md = () => page.evaluate(() => window.mdnest.editor.getMarkdown());
const setMd = (text) => page.evaluate((t) => window.mdnest.editor.setMarkdown(t), text);
const run = (id) => page.evaluate((i) => window.mdnest.runCommand(i), id);

await page.goto(base + `?theme=mdnest&file=${encodeURIComponent(DOC)}&folder=${encodeURIComponent(WS)}&menubar=html`);
await page.evaluate(() => localStorage.removeItem("mdnest.autosave"));
await page.waitForSelector("body.mdn-ready");
await page.waitForTimeout(300);
await page.context().grantPermissions(["clipboard-read", "clipboard-write"]);

async function typeSlash(query) {
  await setMd("\n");
  await page.locator("#write").click();
  await page.keyboard.press("Control+End");
  await page.keyboard.type("/");
  if (query) await page.keyboard.type(query);
  await page.waitForTimeout(80);
}

// Slash menu screenshots
await typeSlash("");
await page.waitForSelector(".mdn-slash");
await page.screenshot({ path: path.join(OUT, "slash-menu.png") });
const titles = await page.locator(".mdn-slash-item").allTextContents();
ok(titles.some((t) => t.includes("Heading 1")) && titles.some((t) => t.includes("Task List")) && titles.some((t) => t.includes("Front Matter")), "slash menu lists core items", titles.slice(0, 4).join("|"));
await page.keyboard.type("head");
await page.waitForTimeout(80);
await page.screenshot({ path: path.join(OUT, "slash-menu-filtered.png") });
const filtered = await page.locator(".mdn-slash-item").allTextContents();
ok(filtered.length > 0 && filtered.every((t) => /head/i.test(t)), "slash filter keeps headings", filtered.join("|"));
await page.keyboard.press("Escape");

const slashCases = [
  ["Heading 1", "# ", "Title"],
  ["Bullet List", "- ", "item"],
  ["Numbered List", "1. ", "item"],
  ["Task List", "- [ ]", ""],
  ["Quote", "> ", "said"],
  ["Code Block", "```", ""],
  ["Math Block", "$$", ""],
  ["Mermaid Diagram", "mermaid", ""],
  ["Horizontal Line", "---", ""],
  ["Table of Contents", "[TOC]", ""],
  ["Footnote", "[^", ""],
  ["Front Matter", "---\n", ""],
  ["Callout/Alert", "[!NOTE]", ""],
];
for (const [title, expect, typed] of slashCases) {
  await typeSlash("");
  await page.waitForSelector(".mdn-slash");
  const item = page.locator(".mdn-slash-item", { hasText: title }).first();
  if (await item.count()) await item.click();
  else { await page.keyboard.press("Escape"); ok(false, "slash " + title, "missing"); continue; }
  await page.waitForTimeout(80);
  if (typed) await page.keyboard.type(typed);
  await page.waitForTimeout(80);
  const text = await md();
  ok(text.includes(expect), "slash " + title + " → markdown", text.slice(0, 80).replace(/\n/g, "\\n"));
}

// Input rules
await setMd("\n");
await page.locator("#write").click();
await page.keyboard.type("[ ] ");
await page.waitForTimeout(80);
ok(/- \[ \]/.test(await md()), "input [ ] + space → task", await md());

await setMd("\n");
await page.locator("#write").click();
await page.keyboard.type("```js");
await page.keyboard.press("Enter");
await page.waitForTimeout(80);
ok(/```js/.test(await md()), "input ```lang + Enter → fence", await md());

await setMd("para\n");
await page.locator("#write").click();
await page.keyboard.press("Control+End");
await page.keyboard.press("Enter");
await page.keyboard.type("---");
await page.keyboard.press("Enter");
await page.waitForTimeout(80);
ok((await md()).includes("\n---\n") && !(await md()).startsWith("---\n"), "--- + Enter elsewhere is a rule", await md());

await setMd("\n");
await page.locator("#write").click();
await page.keyboard.type("---");
await page.keyboard.press("Enter");
await page.waitForTimeout(80);
ok((await md()).startsWith("---\n"), "--- + Enter on first line → front matter", await md());

await setMd("\n");
await page.locator("#write").click();
await page.keyboard.type("[TOC]");
await page.keyboard.press("Enter");
await page.waitForTimeout(80);
ok((await md()).includes("[TOC]"), "input [TOC] + Enter", await md());

await setMd("\n");
await page.locator("#write").click();
await page.keyboard.type("| a | b |");
await page.keyboard.press("Enter");
await page.waitForTimeout(80);
ok((await md()).includes("| a | b |") && (await md()).includes("|---|---|"), "input | a | b | + Enter → table", await md());

await setMd("\n");
await page.locator("#write").click();
await page.keyboard.type("<u>x</u> ");
await page.waitForTimeout(80);
ok((await md()).includes("<u>x</u>"), "input <u>x</u>", await md());

// Shortcuts
await setMd("word\n");
await page.locator("#write").click();
await page.keyboard.press("Control+A");
await page.keyboard.press("Control+u");
await page.waitForTimeout(80);
ok((await md()).includes("<u>word</u>"), "Ctrl+U underline", await md());

await setMd("linkme\n");
await page.locator("#write").click();
await page.evaluate(() => localStorage.setItem("mdnest.plugin.ai.enabled", "0"));
await page.keyboard.press("Control+A");
page.once("dialog", (d) => d.accept("https://example.com"));
// openPrompt is not window.prompt — drive the command and the floating input
await run("format.link");
await page.waitForSelector(".mdn-prompt input");
await page.locator(".mdn-prompt input").fill("https://example.com");
await page.keyboard.press("Enter");
await page.waitForTimeout(100);
ok((await md()).includes("[linkme](https://example.com)") || (await md()).includes("](https://example.com)"), "Ctrl+K / hyperlink wraps selection", await md());

await setMd("Hello\n");
await page.locator("#write").click();
await page.keyboard.press("Control+Equal");
await page.waitForTimeout(80);
ok((await md()).startsWith("###### Hello"), "Ctrl+= paragraph becomes h6 (Typora order)", await md());
await page.keyboard.press("Control+Equal");
await page.waitForTimeout(80);
ok((await md()).startsWith("##### Hello"), "Ctrl+= h6 → h5", await md());
await page.keyboard.press("Control+Minus");
await page.keyboard.press("Control+Minus");
await page.waitForTimeout(80);
ok((await md()).startsWith("Hello") && !(await md()).startsWith("#"), "Ctrl+- h5 → h6 → paragraph", await md());
await setMd("# Top\n");
await page.locator("#write").click();
await page.keyboard.press("Control+Minus");
await page.waitForTimeout(80);
ok((await md()).startsWith("## Top"), "Ctrl+- h1 → h2", await md());

await setMd("item\n");
await page.locator("#write").click();
await page.keyboard.press("Control+Shift+X");
await page.waitForTimeout(80);
ok(/- \[ \]/.test(await md()), "Ctrl+Shift+X task list", await md());

await setMd("math here\n");
await page.locator("#write").click();
await page.keyboard.press("Control+Shift+M");
await page.waitForTimeout(80);
ok((await md()).includes("$$"), "Ctrl+Shift+M math block", await md());

await setMd("**bold** text\n");
await page.locator("#write").click();
await page.keyboard.press("Control+A");
await page.keyboard.press("Control+Backslash");
await page.waitForTimeout(80);
ok(!(await md()).includes("**"), "Ctrl+\\ clear format", await md());

await setMd("alpha beta\n");
await page.locator("#write").click();
await page.keyboard.press("End");
await page.keyboard.press("Control+Home");
await page.keyboard.press("Control+D");
await page.waitForTimeout(50);
const word = await page.evaluate(() => {
  const s = window.mdnest.editor.view.state.selection;
  return window.mdnest.editor.view.state.doc.textBetween(s.from, s.to);
});
ok(word === "alpha", "Ctrl+D select word", word);

await setMd("line of text\n");
await page.locator("#write").click();
await page.keyboard.press("Control+L");
await page.waitForTimeout(50);
const line = await page.evaluate(() => {
  const s = window.mdnest.editor.view.state.selection;
  return window.mdnest.editor.view.state.doc.textBetween(s.from, s.to);
});
ok(line.includes("line of text"), "Ctrl+L select line", line);

await setMd("**styled** end\n");
await page.locator("#write").click();
await page.keyboard.press("Control+E");
await page.waitForTimeout(50);
const scope = await page.evaluate(() => {
  const s = window.mdnest.editor.view.state.selection;
  return s.to - s.from;
});
ok(scope > 0, "Ctrl+E select styled scope", String(scope));

await setMd("copy me\n");
await page.locator("#write").click();
await page.keyboard.press("Control+A");
await page.keyboard.press("Control+Shift+C");
await page.waitForTimeout(100);
const copied = await page.evaluate(() => navigator.clipboard.readText());
ok(copied.includes("copy me"), "Ctrl+Shift+C copies Markdown", copied);

await page.evaluate(() => navigator.clipboard.writeText("PLAIN"));
await setMd("x\n");
await page.locator("#write").click();
await page.keyboard.press("Control+Shift+V");
await page.waitForTimeout(120);
ok((await md()).includes("PLAIN"), "Ctrl+Shift+V pastes plain", await md());

await run("view.focus");
await page.waitForTimeout(50);
ok(await page.evaluate(() => document.body.classList.contains("on-focus-mode")), "F8 focus mode class");
await page.screenshot({ path: path.join(OUT, "focus-mode.png") });
await run("view.focus");
await run("view.typewriter");
ok(await page.evaluate(() => document.body.classList.contains("ty-on-typewriter-mode")), "F9 typewriter class");
await run("view.typewriter");

await run("view.zoomIn");
const zoom = await page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue("--zoom").trim());
ok(parseFloat(zoom) > 1, "zoom in persists --zoom", zoom);
await run("view.actualSize");

// Auto-pair
await page.evaluate(() => localStorage.setItem("mdnest.autoPair.brackets", "1"));
await setMd("\n");
await page.locator("#write").click();
await page.keyboard.type("(");
await page.waitForTimeout(40);
ok((await md()).includes("()"), "auto-pair inserts ()", await md());
await page.keyboard.press("Backspace");
await page.waitForTimeout(40);
ok(!(await md()).includes("()"), "backspace removes empty pair", await md());

// Toolbar
await page.evaluate(() => localStorage.setItem("mdnest.formatToolbar", "0"));
await run("view.toolbar");
await page.waitForSelector("#mdn-format-toolbar:not([hidden])");
await setMd("toolbar\n");
await page.locator("#write").click();
await page.keyboard.press("Control+A");
await page.locator("#mdn-format-toolbar button[data-cmd='format.strong']").click();
await page.waitForTimeout(80);
ok((await md()).includes("**toolbar**"), "toolbar strong", await md());
await page.locator("#write").click();
await page.keyboard.press("Control+a");
await page.waitForTimeout(80);
await page.waitForTimeout(80);
const active = await page.evaluate(() => document.querySelector("#mdn-format-toolbar button[data-cmd='format.strong']")?.classList.contains("active"));
ok(active, "toolbar strong active");
await page.screenshot({ path: path.join(OUT, "format-toolbar.png") });
await run("view.toolbar");

// Editor context menu
await setMd("menu text\n");
await page.locator("#write").click({ button: "right" });
await page.waitForSelector(".context-menu");
await page.screenshot({ path: path.join(OUT, "editor-context-menu.png") });
ok(await page.locator(".context-menu button", { hasText: "Copy as Markdown" }).count() === 1, "context menu copy as markdown");
await page.locator(".context-menu button", { hasText: "Format" }).click();
await page.waitForTimeout(80);
await page.screenshot({ path: path.join(OUT, "editor-context-menu-format.png") });
await page.locator(".context-menu button", { hasText: "Strong" }).last().click();
await page.waitForTimeout(80);

// Table dialog
await run("paragraph.tableDialog");
await page.waitForSelector("#table-insert-dialog");
await page.screenshot({ path: path.join(OUT, "table-dialog.png") });
await page.locator("#table-rows").fill("2");
await page.locator("#table-cols").fill("2");
await page.locator("#table-insert-dialog button", { hasText: "Insert" }).click();
await page.waitForTimeout(100);
ok((await md()).includes("|---|---|"), "table dialog inserts 2×2", await md());

// Word count popover + welcome re-shot
await page.locator("#footer-word-count").click();
await page.waitForSelector("#mdn-word-popover");
await page.screenshot({ path: path.join(OUT, "word-count-popover.png") });
ok((await page.locator("#mdn-word-popover").innerText()).includes("words"), "word count popover");

await page.goto(base + "?restore=0&theme=mdnest");
await page.waitForSelector("#mdn-welcome");
await page.waitForTimeout(200);
const words = await page.locator("#footer-word-count").innerText();
ok(words === "0 words", "welcome word count is 0", words);
const covered = await page.evaluate(() => {
  const w = document.querySelector("#mdn-welcome");
  const cs = getComputedStyle(w);
  return cs.backgroundColor !== "rgba(0, 0, 0, 0)" && w.getBoundingClientRect().width > 400;
});
ok(covered, "welcome covers content with a background");
await page.screenshot({ path: path.join(OUT, "welcome.png") });

await page.goto(base + `?theme=mdnest&file=${encodeURIComponent(DOC)}&folder=${encodeURIComponent(WS)}&menubar=html`);
await page.waitForSelector("body.mdn-ready");
await page.waitForTimeout(250);
await page.screenshot({ path: path.join(OUT, "file-tree-toolbar.png") });
const svg = await page.locator("#sidebar-footer button svg").count();
ok(svg >= 5, "sidebar footer uses svg icons", String(svg));
ok(await page.locator("#sidebar-sort-btn").innerText().then((t) => t.includes("Sort")), "sort button keeps Sort text");

ok(errors.length === 0, "no page errors", errors.join(" | "));
await browser.close();
fs.rmSync(DOC, { force: true }); fs.rmSync(path.resolve("dev-data/.trash"), { recursive: true, force: true });
const failed = results.filter((r) => !r.pass);
console.log(JSON.stringify({ passed: results.length - failed.length, failed: failed.length }, null, 1));
process.exit(failed.length ? 1 : 0);
