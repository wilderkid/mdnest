// 0.2.1 regression suite with REAL input: Playwright keyboard.type/press, real mouse clicks and CDP IME
// composition (Input.imeSetComposition → Input.insertText, what a Chinese IME produces in Chromium/WebView2).
// One section per user-reported bug. Needs `npx vite build` + `vite preview` on :4173.
// Run: node tests/real-input-021.mjs [base]
import fs from "node:fs";
import path from "node:path";
import { chromium } from "playwright";

const base = process.argv[2] ?? "http://127.0.0.1:4173/";
const ROOT = path.resolve(process.env.WS_ROOT ?? "dev-data/workspace");
const WS = path.join(ROOT, "real021-test");
let fail = 0, pass = 0;
const ok = (c, m, info = "") => { console.log((c ? "PASS " : "FAIL ") + m + (c || info === "" ? "" : " — " + String(typeof info === "string" ? info : JSON.stringify(info)).slice(0, 400))); c ? pass++ : fail++; };
fs.rmSync(WS, { recursive: true, force: true }); fs.mkdirSync(WS, { recursive: true });
const browser = await chromium.launch();
const errors = [];
async function open(file, text, { lang = "en", theme = "" } = {}) {
  fs.writeFileSync(path.join(WS, file), text);
  const ctx = await browser.newContext({ viewport: { width: 1200, height: 800 } });
  const page = await ctx.newPage();
  page.on("pageerror", (e) => errors.push(file + ": " + e.message));
  await page.goto(`${base}?lang=${lang}${theme ? "&theme=" + theme : ""}&folder=${encodeURIComponent(WS)}&file=${encodeURIComponent(path.join(WS, file))}`);
  await page.waitForSelector("body.mdn-ready", { timeout: 30000 });
  await page.waitForTimeout(400);
  page.md = () => page.evaluate(() => window.mdnest.editor.getMarkdown());
  page.ime = async (preedit, commit) => {
    const cdp = await ctx.newCDPSession(page);
    for (let i = 1; i <= preedit.length; i++) { await cdp.send("Input.imeSetComposition", { text: preedit.slice(0, i), selectionStart: i, selectionEnd: i }); await page.waitForTimeout(15); }
    await cdp.send("Input.insertText", { text: commit });
    await page.waitForTimeout(80);
  };
  return page;
}
/** click at the end of the last paragraph and start a new line */
async function newLine(page) { await page.locator("#write p").last().click(); await page.keyboard.press("End"); await page.keyboard.press("Enter"); }

// ---------- bug 2 + 6: heading marker ----------
{
  const page = await open("h.md", "# 标题一\n\nBody text\n");
  const h1 = page.locator("#write h1");
  ok(!(await h1.textContent()).includes("#"), "bug6: freshly opened file shows no '#' marker", await h1.textContent());
  await page.waitForTimeout(300);
  ok(!(await h1.textContent()).includes("#"), "bug6: still hidden after load settles (no focus yet)");
  await h1.click(); await page.waitForTimeout(150);
  ok((await h1.textContent()).startsWith("# "), "bug2: caret in heading reveals '# '", await h1.textContent());
  await page.keyboard.press("Home"); await page.keyboard.type("#"); await page.waitForTimeout(100);
  ok(await page.locator("#write h2").count() === 1, "bug2: typing '#' in the marker makes it H2");
  await page.keyboard.press("Home"); await page.keyboard.press("Delete"); await page.keyboard.press("Delete"); await page.waitForTimeout(100);
  const md = await page.md();
  ok(md.startsWith("标题一") || md.startsWith(" 标题一"), "bug2: deleting the marker turns it into a paragraph", md);
  await page.keyboard.press("Control+z"); await page.keyboard.press("Control+z"); await page.waitForTimeout(100);
  // back to a heading, then IME typing inside it
  await page.locator("#write").press("Control+Home");
  await page.keyboard.press("Control+End"); await page.keyboard.press("Enter");
  await page.keyboard.type("## ");
  await page.ime("biaoti", "标题二");
  await page.locator("#write p").first().click(); await page.waitForTimeout(150);
  const md2 = await page.md();
  ok(/^## 标题二$/m.test(md2) && !/###|# #/.test(md2), "bug2/IME: '## ' + IME 标题二 → H2, marker clean after leaving", md2);
  ok(!(await page.locator("#write h2").textContent()).includes("#"), "bug2: marker hidden again when the caret leaves");
  await page.context().close();
}

// ---------- bug 4: code block typing + language picker ----------
{
  const page = await open("c.md", "Intro\n");
  await newLine(page);
  await page.keyboard.type("```"); await page.keyboard.press("Enter"); await page.waitForTimeout(200);
  await page.keyboard.type("let x = 1;"); await page.keyboard.press("Enter"); await page.keyboard.type("x += 2;");
  await page.waitForTimeout(150);
  ok(/```\nlet x = 1;\nx \+= 2;\n```/.test(await page.md()), "bug4: typing into a new code block", await page.md());
  await page.ime("zhushi", "// 注释");
  ok((await page.md()).includes("x += 2;// 注释"), "bug4/IME: composition commits into the code block", await page.md());
  // shortcuts that used to be swallowed by the app dispatcher
  await page.keyboard.press("Control+Home"); await page.keyboard.type("A");
  ok((await page.md()).includes("```\nAlet x"), "bug4: Ctrl+Home stays inside CodeMirror", await page.md());
  // language picker
  const inp = page.locator("#write .md-fences .ty-cm-lang-input");
  await page.locator("#write .md-fences").hover();
  await inp.click(); await page.waitForTimeout(100);
  ok(await page.locator(".mdn-lang-menu .mdn-lang-item").count() > 3, "bug4: focusing the language input opens suggestions");
  await page.keyboard.type("py"); await page.waitForTimeout(100);
  const first = await page.locator(".mdn-lang-menu .mdn-lang-item.sel").getAttribute("data-lang");
  ok(first === "python", "bug4: 'py' suggests python first", first);
  await page.keyboard.press("Enter"); await page.waitForTimeout(150);
  ok((await page.md()).includes("```python\n"), "bug4: Enter applies the language", await page.md());
  await page.keyboard.type("Z"); await page.waitForTimeout(100);
  ok(/Z/.test((await page.md()).split("```python\n")[1] ?? ""), "bug4: focus returns to the code after choosing", await page.md());
  await page.locator("#write .md-fences").hover(); await inp.click(); await page.keyboard.type("type");
  await page.keyboard.press("ArrowDown"); await page.keyboard.press("ArrowUp"); await page.keyboard.press("Tab"); await page.waitForTimeout(150);
  ok((await page.md()).includes("```typescript\n"), "bug4: arrows + Tab pick a suggestion", (await page.md()).slice(0, 80));
  await page.locator("#write .md-fences").hover(); await inp.click(); await page.keyboard.press("Escape"); await page.waitForTimeout(100);
  ok((await page.md()).includes("```typescript\n") && !(await page.locator(".mdn-lang-menu").count()), "bug4: Esc cancels without changing");
  // Ctrl+Enter leaves the block
  await page.keyboard.press("Control+Enter"); await page.keyboard.type("after");
  ok(/```\n\nafter/.test(await page.md()), "bug4: Ctrl+Enter leaves the code block", await page.md());
  await page.context().close();
}

// ---------- bug 5: math block ----------
{
  const page = await open("m.md", "Intro\n");
  await newLine(page);
  await page.keyboard.type("$$"); await page.keyboard.press("Enter"); await page.waitForTimeout(200);
  await page.keyboard.type("E = mc^2"); await page.waitForTimeout(100);
  ok(/\$\$\nE = mc\^2\n\$\$/.test(await page.md()), "bug5: typing into a new math block", await page.md());
  await page.ime("jia", " + 甲");
  ok((await page.md()).includes("E = mc^2 + 甲"), "bug5/IME: composition in the math block", await page.md());
  await page.waitForTimeout(500);
  ok(await page.locator("#write .md-math-block .katex, #write .md-math-block mjx-container, #write .md-math-block svg").count() > 0, "bug5: preview renders");
  await page.keyboard.press("Control+Enter"); await page.keyboard.type("next");
  ok(/\$\$\n\nnext/.test(await page.md()), "bug5: Ctrl+Enter leaves the math block", await page.md());
  await page.context().close();
}

// ---------- bug 7: mermaid ----------
{
  const page = await open("g.md", "Intro\n");
  await newLine(page);
  await page.keyboard.type("```mermaid"); await page.keyboard.press("Enter"); await page.waitForTimeout(200);
  await page.keyboard.type("graph TD"); await page.keyboard.press("Enter"); await page.keyboard.type("A-->B");
  await page.waitForTimeout(100);
  ok(/```mermaid\ngraph TD\nA-->B\n```/.test(await page.md()), "bug7: typing into a mermaid block", await page.md());
  await page.keyboard.press("Enter"); await page.ime("kaishi", "B-->开始");
  ok((await page.md()).includes("B-->开始"), "bug7/IME: composition in the mermaid block", await page.md());
  await page.waitForTimeout(1500);
  ok(await page.locator("#write .md-diagram-panel svg").count() > 0, "bug7: diagram preview renders");
  await page.context().close();
}

// ---------- bug 8: HTML block ----------
{
  const page = await open("x.md", "Intro\n\n<div align=\"center\">\n  <b>Bold</b> text\n</div>\n\nEnd\n");
  const blk = page.locator("#write .md-htmlblock");
  ok(!(await blk.locator(".md-htmlblock-editor").isVisible()) && await blk.locator(".md-htmlblock-container b").isVisible(), "bug8: rendered preview, source hidden when not editing");
  await blk.locator(".md-htmlblock-container").click(); await page.waitForTimeout(200);
  ok(await blk.locator(".md-htmlblock-editor").isVisible() && !(await blk.locator(".md-htmlblock-container").isVisible()), "bug8: clicking the preview shows the source");
  await page.keyboard.press("Control+End"); await page.keyboard.press("ArrowUp"); await page.keyboard.press("End");
  await page.keyboard.type(" more");
  await page.ime("zhongwen", " 中文");
  const a = await page.evaluate(() => {
    const cur = document.querySelector("#write .md-htmlblock .CodeMirror-cursor")?.getBoundingClientRect();
    const line = [...document.querySelectorAll("#write .md-htmlblock .CodeMirror-line")].find((l) => l.textContent.includes("more"));
    const r = document.createRange(); r.selectNodeContents(line); const rs = r.getClientRects(); const last = rs[rs.length - 1];
    return { dx: Math.round(cur.left - last.right), dy: Math.round(cur.top - last.top) };
  });
  ok(Math.abs(a.dx) <= 2 && Math.abs(a.dy) <= 4, "bug8: caret sits at the end of the typed text", a);
  ok((await page.md()).includes("<b>Bold</b> text more 中文"), "bug8/IME: typing + composition land in the source", await page.md());
  await page.keyboard.press("Control+End"); await page.keyboard.press("ArrowDown"); await page.waitForTimeout(150);
  ok(!(await blk.locator(".md-htmlblock-editor").isVisible()) && (await blk.locator(".md-htmlblock-container").textContent()).includes("text more 中文"), "bug8: leaving with ↓ hides the source and re-renders");
  // new HTML block from the slash menu gets the caret
  await page.locator("#write p").last().click(); await page.keyboard.press("End"); await page.keyboard.press("Enter");
  await page.keyboard.type("/html"); await page.waitForTimeout(150); await page.keyboard.press("Enter"); await page.waitForTimeout(200);
  await page.keyboard.type("<i>new</i>");
  ok((await page.md()).includes("<div>\n  <i>new</i>\n</div>") || (await page.md()).includes("<div>\n<i>new</i>\n</div>"), "bug8: /html inserts and focuses the source", await page.md());
  // alignment across a few themes with their own 'pre' rules
  for (const theme of ["drake-dark", "purple", "lapis"]) {
    const p2 = await open("x2.md", "<p>\nabc\n</p>\n", { theme });
    await p2.locator("#write .md-htmlblock-container").click(); await p2.waitForTimeout(150);
    await p2.keyboard.press("Control+End"); await p2.keyboard.press("ArrowUp"); await p2.keyboard.press("End"); await p2.keyboard.type("XY");
    const b = await p2.evaluate(() => {
      const cur = document.querySelector("#write .md-htmlblock .CodeMirror-cursor")?.getBoundingClientRect();
      const line = [...document.querySelectorAll("#write .md-htmlblock .CodeMirror-line")].find((l) => l.textContent.includes("XY"));
      const r = document.createRange(); r.selectNodeContents(line); const rs = r.getClientRects(); const last = rs[rs.length - 1];
      return { dx: Math.round(cur.left - last.right), dy: Math.round(cur.top - last.top) };
    });
    ok(Math.abs(b.dx) <= 2 && Math.abs(b.dy) <= 4, `bug8: caret aligned in theme ${theme}`, b);
    await p2.context().close();
  }
  await page.context().close();
}

// ---------- bug 9 + 10: slash menu scrolling + Chinese ----------
{
  const page = await open("s.md", "Intro\n");
  await newLine(page);
  await page.keyboard.type("/"); await page.waitForTimeout(150);
  let hidden = 0;
  const vis = () => page.evaluate(() => { const m = document.querySelector(".mdn-slash"), s = m?.querySelector(".sel"); if (!s) return false; const a = m.getBoundingClientRect(), b = s.getBoundingClientRect(); return b.top >= a.top - 1 && b.bottom <= a.bottom + 1; });
  for (let i = 0; i < 22; i++) { await page.keyboard.press("ArrowDown"); if (!(await vis())) hidden++; }
  for (let i = 0; i < 30; i++) { await page.keyboard.press("ArrowUp"); if (!(await vis())) hidden++; }
  ok(hidden === 0, "bug9: ↑/↓ keep the active slash item visible (52 presses)", hidden + " hidden");
  await page.context().close();
  const zh = await open("s2.md", "Intro\n", { lang: "zh-CN" });
  await newLine(zh);
  const q = async (s) => { await zh.keyboard.type("/" + s); await zh.waitForTimeout(150); const r = await zh.$$eval(".mdn-slash .mdn-slash-item", (els) => els.map((e) => e.dataset.id)); await zh.keyboard.press("Escape"); for (let i = 0; i <= [...s].length; i++) await zh.keyboard.press("Backspace"); return r; };
  ok((await q("标题")).slice(0, 6).join() === "h1,h2,h3,h4,h5,h6", "bug10: '/标题' finds headings");
  ok((await q("bt"))[0] === "h1", "bug10: pinyin '/bt' finds headings");
  ok((await q("代码")).includes("code"), "bug10: '/代码' finds the code block");
  ok((await q("heading"))[0] === "h1", "bug10: English keyword still works in zh");
  await zh.keyboard.type("/"); await zh.waitForTimeout(150);
  const titles = await zh.$$eval(".mdn-slash .mdn-slash-item > span:first-child, .mdn-slash .mdn-slash-item b", (els) => els.map((e) => e.textContent));
  const english = titles.filter((s) => /^[A-Za-z][a-z]+( [A-Za-z][a-z]+)*…?$/.test(s.trim()));
  ok(english.length === 0, "bug10: slash titles all Chinese", english);
  // IME: typing '/' then a composed query
  await zh.keyboard.press("Escape"); await zh.keyboard.press("Backspace");
  await zh.keyboard.type("/"); await zh.ime("biaoti", "标题"); await zh.waitForTimeout(150);
  ok((await zh.$$eval(".mdn-slash .mdn-slash-item", (els) => els.map((e) => e.dataset.id)))[0] === "h1", "bug10/IME: '/'+IME 标题 filters to headings");
  await zh.context().close();
}

ok(errors.length === 0, "no page errors", errors);
await browser.close();
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
