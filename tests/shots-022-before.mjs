// "before" screenshots on 0.2.1 (vite preview of the 0.2.1 tree on :4175) for the 0.2.2 fixes, real input.
// Run: WS_ROOT=/tmp/mdn-021/dev-data/workspace node tests/shots-022-before.mjs http://127.0.0.1:4175/
import fs from "node:fs";
import path from "node:path";
import { chromium } from "playwright";
const base = process.argv[2] ?? "http://127.0.0.1:4175/";
const WS = path.join(process.env.WS_ROOT ?? "/tmp/mdn-021/dev-data/workspace", "before022");
const OUT = path.resolve("screenshots/fixes-0.2.2"); fs.mkdirSync(OUT, { recursive: true });
fs.rmSync(WS, { recursive: true, force: true }); fs.mkdirSync(WS, { recursive: true });
fs.copyFileSync(path.resolve("dev-data/workspace/real022-test/pic.png"), path.join(WS, "pic.png"));
const b = await chromium.launch();
async function open(file, text, lang = "zh-CN") {
  fs.writeFileSync(path.join(WS, file), text);
  const ctx = await b.newContext({ viewport: { width: 1200, height: 800 } }); const page = await ctx.newPage();
  await page.goto(`${base}?lang=${lang}&folder=${encodeURIComponent(WS)}&file=${encodeURIComponent(path.join(WS, file))}`);
  await page.waitForSelector("body.mdn-ready"); await page.waitForTimeout(500);
  return page;
}
const box = (page, w) => page.evaluate((w) => { const it = document.createTreeWalker(document.querySelector("#write"), NodeFilter.SHOW_TEXT); for (let t; (t = it.nextNode());) { const i = t.data.indexOf(w); if (i >= 0) { const r = document.createRange(); r.setStart(t, i); r.setEnd(t, i + w.length); const q = r.getBoundingClientRect(); return { x: q.x + q.width / 2, y: q.y + q.height / 2 }; } } }, w);
{ // context menu bold did nothing
  const page = await open("ctx.md", "你好 world 这里\n");
  const p = await box(page, "world"); await page.mouse.dblclick(p.x, p.y); await page.mouse.click(p.x, p.y, { button: "right" }); await page.waitForTimeout(200);
  await page.locator('.context-menu .mdn-menu-item[data-id="format"]').hover(); await page.waitForTimeout(200);
  await page.locator('.context-menu .mdn-menu-item[data-id="format.strong"]').click(); await page.waitForTimeout(300);
  console.log("before ctx bold →", JSON.stringify(await page.evaluate(() => window.mdnest.editor.getMarkdown())));
  await page.screenshot({ path: path.join(OUT, "before-ctx-format-bold-zh.png") }); await page.context().close();
}
{ // settings: no visible autosave switch default on
  const page = await open("a.md", "Start\n");
  await page.locator('.mdn-rail-btn[data-id="settings"]').click(); await page.waitForTimeout(300);
  await page.screenshot({ path: path.join(OUT, "before-autosave-setting-zh.png") }); await page.context().close();
}
{ // ArrowDown at the end of the last code block: caret has nowhere to go
  const page = await open("nav.md", "介绍\n\n```js\nlet a = 1;\n```\n");
  await page.locator("#write .CodeMirror-line").first().click(); await page.keyboard.press("End"); await page.keyboard.press("ArrowDown"); await page.keyboard.type("after");
  console.log("before code ↓ →", JSON.stringify(await page.evaluate(() => window.mdnest.editor.getMarkdown())));
  await page.screenshot({ path: path.join(OUT, "before-block-exit-zh.png") }); await page.context().close();
}
{ // Backspace after a code block
  const page = await open("del.md", "介绍\n\n```js\ncode\n```\n\nAfter\n");
  await page.locator("#write > p", { hasText: "After" }).click(); await page.keyboard.press("Home"); await page.keyboard.press("Backspace"); await page.waitForTimeout(200);
  console.log("before backspace →", JSON.stringify(await page.evaluate(() => window.mdnest.editor.getMarkdown())));
  await page.screenshot({ path: path.join(OUT, "before-block-backspace-zh.png") }); await page.context().close();
}
{ // image: only zoom 50/100/200 hidden in a submenu, no toolbar
  const page = await open("img.md", "介绍\n\n![pic](pic.png)\n\nAfter\n");
  await page.locator("#write span.md-image img").click(); await page.waitForTimeout(200);
  await page.locator("#write span.md-image img").click({ button: "right" }); await page.waitForTimeout(200);
  const it = page.locator('.context-menu .mdn-menu-item[data-id="image-align"]');
  if (await it.count()) { await it.hover(); await page.waitForTimeout(250); }
  await page.screenshot({ path: path.join(OUT, "before-image-menu-zh.png") }); await page.context().close();
}
await b.close();
