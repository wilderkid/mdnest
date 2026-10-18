// Headless screenshots + smoke checks. Usage: node tests/screenshots.mjs [baseUrl]
import { chromium } from "playwright";
const base = process.argv[2] ?? "http://127.0.0.1:4173/";
const themes = (process.env.THEMES ?? "mdnest,vue,drake,lapis,purple,mdnest-night").split(",");
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1280, height: 900 }, deviceScaleFactor: 1 });
const errors = [];
page.on("pageerror", (e) => errors.push("pageerror: " + e.message));
page.on("console", (m) => { if (m.type() === "error") errors.push("console: " + m.text()); });
const ready = async () => {
  await page.waitForSelector("body.mdn-ready", { timeout: 30000 });
  await page.waitForFunction(() => document.querySelectorAll("#write .md-diagram-panel svg").length >= 1 && document.querySelectorAll("#write mjx-container").length >= 2, null, { timeout: 30000 }).catch(() => errors.push("timeout waiting for math/mermaid"));
  await page.waitForTimeout(600);
};
const results = {};
for (const t of themes) {
  await page.evaluate(() => localStorage.clear()).catch(() => {});
  await page.goto(base + "?theme=" + t);
  await ready();
  const applied = await page.evaluate(() => document.body.dataset.theme);
  await page.screenshot({ path: `screenshots/theme-${t}.png` });
  await page.evaluate(() => { const h = [...document.querySelectorAll("#write h2")].find((h) => h.textContent === "Table"); document.querySelector("content").scrollTop = h.offsetTop - 20; });
  await page.waitForTimeout(300);
  await page.screenshot({ path: `screenshots/theme-${t}-2.png` });
  await page.evaluate(() => { const h = [...document.querySelectorAll("#write h2")].find((h) => h.textContent === "Mermaid"); document.querySelector("content").scrollTop = h.offsetTop - 20; });
  await page.waitForTimeout(300);
  await page.screenshot({ path: `screenshots/theme-${t}-3.png` });
  results[t] = applied;
}
// interaction checks on default theme
await page.goto(base + "?theme=mdnest"); await ready();
const checks = {};
// click into the bold word in the first paragraph containing <strong>
const strong = page.locator("#write p strong").first();
await strong.click();
await page.waitForTimeout(200);
checks.revealMeta = await page.evaluate(() => [...document.querySelectorAll("#write .md-expand ~ .md-meta, #write .md-meta")].map((e) => e.textContent).join(" "));
checks.focusClass = await page.evaluate(() => document.querySelectorAll("#write .md-focus").length);
await page.screenshot({ path: "screenshots/reveal-bold.png", clip: { x: 260, y: 0, width: 1020, height: 500 } });
// focus a code fence → CodeMirror visible
const mm = page.locator("#write .md-fences-advanced").first();
await mm.locator(".md-diagram-panel").click(); await page.waitForTimeout(300);
checks.mermaidEditOpen = await page.evaluate(() => !!document.querySelector("#write .md-fences-advanced.md-focus"));
await mm.scrollIntoViewIfNeeded(); await page.screenshot({ path: "screenshots/mermaid-focused.png" });
// typing: input rules
await page.locator("#write h1").first().click(); await page.waitForTimeout(150);
await page.keyboard.press("End"); await page.keyboard.press("Enter");
await page.keyboard.type("Typed **bold** and `code` ");
await page.waitForTimeout(100);
checks.inputRules = await page.evaluate(() => { const p = [...document.querySelectorAll("#write p")].find((p) => p.textContent.startsWith("Typed")); return p ? p.innerHTML.includes("<strong>") && p.innerHTML.includes("<code>") : false; });
// round-trip of current doc
checks.markdownHead = (await page.evaluate(() => window.mdnest.editor.getMarkdown())).split("\n").slice(0, 12).join("\n");
// source mode
await page.keyboard.press("Control+/"); await page.waitForTimeout(300);
checks.sourceMode = await page.evaluate(() => document.body.classList.contains("typora-sourceview-on") && !!document.querySelector("#typora-source .CodeMirror"));
await page.screenshot({ path: "screenshots/source-mode.png" });
await page.keyboard.press("Control+/"); await page.waitForTimeout(300);
// outline tab + plugin panel
await page.click('.sidebar-tab[data-id="outline"]');
checks.outlineItems = await page.locator("#outline-content .outline-item").count();
await page.screenshot({ path: "screenshots/outline.png" });
await page.click('.sidebar-tab[data-id="p-word-stats"]');
checks.statsPanel = await page.locator(".ws-panel").innerText().catch(() => "");
// command palette + plugin command with dependency
await page.keyboard.press("Control+Shift+P"); await page.keyboard.type("writing goal"); await page.waitForTimeout(100);
await page.screenshot({ path: "screenshots/command-palette.png" });
await page.keyboard.press("Enter"); await page.waitForTimeout(200);
checks.toast = await page.locator("#mdn-toast").innerText();
// theme switcher via footer select
await page.selectOption("#theme-select", "drake-dark"); await page.waitForTimeout(800);
checks.switcher = await page.evaluate(() => document.body.dataset.theme + " dark=" + document.body.classList.contains("mdn-dark"));
await page.screenshot({ path: "screenshots/switch-drake-dark.png" });
// file tree: open another file
await page.click('.sidebar-tab[data-id="files"]');
await page.click('.file-node-title:text("ideas.md")'); await page.waitForTimeout(300);
checks.openedFromTree = await page.evaluate(() => document.getElementById("file-title").textContent);
console.log(JSON.stringify({ results, checks, errors: errors.slice(0, 15) }, null, 2));
await browser.close();
