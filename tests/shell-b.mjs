// Shell B (青屿) E2E: activity rail + panel switching, files header actions, the 更多 menu, the
// recent section, the workspace switcher, settings search, i18n (zh-CN / en), theme-follow
// colours and the welcome page's recent-file previews.
// Needs `npx vite build` + `vite preview` on :4173. Run: node tests/shell-b.mjs [base]
import fs from "node:fs";
import path from "node:path";
import { chromium } from "playwright";

const base = process.argv[2] ?? "http://127.0.0.1:4173/";
const ROOT = path.resolve(process.env.WS_ROOT ?? "dev-data/workspace");
const WS = path.join(ROOT, "shellb-test");
const WS2 = path.join(ROOT, "shellb-test-2");
const OUT = path.resolve("screenshots/shell-b");
fs.mkdirSync(OUT, { recursive: true });
let fail = 0, pass = 0;
const ok = (c, m, info = "") => { console.log((c ? "PASS " : "FAIL ") + m + (c || !info ? "" : " — " + String(info).slice(0, 300))); c ? pass++ : fail++; };
const write = (dir, files) => { fs.rmSync(dir, { recursive: true, force: true }); for (const [f, t] of Object.entries(files)) { fs.mkdirSync(path.dirname(path.join(dir, f)), { recursive: true }); fs.writeFileSync(path.join(dir, f), t); } };
write(WS, {
  "alpha.md": "# Alpha notes\n\nThe **first** paragraph of alpha with a [link](http://x).\n",
  "beta.md": "# Beta\n\nSecond file 你好世界.\n",
  "docs/gamma.md": "# Gamma\n\nNested.\n",
  "assets/pic.png": "",
});
write(WS2, { "other.md": "# Other\n" });

const browser = await chromium.launch();
const errors = [];
const newPage = async (query, locale = "en-US") => {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 }, locale });
  const page = await ctx.newPage();
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto(base + query);
  await page.waitForSelector("body.mdn-ready", { timeout: 30000 });
  await page.waitForTimeout(300);
  return page;
};
const menuItems = (page) => page.$$eval(".context-menu:last-of-type .mdn-menu-item", (els) => els.map((e) => ({ id: e.dataset.id, text: e.textContent.trim(), checked: e.classList.contains("checked") })));
const closeMenus = (page) => page.keyboard.press("Escape");

// ---------- rail + panels ----------
{
  const page = await newPage(`?folder=${encodeURIComponent(WS)}&file=${encodeURIComponent(WS + "/alpha.md")}`);
  ok(await page.locator("#typora-sidebar.mdn-sb-v2 nav.mdn-rail").count() === 1, "activity rail present");
  ok(await page.locator(".sidebar-tabs").count() === 0, "old .sidebar-tabs gone");
  const rail = await page.$$eval(".mdn-rail-btn", (bs) => bs.map((b) => [b.dataset.id, getComputedStyle(b).order]).sort((a, b) => +a[1] - +b[1]).map((x) => x[0]));
  ok(JSON.stringify(rail.slice(0, 3)) === '["files","outline","search"]' && rail.at(-1) === "settings", "rail order files/outline/search … settings", rail);
  for (const id of ["outline", "search", "p-word-stats", "settings", "files"]) {
    await page.locator(`.mdn-rail-btn[data-id="${id}"]`).click();
    const st = await page.evaluate((id) => ({
      active: document.querySelector(".mdn-rail-btn.active")?.dataset.id,
      head: [...document.querySelectorAll(".mdn-head")].filter((h) => getComputedStyle(h).display !== "none").map((h) => h.dataset.for),
      title: document.querySelector(`.mdn-head[data-for="${id}"] .ph-title`)?.textContent.trim(),
    }), id);
    ok(st.active === id && st.head.length === 1 && st.head[0] === id && !!st.title, `rail → ${id} panel (head “${st.title}”)`, JSON.stringify(st));
  }
  // outline header + footer
  await page.locator('.mdn-rail-btn[data-id="outline"]').click();
  ok(await page.locator(".outline-item .ol-lv").first().textContent() === "H1", "outline H badge");
  ok(/1 heading/.test(await page.locator('.mdn-foot[data-for="outline"]').textContent()), "outline footer stats", await page.locator('.mdn-foot[data-for="outline"]').textContent());
  await page.locator('.mdn-rail-btn[data-id="files"]').click();

  // header actions: tree nodes, collapse all, new file
  await page.locator('.file-node-content:has(.file-node-title:text-is("docs"))').click();
  await page.waitForTimeout(200);
  ok(await page.locator('.file-node-title', { hasText: "gamma" }).count() === 1, "folder expands in tree");
  ok(await page.locator('.file-node-content:has(.file-node-title:text-is("docs")) i.guide').count() === 0 && await page.locator('.file-node-content:has(.file-node-title:has-text("gamma")) i.guide').count() === 1, "indent guides per depth");
  ok(await page.locator(".file-library-node.kind-assets").count() === 1, "assets folder gets its own kind");
  await page.locator('.mdn-head[data-for="files"] .ph-btn[data-act="collapse-all"]').click();
  await page.waitForTimeout(200);
  ok(!(await page.locator('.file-node-title', { hasText: "gamma" }).isVisible()), "Collapse All header action");
  const before = fs.readdirSync(WS, { recursive: true }).length;
  await page.locator('.mdn-head[data-for="files"] .ph-btn[data-act="new-file"]').click();
  await page.waitForTimeout(600);
  const made = fs.readdirSync(WS, { recursive: true }).filter((f) => /Untitled.*\.md$/.test(f));
  ok(made.length === 1 && fs.readdirSync(WS, { recursive: true }).length === before + 1, "New File header action creates a file (rename starts)", made.join(","));
  await page.keyboard.press("Escape");
  await page.locator('.mdn-head[data-for="files"] .ph-btn[data-act="new-folder"]').click();
  await page.waitForTimeout(600);
  ok(fs.readdirSync(WS, { recursive: true }).some((f) => /Untitled folder/.test(f)), "New Folder header action creates a folder");
  await page.keyboard.press("Escape");

  // 更多 menu: sort + view
  await page.locator('.mdn-head[data-for="files"] .ph-btn[data-act="more"]').click();
  let items = await menuItems(page);
  ok(["sort", "view", "locate", "collapse-all", "refresh", "open-folder", "reveal-root", "copy-root"].every((id) => items.some((i) => i.id === id)), "More menu items", items.map((i) => i.id).join(","));
  await page.locator('.mdn-menu-item[data-id="sort"]').hover();
  await page.locator('.mdn-menu-item[data-id="sort:desc"]').click();
  await page.waitForTimeout(300);
  const order = await page.$$eval("#file-library-tree > .file-tree-root > .file-library-node .file-node-title, #file-library-tree .file-library-node[data-depth='0'] .file-node-title", (e) => e.map((x) => x.textContent));
  ok(/↓/.test(await page.locator(".sidebar-sort-label").textContent()), "sort descending from More menu", order.join(","));
  await page.locator('.mdn-head[data-for="files"] .ph-btn[data-act="more"]').click();
  await page.locator('.mdn-menu-item[data-id="view"]').hover();
  await page.locator('.mdn-menu-item[data-id="view:list"]').click();
  await page.waitForTimeout(300);
  ok(await page.locator("#file-library-list").isVisible() && !(await page.locator("#file-library-tree").isVisible()), "View ▸ List from More menu");
  await page.locator('.mdn-head[data-for="files"] .ph-btn[data-act="more"]').click();
  await page.locator('.mdn-menu-item[data-id="view"]').hover();
  await page.locator('.mdn-menu-item[data-id="view:tree"]').click();
  await page.locator('.mdn-head[data-for="files"] .ph-btn[data-act="more"]').click();
  await page.locator('.mdn-menu-item[data-id="sort"]').hover();
  await page.locator('.mdn-menu-item[data-id="sort:asc"]').click();

  // recent section
  await page.evaluate((p) => window.mdnest.openAt(p), WS + "/beta.md");
  await page.waitForTimeout(400);
  const recent = await page.$$eval(".sb-sec[data-sec=recent] .recent-file", (e) => e.map((x) => [x.querySelector(".file-node-title").textContent, x.classList.contains("current")]));
  ok(recent[0]?.[0] === "beta.md" && recent[0][1] && recent.some((r) => r[0] === "alpha.md"), "recent section lists files, current first", JSON.stringify(recent));
  await page.locator(".sb-sec[data-sec=recent] .sb-sec-head").click();
  ok(await page.locator(".sb-sec[data-sec=recent].collapsed").count() === 1, "recent section collapses");
  await page.reload(); await page.waitForSelector("body.mdn-ready");
  ok(await page.locator(".sb-sec[data-sec=recent].collapsed").count() === 1, "recent collapse persists across reload");
  await page.evaluate(() => window.mdnest.sidebar.select("recent"));
  ok(await page.locator(".sb-sec[data-sec=recent].collapsed").count() === 0 && await page.locator('.mdn-rail-btn.active').getAttribute("data-id") === "files", "select('recent') opens files panel + expands recent");
  await page.locator(".recent-file", { hasText: "alpha.md" }).click();
  await page.waitForTimeout(400);
  ok((await page.locator("#write h1").first().textContent()).includes("Alpha"), "clicking a recent file opens it");

  // workspace switcher
  await page.evaluate((p) => window.mdnest.sidebar.openFolder(p), WS2);
  await page.waitForTimeout(300);
  ok((await page.locator("#sidebar-ws-switch .ws-name").textContent()) === "shellb-test-2", "ws-name shows root");
  await page.locator("#sidebar-ws-switch").click();
  items = await menuItems(page);
  ok(items.some((i) => i.text === "shellb-test" && !i.checked) && items.some((i) => i.text === "shellb-test-2" && i.checked) && items.some((i) => i.id === "open-folder") && items.some((i) => i.id === "new-window"), "workspace menu lists recent folders, current checked", JSON.stringify(items));
  await page.locator('.mdn-menu-item', { hasText: /^shellb-test$/ }).click();
  await page.waitForTimeout(500);
  ok((await page.locator("#sidebar-ws-switch .ws-name").textContent()) === "shellb-test", "switch workspace from menu");

  // settings search
  await page.locator('.mdn-rail-btn[data-id="settings"]').click();
  const groups = await page.$$eval(".set-grp", (g) => g.map((x) => x.dataset.grp));
  ok(groups.length >= 5 && groups.includes("appearance"), "settings grouped", groups.join(","));
  await page.locator("#settings-search").fill("encoding");
  await page.waitForTimeout(200);
  const vis = await page.$$eval(".set-grp:not(.set-hidden)", (g) => g.map((x) => x.dataset.grp));
  ok(vis.length >= 1 && vis.length < groups.length && await page.locator("#set-fallback").isVisible(), "settings search filters groups", vis.join(","));
  await page.locator("#settings-search").fill("zzzz-nothing");
  ok(await page.locator(".set-none:not(.set-hidden)").isVisible(), "settings search: no match message");
  await page.locator("#settings-search").fill("");
  ok((await page.$$eval(".set-grp.set-hidden", (g) => g.length)) === 0, "clearing search restores groups");
  ok(await page.locator("#set-autosave.switch").count() === 1, "editor switches render as switches");

  // status bar
  ok(await page.locator("#file-crumbs .crumb-path").count() === 1 && (await page.locator("#file-crumbs").textContent()).includes("alpha.md"), "status bar breadcrumb");
  ok(await page.locator("#theme-chip select#theme-select").count() === 1, "theme chip");
  ok(/words/.test(await page.locator("#footer-word-count").textContent()), "English word count in status bar");
  await page.screenshot({ path: path.join(OUT, "test-en-settings.png") });
  await page.context().close();
}

// ---------- i18n ----------
{
  const page = await newPage(`?folder=${encodeURIComponent(WS)}&file=${encodeURIComponent(WS + "/alpha.md")}&lang=zh-CN`);
  const menubar = await page.$$eval("#mdn-menubar .mdn-menu > .mdn-menu-label", (e) => e.map((x) => x.textContent.trim()));
  ok(menubar.includes("文件") && menubar.includes("编辑") && menubar.includes("主题"), "zh menubar labels", menubar.join(","));
  ok(await page.locator('#mdn-menubar .mdn-menu[data-menu="file"]').count() === 1, "menubar data-menu stays English ids");
  ok((await page.locator(".sb-sec[data-sec=ws] .sec-title").textContent()) === "工作区", "zh sidebar section title");
  ok(/字/.test(await page.locator("#footer-word-count").textContent()), "zh word count", await page.locator("#footer-word-count").textContent());
  await page.locator('.mdn-rail-btn[data-id="settings"]').click();
  ok((await page.locator('.mdn-head[data-for="settings"] .ph-title').textContent()).includes("设置"), "zh settings title");
  ok(await page.evaluate(() => document.querySelector(".mdn-settings")?.firstElementChild?.classList.contains("set-lang-top")), "language switch is the first thing in Settings");
  ok(/语言/.test(await page.locator(".set-lang-top").textContent()) && /Language/.test(await page.locator(".set-lang-top").textContent()), "language switch labelled in both languages");
  await page.locator('.set-seg-btn[data-lang="en"]').click();
  await page.waitForTimeout(400);
  ok((await page.locator('.set-grp[data-grp="appearance"] .set-title').textContent()) === "Appearance" && (await page.locator('#mdn-menubar .mdn-menu[data-menu="file"] > .mdn-menu-label').textContent()) === "File", "switching language to English re-renders settings + menus");
  // View → Language / 语言 → 简体中文 from the menu bar
  await page.locator('#mdn-menubar .mdn-menu[data-menu="view"] > .mdn-menu-label').click();
  await page.locator('#mdn-menubar .mdn-menu-sub[data-sub="view.language"]').hover();
  await page.locator('#mdn-menubar button[data-id="lang.zh-CN"]').click();
  await page.waitForTimeout(400);
  ok((await page.locator('#mdn-menubar .mdn-menu[data-menu="file"] > .mdn-menu-label').textContent()) === "文件", "View → Language → 简体中文 switches the UI");
  ok(await page.evaluate(() => localStorage.getItem("mdnest.lang")) === "zh-CN", "menu choice is saved");
  await page.locator('.set-seg-btn[data-lang="auto"]').click();
  await page.context().close();
  const zhAuto = await newPage(`?folder=${encodeURIComponent(WS)}&file=${encodeURIComponent(WS + "/alpha.md")}`, "zh-CN");
  ok((await zhAuto.locator(".sb-sec[data-sec=ws] .sec-title").textContent()) === "工作区", "zh-CN system locale → Chinese UI by default");
  await zhAuto.context().close();
}

// ---------- theme-follow ----------
{
  const page = await newPage(`?folder=${encodeURIComponent(WS)}&file=${encodeURIComponent(WS + "/alpha.md")}&theme=drake-dark`);
  const dark = await page.evaluate(() => {
    const cs = getComputedStyle(document.documentElement);
    const lum = (c) => { const m = c.match(/[\d.]+/g).map(Number); return (m[0] * 299 + m[1] * 587 + m[2] * 114) / 1000; };
    return { dark: document.body.classList.contains("mdn-dark"), tbg: cs.getPropertyValue("--mdn-tbg").trim(), panel: lum(getComputedStyle(document.querySelector(".mdn-panel")).backgroundColor), content: lum(getComputedStyle(document.querySelector("content")).backgroundColor) };
  });
  ok(dark.dark && dark.tbg === "rgb(43, 43, 43)" && dark.panel < 90 && dark.content < 90, "drake-dark: shell follows the theme background", JSON.stringify(dark));
  await page.screenshot({ path: path.join(OUT, "test-drake-dark.png") });
  await page.selectOption("#theme-select", "lapis");
  await page.waitForTimeout(600);
  const light = await page.evaluate(() => ({ dark: document.body.classList.contains("mdn-dark"), tbg: getComputedStyle(document.documentElement).getPropertyValue("--mdn-tbg").trim(), acc: getComputedStyle(document.documentElement).getPropertyValue("--mdn-taccent").trim() }));
  ok(!light.dark && light.tbg !== dark.tbg && !!light.acc, "switching to lapis: light shell + theme accent", JSON.stringify(light));
  await page.selectOption("#theme-select", "mdnest");
  await page.waitForTimeout(500);
  ok(!(await page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue("--mdn-taccent").trim())), "default theme keeps the B indigo accent");
  await page.context().close();
}

// ---------- welcome ----------
{
  const page = await newPage(`?folder=${encodeURIComponent(WS)}&restore=0`);
  await page.evaluate(async (ws) => { for (const f of ["beta.md", "alpha.md"]) { await window.mdnest.openAt(ws + "/" + f); } await window.mdnest.runCommand("file.close"); }, WS);
  await page.waitForTimeout(800);
  const cards = await page.$$eval("#mdn-welcome .wel-file", (c) => c.map((x) => ({ t: x.querySelector(".wel-file-title").textContent.trim(), s: x.querySelector(".wel-file-snip").textContent.trim(), chip: x.querySelector(".wel-chip")?.textContent })));
  const a = cards.find((c) => c.t === "Alpha notes");
  ok(!!a && a.s.startsWith("The first paragraph of alpha with a link") && a.chip === "shellb-test", "welcome card: title, cleaned excerpt, folder chip", JSON.stringify(cards));
  ok(await page.locator("#mdn-welcome .wel-action").count() === 3 && await page.locator("#mdn-welcome .wel-tip").count() === 1, "welcome actions + tip");
  await page.locator("#mdn-welcome .wel-file", { hasText: "Beta" }).click();
  await page.waitForTimeout(400);
  ok(!(await page.locator("#mdn-welcome").isVisible()) && (await page.locator("#write h1").first().textContent()).includes("Beta"), "clicking a preview card opens it");
  await page.context().close();
}

ok(errors.length === 0, "no page errors", errors.join(" | "));
await browser.close();
fs.rmSync(WS, { recursive: true, force: true });
fs.rmSync(WS2, { recursive: true, force: true });
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
