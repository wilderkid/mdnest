// before (0.2.0 on :4174) / after (0.2.1 on :4173) screenshots for each bug, real input
import { createRequire } from "module";
const require = createRequire("/workspace/mdnest/package.json");
const { chromium } = require("playwright"); const fs = require("fs");
const OUT = "/workspace/mdnest/screenshots/fixes-0.2.1";
const which = process.argv[2]; // before|after
const port = which === "before" ? 4174 : 4173;
const ROOT = (which === "before" ? "/tmp/mdn-020" : "/workspace/mdnest") + "/dev-data/workspace/shots021";
fs.rmSync(ROOT, { recursive: true, force: true }); fs.mkdirSync(ROOT + "/assets", { recursive: true });
const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAIAAACQkWg2AAAAHElEQVR4nGP8z8DwnwEJMDGgAcYRCRgFAABmLwIfyPo0uQAAAABJRU5ErkJggg==", "base64");
fs.writeFileSync(ROOT + "/assets/pic.png", png);
const b = await chromium.launch();
async function open(file, text, lang = "zh-CN") {
  fs.writeFileSync(ROOT + "/" + file, text);
  const ctx = await b.newContext({ viewport: { width: 1100, height: 640 }, locale: "zh-CN" });
  const page = await ctx.newPage(); page.on("dialog", (d) => d.dismiss());
  await page.goto(`http://127.0.0.1:${port}/?lang=${lang}&folder=${encodeURIComponent(ROOT)}&file=${encodeURIComponent(ROOT + "/" + file)}`);
  await page.waitForSelector("body.mdn-ready"); await page.waitForTimeout(500);
  return page;
}
const shot = (page, name) => page.screenshot({ path: `${OUT}/${name}-${which}.png` });
const safe = async (f) => { try { await f(); } catch (e) { console.log("step failed:", e.message.split("\n")[0]); } };
// bug 6: freshly opened file
{ const p = await open("h.md", "# 标题一\n\n正文段落。\n\n## 小节\n\n更多内容。\n"); await shot(p, "bug6-open-file"); 
  // bug 2: caret in heading, edit marker
  await safe(async () => { await p.locator("#write h2").click(); await p.keyboard.press("Home"); await p.keyboard.type("#"); await p.waitForTimeout(200); });
  await shot(p, "bug2-heading-marker-edit"); await p.context().close(); }
// bug 4: code block typing + language picker
{ const p = await open("c.md", "介绍\n");
  await safe(async () => { await p.locator("#write p").click(); await p.keyboard.press("End"); await p.keyboard.press("Enter"); await p.keyboard.type("```"); await p.keyboard.press("Enter"); await p.waitForTimeout(200); await p.keyboard.type("let x = 1;\nconsole.log(x);"); });
  await safe(async () => { await p.locator("#write .md-fences").hover(); await p.locator("#write .ty-cm-lang-input").click({ timeout: 2000 }); await p.keyboard.type("ja"); await p.waitForTimeout(200); });
  await shot(p, "bug4-code-block"); await p.context().close(); }
// bug 5: math
{ const p = await open("m.md", "介绍\n");
  await safe(async () => { await p.locator("#write p").click(); await p.keyboard.press("End"); await p.keyboard.press("Enter"); await p.keyboard.type("$$"); await p.keyboard.press("Enter"); await p.waitForTimeout(200); await p.keyboard.type("E = mc^2 + \\frac{a}{b}"); await p.waitForTimeout(600); });
  await shot(p, "bug5-math-block"); await p.context().close(); }
// bug 7: mermaid
{ const p = await open("g.md", "介绍\n");
  await safe(async () => { await p.locator("#write p").click(); await p.keyboard.press("End"); await p.keyboard.press("Enter"); await p.keyboard.type("```mermaid"); await p.keyboard.press("Enter"); await p.waitForTimeout(200); await p.keyboard.type("graph LR\nA[开始] --> B[结束]"); await p.waitForTimeout(1500); });
  await shot(p, "bug7-mermaid"); await p.context().close(); }
// bug 8: html block not focused
{ const p = await open("x.md", "介绍\n\n<div align=\"center\">\n  <b>粗体</b> 和 <i>斜体</i>\n</div>\n\n结尾\n");
  await safe(async () => { await p.locator("#write p").last().click(); await p.waitForTimeout(200); });
  await shot(p, "bug8-html-unfocused"); await p.context().close(); }
// bug 1: image displays (relative) — browser-host proxy
{ const p = await open("i.md", "图片：\n\n![pic](assets/pic.png)\n");
  await p.waitForTimeout(400); await shot(p, "bug1-image-relative"); await p.context().close(); }
// bug 9: slash scroll
{ const p = await open("s.md", "介绍\n");
  await safe(async () => { await p.locator("#write p").click(); await p.keyboard.press("End"); await p.keyboard.press("Enter"); await p.keyboard.type("/"); await p.waitForTimeout(200); for (let i = 0; i < 16; i++) await p.keyboard.press("ArrowDown"); });
  await shot(p, "bug9-slash-arrowdown-x16"); await p.context().close(); }
// bug 10: dialogs in zh
{ const p = await open("d.md", "# 文档\n");
  await safe(async () => { await p.evaluate(() => window.mdnest.runCommand("edit.replace")); await p.waitForTimeout(200); });
  await shot(p, "bug10-find-replace-zh");
  await safe(async () => { await p.keyboard.press("Escape"); await p.evaluate(() => window.mdnest.runCommand("paragraph.tableDialog")); await p.waitForTimeout(200); });
  await shot(p, "bug10-table-dialog-zh");
  await safe(async () => { await p.keyboard.press("Escape"); await p.evaluate(() => document.querySelectorAll(".modal-backdrop").forEach((e) => e.remove())); const n = p.locator('.file-node-content:has-text("d.md")').last(); await n.click({ button: "right" }); await p.locator('.context-menu .mdn-menu-item[data-id="delete"]').click(); await p.waitForTimeout(200); });
  await shot(p, "bug3-bug10-delete-dialog-zh"); await p.context().close(); }
// bug 10: language switch (Settings top + View menu)
{ const p = await open("l.md", "# 文档\n");
  await safe(async () => { await p.locator('.mdn-rail-btn[data-id="settings"]').click(); await p.waitForTimeout(300); });
  await shot(p, "bug10-settings-language-switch");
  await safe(async () => { await p.locator('#mdn-menubar .mdn-menu[data-menu="view"] > .mdn-menu-label').click(); await p.locator('#mdn-menubar .mdn-menu-sub[data-sub="view.language"]').hover({ timeout: 2000 }); await p.waitForTimeout(300); });
  await shot(p, "bug10-view-menu-language"); await p.context().close(); }
await b.close();
