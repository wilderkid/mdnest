// Screenshot set for Shell B (青屿): every panel in zh-CN and en, light + dark gallery themes,
// welcome, menus, and side-by-side comparisons with the mockups (when ../mdnest-mockups/B exists).
// Needs `npx vite build` + `vite preview` on :4173. Run: node tests/shots-shell-b.mjs [base]
import fs from "node:fs";
import path from "node:path";
import { chromium } from "playwright";
import { start as startMock } from "./mock-openai.mjs";

const base = process.argv[2] ?? "http://127.0.0.1:4173/";
const OUT = path.resolve("screenshots/shell-b");
const ROOT = path.resolve("dev-data/workspace");
const DOC = path.join(ROOT, "sample.md");
const MOCK = path.resolve(process.env.MOCKUPS ?? "../mdnest-mockups/B");
fs.mkdirSync(OUT, { recursive: true });
const mock = await startMock(1426).ready();
const browser = await chromium.launch();
const errors = [];

async function open(lang, theme = "mdnest", extra = "") {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 }, locale: lang === "zh" ? "zh-CN" : "en-US", permissions: ["clipboard-read", "clipboard-write"] });
  const page = await ctx.newPage();
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto(`${base}?lang=${lang === "zh" ? "zh-CN" : "en"}&theme=${theme}&folder=${encodeURIComponent(ROOT)}&file=${encodeURIComponent(DOC)}${extra}`);
  await page.waitForSelector("body.mdn-ready", { timeout: 30000 });
  await page.evaluate(async (url) => {
    const s = (o, k, v) => localStorage.setItem(`mdnest.plugin.${o}.${k}`, JSON.stringify(v));
    s("ai", "enabled", true); s("ai", "preset", "custom"); s("ai", "baseUrl", url); s("ai", "model", "mock-1");
    s("ai", "dailyRequestLimit", 0); s("ai", "dailyTokenLimit", 0); s("library", "enabled", true);
    localStorage.setItem("mdnest.recent", JSON.stringify([]));
    await window.mdnest.host.secrets.set("ai.apikey", "test-key-123");
  }, mock.url);
  await page.reload(); await page.waitForSelector("body.mdn-ready");
  for (const f of ["notes/ideas.md", "mathtest.md", "p2.md", "sample.md"]) {
    if (fs.existsSync(path.join(ROOT, f))) await page.evaluate((p) => window.mdnest.openAt(p), path.join(ROOT, f));
  }
  await page.waitForTimeout(400);
  return page;
}
const rail = async (page, id) => { await page.locator(`.mdn-rail-btn[data-id="${id}"]`).click(); await page.waitForTimeout(350); };
const shot = (page, name) => page.screenshot({ path: path.join(OUT, name + ".png") });

for (const lang of ["zh", "en"]) {
  const page = await open(lang);
  await rail(page, "files");
  const docs = page.locator('.file-node-content:has(.file-node-title:text-is("notes"))');
  if (await docs.count()) await docs.first().click();
  await page.waitForTimeout(200);
  await page.locator(".file-library-node:not(.file-library-folder) .file-node-content").nth(1).hover();
  await shot(page, `${lang}-files`);
  await page.locator('.mdn-head[data-for="files"] .ph-btn[data-act="more"]').click();
  await page.locator('.mdn-menu-item[data-id="sort"]').hover(); await page.waitForTimeout(200);
  await shot(page, `${lang}-files-more-menu`); await page.keyboard.press("Escape"); await page.mouse.click(700, 400);
  await page.locator("#sidebar-ws-switch").click(); await page.waitForTimeout(200);
  await shot(page, `${lang}-workspace-switcher`); await page.keyboard.press("Escape"); await page.mouse.click(700, 400);
  await page.locator(".file-library-node:not(.file-library-folder) .file-node-content").first().click({ button: "right" }); await page.waitForTimeout(200);
  await shot(page, `${lang}-file-context-menu`); await page.keyboard.press("Escape"); await page.mouse.click(700, 400);
  await rail(page, "outline"); await shot(page, `${lang}-outline`);
  await rail(page, "search");
  await page.locator("#file-library-search-input").fill(lang === "zh" ? "math" : "math"); await page.waitForTimeout(900);
  await shot(page, `${lang}-search`);
  await rail(page, "p-ai");
  const input = page.locator(".mdn-ai-input");
  if (await input.count()) {
    await input.fill(lang === "zh" ? "帮我总结这篇文档" : "Summarise this document");
    await page.locator(".mdn-ai-actions button").first().click();
    await page.waitForTimeout(2500);
  }
  await shot(page, `${lang}-ai`);
  await rail(page, "p-library");
  const q = page.locator(".mdn-lib-q");
  if (await q.count()) { await q.fill("math"); await page.keyboard.press("Enter"); await page.waitForTimeout(2500); }
  await shot(page, `${lang}-library`);
  await rail(page, "p-word-stats"); await shot(page, `${lang}-stats`);
  await rail(page, "settings"); await shot(page, `${lang}-settings`);
  await page.locator("#settings-search").fill(lang === "zh" ? "编码" : "encoding"); await page.waitForTimeout(200);
  await shot(page, `${lang}-settings-search`);
  await rail(page, "files");
  await page.locator("#write h1 + p").first().click({ button: "right", position: { x: 40, y: 8 } }); await page.waitForTimeout(250);
  await page.locator('.mdn-menu-item[data-id="paragraph"]').hover(); await page.waitForTimeout(200);
  await shot(page, `${lang}-editor-context-menu`); await page.keyboard.press("Escape"); await page.mouse.click(700, 300);
  await page.locator('#mdn-menubar .mdn-menu[data-menu="file"] > .mdn-menu-label').click(); await page.waitForTimeout(200);
  await shot(page, `${lang}-menubar`); await page.keyboard.press("Escape"); await page.mouse.click(700, 300);
  await page.evaluate(() => window.mdnest.runCommand("file.close")); await page.waitForTimeout(900);
  await shot(page, `${lang}-welcome`);
  await page.context().close();
}

for (const theme of ["drake-dark", "vue-dark", "lapis-dark", "lapis", "purple", "drake-light"]) {
  const page = await open("zh", theme);
  await rail(page, "files"); await shot(page, `theme-${theme}-files`);
  await rail(page, "outline"); await shot(page, `theme-${theme}-outline`);
  if (theme === "drake-dark" || theme === "lapis") {
    await rail(page, "p-ai");
    await page.locator(".mdn-ai-input").fill("你好"); await page.locator(".mdn-ai-actions button").first().click(); await page.waitForTimeout(2500);
    await shot(page, `theme-${theme}-ai`);
    await rail(page, "settings"); await shot(page, `theme-${theme}-settings`);
  }
  await rail(page, "files");
  await page.evaluate(() => window.mdnest.runCommand("file.close")); await page.waitForTimeout(900);
  await shot(page, `theme-${theme}-welcome`);
  await page.context().close();
}
await browser.close();
mock.close?.();

// side-by-side with the mockups
const pairs = [["welcome", "zh-welcome"], ["welcome-dark", "theme-drake-dark-welcome"], ["sidebar-files", "zh-files"], ["sidebar-files-dark", "theme-drake-dark-files"],
  ["sidebar-outline", "zh-outline"], ["sidebar-ai", "zh-ai"], ["sidebar-library", "zh-library"], ["sidebar-settings", "zh-settings"], ["editor", "zh-files"], ["editor-dark", "theme-drake-dark-outline"]];
if (fs.existsSync(MOCK)) {
  const page = await (await chromium.launch()).newPage({ viewport: { width: 2580, height: 860 } });
  for (const [m, a] of pairs) {
    const mf = path.join(MOCK, m + ".png"), af = path.join(OUT, a + ".png");
    if (!fs.existsSync(mf) || !fs.existsSync(af)) continue;
    const b64 = (f) => "data:image/png;base64," + fs.readFileSync(f).toString("base64");
    await page.setContent(`<body style="margin:0;background:#222;font:600 16px system-ui;color:#eee;display:flex;gap:20px;padding:10px">
      <div><div style="height:30px">Mockup · ${m}</div><img src="${b64(mf)}" width="1280"></div>
      <div><div style="height:30px">Implementation · ${a}</div><img src="${b64(af)}" width="1280"></div></body>`);
    await page.screenshot({ path: path.join(OUT, `compare-${m}.png`) });
  }
  await page.context().browser().close();
}
console.log(errors.length ? "page errors: " + errors.join(" | ") : "no page errors");
console.log("wrote", fs.readdirSync(OUT).length, "files to", OUT);
process.exit(0);
