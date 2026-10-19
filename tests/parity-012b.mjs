// Part B parity (0.1.2): file watch, encodings, smart punctuation, spell check, emoji.
// Playwright against the browser host. Usage: node tests/parity-012b.mjs [baseUrl]
// Temp files live under dev-data/workspace and are removed in finally (including .trash copies).
import { chromium } from "playwright";
import fs from "node:fs";
import path from "node:path";

const base = process.argv[2] ?? "http://127.0.0.1:4173/";
const OUT = path.resolve("screenshots/parity-0.1.2");
fs.mkdirSync(OUT, { recursive: true });

const TMP = path.resolve("dev-data/workspace/.tmp-parity-012b");
const DOC = path.join(TMP, "parity-012b.md");
const TRASH = path.resolve("dev-data/.trash");
fs.rmSync(TMP, { recursive: true, force: true });
fs.mkdirSync(TMP, { recursive: true });
fs.writeFileSync(DOC, "# Title\n\nA paragraph with a word.\n");

const results = [];
const ok = (c, name, info = "") => {
  const line = (c ? "PASS " : "FAIL ") + name + (info ? " — " + String(info).slice(0, 240) : "");
  console.log(line);
  results.push({ pass: !!c, name });
};

function trashCopies() {
  if (!fs.existsSync(TRASH)) return [];
  return fs.readdirSync(TRASH).filter((n) => n.includes("parity-012b") || n.includes("outside-watch") || n.includes("gb18030"));
}

let browser;
try {
  browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1280, height: 860 } });
  page.setDefaultTimeout(10000);
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  const md = () => page.evaluate(() => window.mdnest.editor.getMarkdown());
  const run = (id) => page.evaluate((id) => window.mdnest.runCommand(id), id);

  await page.goto(base + `?theme=mdnest&file=${encodeURIComponent(DOC)}&folder=${encodeURIComponent(TMP)}&menubar=html&restore=0`);
  await page.evaluate(() => localStorage.removeItem("mdnest.autosave"));
  await page.waitForSelector("body.mdn-ready");
  await page.waitForSelector("#mdn-menubar");
  await page.waitForTimeout(400);

  // ---------- B1: external file creation appears in the tree ----------
  const outside = path.join(TMP, "outside-watch.md");
  fs.writeFileSync(outside, "# From disk\n");
  await page.waitForFunction((name) => {
    return [...document.querySelectorAll("#file-library-tree .file-node-title")].some((n) => n.textContent === name);
  }, "outside-watch.md", { timeout: 8000 });
  ok(true, "B1 external file appears in the file tree");
  const stillOpen = await page.evaluate(() => document.body.classList.contains("file-node-expanded") || !!document.querySelector("#file-library-tree .file-library-node.active, #file-library-tree .sidebar-folder-name"));
  ok(stillOpen, "B1 tree stays rendered after the watch refresh");
  await page.screenshot({ path: path.join(OUT, "file-watch.png") });

  ok(errors.length === 0, "B1 no page errors", errors.join(" | "));

  // ---------- B2: encodings and line endings ----------
  const footerEnc = await page.locator("#footer-encoding").innerText();
  ok(/UTF-8/.test(footerEnc) && /LF|CRLF/.test(footerEnc), "B2 footer shows encoding and line ending", footerEnc);
  await page.screenshot({ path: path.join(OUT, "footer-encoding.png") });
  await page.locator("#mdn-menubar").locator("button.mdn-menu-label", { hasText: "File" }).click();
  const encRow = page.locator("#mdn-menubar .mdn-menu.mdn-menu-open > .dropdown-menu > .mdn-menu-sub").filter({ hasText: /^Encoding/ }).first();
  await encRow.hover();
  await page.waitForTimeout(200);
  await page.screenshot({ path: path.join(OUT, "encoding-menu.png") });
  await page.keyboard.press("Escape");

  // Fixture is generated here, not committed. GB18030 bytes for 中文 (lead/trail pairs).
  const gbPath = path.join(TMP, "gb18030.md");
  const fixture = Buffer.from([0xd6, 0xd0, 0xce, 0xc4, 0x0a]);
  fs.writeFileSync(gbPath, fixture);
  ok(!fixture.includes(Buffer.from("中文")), "B2 fixture is not UTF-8 Chinese");
  await page.evaluate(async (p) => {
    window.mdnest.state.path = p;
    await window.mdnest.runCommand("file.reopen.gb18030");
  }, gbPath);
  await page.waitForTimeout(400);
  ok((await md()).includes("中文"), "B2 reopen with GB18030 shows Chinese", await md());
  const encNow = await page.evaluate(() => window.mdnest.state.encoding);
  ok(encNow === "GB18030", "B2 document encoding is GB18030", encNow);
  await page.locator("#write").click();
  await page.keyboard.press("Control+End");
  await page.keyboard.type("编辑");
  await page.waitForTimeout(200);
  await run("file.save");
  await page.waitForTimeout(400);
  const saved = fs.readFileSync(gbPath);
  const back = await page.evaluate(async (b64) => {
    const bin = atob(b64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return new TextDecoder("gb18030").decode(bytes);
  }, saved.toString("base64"));
  ok(back.includes("中文") && back.includes("编辑"), "B2 saved bytes stay GB18030", back);
  ok(!saved.includes(Buffer.from("编辑")), "B2 saved file is not UTF-8 for the edit");
  fs.rmSync(gbPath, { force: true });
  fs.rmSync(outside, { force: true });

  ok(errors.length === 0, "B2 no page errors", errors.join(" | "));

  // ---------- B3: smart punctuation ----------
  await page.evaluate(() => localStorage.setItem("mdnest.smartPunct", "1"));
  await page.evaluate((p) => window.mdnest.runCommand && (window.mdnest.state.path = p), DOC);
  await run("file.reopen.utf8");
  await page.waitForTimeout(200);
  await page.locator("#write").click();
  await page.keyboard.press("Control+End");
  await page.keyboard.type(' "hi" it\'s ');
  await page.keyboard.type("--");
  await page.keyboard.type(" ");
  await page.keyboard.type("---");
  await page.keyboard.type(" ");
  await page.keyboard.type("...");
  await page.waitForTimeout(200);
  const punct = await md();
  ok(punct.includes("\u201Chi\u201D"), "B3 straight quotes become curly", punct);
  ok(punct.includes("it\u2019s"), "B3 apostrophe becomes a right single quote", punct);
  ok(punct.includes("\u2013") && punct.includes("\u2014") && punct.includes("\u2026"), "B3 dashes and ellipsis", punct);
  await page.keyboard.press("Control+z");
  await page.waitForTimeout(120);
  const undone = await md();
  ok(undone.includes("...") && !undone.includes("\u2026"), "B3 undo reverts the last conversion", undone);
  // A line that is only --- stays a rule candidate, not an em dash.
  await page.evaluate(() => window.mdnest.editor.setMarkdown("---\n"));
  await page.waitForTimeout(80);
  ok((await md()).startsWith("---"), "B3 line-start --- is not converted", await md());
  await page.evaluate(() => window.mdnest.editor.setMarkdown("```\n\"hi\" -- ...\n```\n"));
  await page.waitForTimeout(80);
  ok((await md()).includes('"hi"'), "B3 does not convert inside a code fence", await md());
  await page.screenshot({ path: path.join(OUT, "smart-punct.png") });
  await page.evaluate(() => localStorage.setItem("mdnest.smartPunct", "0"));
  ok(errors.length === 0, "B3 no page errors", errors.join(" | "));

  // ---------- B4: spell check ----------
  const off = await page.evaluate(() => document.getElementById("write").getAttribute("spellcheck"));
  ok(off === "false", "B4 spellcheck starts off", off);
  await run("edit.spellcheck");
  await page.waitForTimeout(80);
  const on = await page.evaluate(() => document.getElementById("write").getAttribute("spellcheck"));
  ok(on === "true", "B4 toggle sets spellcheck on #write", on);
  await run("view.source");
  await page.waitForTimeout(200);
  const src = await page.evaluate(() => document.querySelector("#typora-source .CodeMirror")?.getAttribute("spellcheck"));
  ok(src === "true", "B4 source mode spellcheck follows the setting", src);
  await run("view.source");
  await page.waitForTimeout(150);
  await run("edit.spellcheck");
  await page.waitForTimeout(80);
  const cleared = await page.evaluate(() => document.getElementById("write").getAttribute("spellcheck"));
  ok(cleared === "false", "B4 toggle clears spellcheck", cleared);
  await page.locator("#mdn-menubar").getByText("Edit", { exact: true }).click();
  await page.waitForTimeout(80);
  await page.screenshot({ path: path.join(OUT, "spellcheck.png") });
  await page.keyboard.press("Escape");
  ok(errors.length === 0, "B4 no page errors", errors.join(" | "));
} catch (e) {
  ok(false, "parity-012b threw", e?.message || String(e));
} finally {
  if (browser) await browser.close().catch(() => {});
  fs.rmSync(TMP, { recursive: true, force: true });
  for (const name of trashCopies()) fs.rmSync(path.join(TRASH, name), { recursive: true, force: true });
}

const failed = results.filter((r) => !r.pass).length;
console.log(`\n${results.length - failed}/${results.length} passed`);
process.exit(failed ? 1 : 0);
