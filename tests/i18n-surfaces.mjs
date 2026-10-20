// Untranslated-string sweep (zh-CN): opens every UI surface for real (clicks, keys, commands) and
// collects visible text, placeholders, titles, aria-labels and tooltips that are still English.
// Proper nouns, formats, key names, file/theme names and code are allowed (KEEP).
// Needs `npx vite build` + `vite preview` on :4173. Run: node tests/i18n-surfaces.mjs [base] [--list]
import fs from "node:fs";
import path from "node:path";
import { chromium } from "playwright";

const base = process.argv[2]?.startsWith("http") ? process.argv[2] : "http://127.0.0.1:4173/";
const LIST = process.argv.includes("--list");
const ROOT = path.resolve(process.env.WS_ROOT ?? "dev-data/workspace");
const WS = path.join(ROOT, "i18n-test");
fs.rmSync(WS, { recursive: true, force: true });
fs.mkdirSync(path.join(WS, "docs"), { recursive: true });
fs.writeFileSync(path.join(WS, "notes.md"), "# 标题\n\n正文 **粗体** [链接](http://x) 和 ![图](pic.png)\n\n| a | b |\n|---|---|\n| 1 | 2 |\n\n```js\nlet a = 1;\n```\n\n$$\nx^2\n$$\n\n<div>html</div>\n\n- [ ] 任务\n");
fs.writeFileSync(path.join(WS, "docs", "other.md"), "# 其他\n");

let fail = 0, pass = 0;
const ok = (c, m, info = "") => { console.log((c ? "PASS " : "FAIL ") + m + (c || !info ? "" : " — " + info)); c ? pass++ : fail++; };

// Allowed Latin text: brand/format/protocol names, key names, file & theme names, code, numbers.
const KEEP_WORDS = new Set(("MD Nest MDNest Markdown HTML PDF Word EPUB LaTeX RTF OPML YAML TOC UTF BOM GBK GB18030 Big5 Shift_JIS EUC KR LE BE LF CRLF " +
  "Pandoc pandoc Mermaid KaTeX MathJax GitHub GFM AI API URL OpenAI Ollama DeepSeek Grok xAI Claude Anthropic Gemini Kimi Qwen Moonshot Zhipu GLM " +
  "Ctrl Alt Shift Cmd Option Esc Enter Tab Space Del Backspace Home End PgUp PgDn F1 F2 F3 F5 F8 F9 F11 Win " +
  "Typora Drake Lapis Purple Vue Mdmdt GitHub Night Ayu Black Dark Light Google JB Juejin Material Vue3 Cesno Classic Green Plain Blue mdnest drake lapis purple vue mdmdt " +
  "js ts md png jpg svg html docx odt pdf tex rst org opml epub rtf txt " +
  "OpenOffice MediaWiki Textile reStructuredText Org mode Windows Linux macOS Unix JSON CSV SVG PNG JPEG KB MB GB ms px em pt " +
  "localhost http https www com cn x pic notes docs other i18n test Front Matter H1 H2 H3 H4 H5 H6 RSS ID OK Emoji emoji SQLite Rust JavaScript TypeScript Python " +
  // language switch: endonym "English" and the deliberately bilingual "语言 / Language" label
  "English Language").split(/\s+/));
const THEMES = fs.existsSync("dev-data/themes") ? fs.readdirSync("dev-data/themes").filter((f) => f.endsWith(".css")).map((f) => f.slice(0, -4).split("-").map((w) => w[0].toUpperCase() + w.slice(1)).join(" ")) : [];
const keepString = (s) => {
  s = s.replace(/^[✓✔•·]\s*/, "");
  if (/^(\/|\.\/|[A-Za-z]:\\)/.test(s)) return true; // paths
  if (/^((Ctrl|Alt|Shift|Cmd|Option|⌘|⌥|⇧)\+)+.{1,6}$/.test(s) || /^:[\w+-]+:$/.test(s) || THEMES.includes(s) || s === "Aa" || s === path.basename(WS)) return true;
  const words = s.match(/[A-Za-z][A-Za-z0-9_+#.-]*/g) ?? [];
  return words.every((w) => KEEP_WORDS.has(w) || KEEP_WORDS.has(w.replace(/[.:]+$/, "")) || /^[A-Z]$|^[a-z]$/.test(w) || /\.(md|png|css|html|docx|pdf|json)$/i.test(w) || /^(v?\d|#)/.test(w) || /^[A-Z0-9_-]{2,}$/.test(w) && w.length <= 5);
};
const SCAN = `(() => {
  const out = [];
  const vis = (el) => { if (!el || !el.getClientRects().length) return false; const cs = getComputedStyle(el); return cs.visibility !== "hidden" && cs.display !== "none" && +cs.opacity !== 0; };
  const skip = (el) => el.closest("#write") && !el.closest(".code-tooltip, .md-htmlblock-empty, .mdn-sug, .md-diagram-error") || el.closest("kbd, code, pre:not(.md-fences), .mdn-lang-item, .mdn-slash-item small, .file-node-title, .ph-ws-name, .mdn-recent-name, .mdn-recent-path, .mdn-welcome-file, .mdn-theme-name, .theme-name, [data-i18n-skip], .CodeMirror, .mdn-emoji-name, .mdn-ai-msg, .ai-msg-body, .mdn-lib-title, script, style");
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  for (let n; (n = walker.nextNode());) {
    const s = n.textContent.replace(/\\s+/g, " ").trim(); if (!s || !/[A-Za-z]{2}/.test(s)) continue;
    const el = n.parentElement; if (!el || skip(el) || !vis(el)) continue;
    out.push(s);
  }
  for (const el of document.querySelectorAll("[placeholder], [title], [aria-label], [data-tip], [data-tooltip]")) {
    if (skip(el) || !vis(el)) continue;
    for (const a of ["placeholder", "title", "aria-label", "data-tip", "data-tooltip"]) { const v = el.getAttribute(a); if (v && /[A-Za-z]{2}/.test(v)) out.push(v.trim()); }
  }
  return [...new Set(out)];
})()`;
const english = (list) => list.filter((s) => !/[\u4e00-\u9fff]/.test(s) && !keepString(s));

const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 1280, height: 860 }, locale: "zh-CN" });
await ctx.grantPermissions(["clipboard-read", "clipboard-write"]);
const page = await ctx.newPage();
const errors = []; page.on("pageerror", (e) => errors.push(e.message));
const dialogs = []; let dialogAccept = false;
page.on("dialog", (d) => { dialogs.push(d.message()); dialogAccept ? d.accept() : d.dismiss(); });
await page.goto(`${base}?lang=zh-CN&folder=${encodeURIComponent(WS)}&file=${encodeURIComponent(path.join(WS, "notes.md"))}`);
await page.waitForSelector("body.mdn-ready"); await page.waitForTimeout(500);
const all = new Map();
async function surface(name, open, close = async () => { await page.keyboard.press("Escape"); await page.waitForTimeout(120); }) {
  try { await open(); } catch (e) { ok(false, `${name}: opened`, e.message.split("\n")[0]); return; }
  await page.waitForTimeout(250);
  const bad = english(await page.evaluate(SCAN));
  for (const b of bad) all.set(b, (all.get(b) ?? []).concat(name));
  ok(bad.length === 0, `${name}: no untranslated text`, bad.slice(0, 25).join(" | "));
  try { await close(); } catch { /* ignore */ }
}
const run = (id) => page.evaluate((id) => window.mdnest.runCommand(id), id);
const ctxMenu = async (sel, last = false) => { const l = page.locator(sel); const r = await (last ? l.last() : l.first()).boundingBox(); await page.mouse.click(r.x + Math.min(20, r.width / 2), r.y + r.height / 2, { button: "right" }); };
const closeModal = async () => { await page.keyboard.press("Escape"); await page.waitForTimeout(100); await page.evaluate(() => document.querySelectorAll(".modal-backdrop, .mdn-modal, .context-menu").forEach((e) => e.remove())); };

await surface("main window + status bar", async () => {});
for (const id of ["files", "outline", "search", "p-word-stats", "settings", "p-ai", "p-library"]) {
  await surface(`side panel ${id}`, async () => { const b = page.locator(`.mdn-rail-btn[data-id="${id}"]`); if (await b.count()) await b.click(); else throw new Error("no rail button " + id); }, async () => {});
}
await page.locator('.mdn-rail-btn[data-id="files"]').click();
// rail tooltips (hover)
await surface("rail tooltips", async () => { await page.locator('.mdn-rail-btn[data-id="search"]').hover(); await page.waitForTimeout(600); }, async () => { await page.mouse.move(700, 400); });
// HTML menubar menus
const menus = await page.$$eval(".mdn-menubar [data-menu], .mdn-menubar .menu-title, #mdn-menubar > *", (els) => els.map((e, i) => i));
for (let i = 0; i < Math.min(menus.length, 8); i++) {
  await surface(`menubar menu #${i + 1}`, async () => { await page.locator(".mdn-menubar [data-menu], .mdn-menubar .menu-title, #mdn-menubar > *").nth(i).click(); }, async () => { await page.keyboard.press("Escape"); await page.keyboard.press("Escape"); });
}
await surface("file tree context menu", () => ctxMenu('.file-node-content:has-text("notes.md")'));
await surface("files header ⋯ menu", async () => { await page.locator(".mdn-head[data-for=files] .ph-more, .mdn-head[data-for=files] [data-act=more]").first().click(); });
await surface("workspace switcher", async () => { await page.locator("#sidebar-ws-switch").click(); });
await surface("editor context menu (text)", () => ctxMenu("#write p"));
await surface("editor context menu (table)", () => ctxMenu("#write td"));
await surface("editor context menu (link)", () => ctxMenu("#write a"));
await surface("editor context menu (image)", () => ctxMenu("#write img:not(.ProseMirror-separator)"));
await surface("editor context menu (heading)", () => ctxMenu("#write h1"));
await surface("editor context menu (task)", () => ctxMenu("#write li"));
await surface("status bar encoding menu", async () => { await page.locator("#footer-encoding").click(); });
await surface("status bar word count menu", async () => { await page.locator("#footer-word-count").click(); });
await surface("code block tools + language picker", async () => { await page.locator("#write .md-fences").hover(); await page.locator("#write .ty-cm-lang-input").click(); }, async () => { await page.keyboard.press("Escape"); });
await surface("slash menu", async () => { await page.locator("#write p").last().click(); await page.keyboard.press("End"); await page.keyboard.press("Enter"); await page.keyboard.type("/"); }, async () => { await page.keyboard.press("Escape"); await page.keyboard.press("Backspace"); await page.keyboard.press("Backspace"); });
await surface("slash menu no matches", async () => { await page.keyboard.press("Enter"); await page.keyboard.type("/zzzz"); }, async () => { await page.keyboard.press("Escape"); for (let i = 0; i < 6; i++) await page.keyboard.press("Backspace"); });
await surface("table dialog", () => run("paragraph.tableDialog"), closeModal);
await surface("find bar", () => run("edit.find"));
await surface("replace bar", () => run("edit.replace"));
await surface("quick open", () => run("file.quickOpen"));
await surface("command palette", () => run("view.palette"));
await surface("command palette search", async () => { await run("view.palette"); await page.keyboard.type("导出"); });
await surface("emoji picker", () => run("edit.emoji"));
await surface("link prompt", async () => { await page.locator("#write p").first().click(); await run("format.link"); }, closeModal);
await surface("about dialog", () => run("help.about"), closeModal);
await surface("shortcuts help", () => run("help.shortcuts"), closeModal);
await surface("delete dialog", async () => { await ctxMenu('.file-node-content:has-text("notes.md")', true); await page.locator('.context-menu .mdn-menu-item[data-id="delete"]').click(); }, async () => { await page.locator('.modal [data-c="no"]').click(); });
await surface("rename input", async () => { await ctxMenu('.file-node-content:has-text("notes.md")', true); await page.locator('.context-menu .mdn-menu-item[data-id="rename"]').click(); });
await surface("unsaved changes dialog", async () => { await page.locator("#write p").first().click(); await page.keyboard.type("改"); await page.evaluate(() => { void window.mdnest.guard("closing"); }); }, closeModal);
await surface("export pandoc (missing pandoc)", async () => { await page.evaluate(() => { window.mdnest.host.pandocInfo = async () => ({ found: false, version: "", path: "" }); }); await run("file.exportPandoc.epub"); }, closeModal);
await surface("settings: all sections", async () => { await run("view.settings"); await page.waitForTimeout(200); await page.evaluate(() => { const p = document.querySelector(".mdn-settings, #settings-panel, [data-for=settings]"); p?.scrollTo?.(0, 99999); }); });
await surface("AI panel", async () => { await page.locator('.mdn-rail-btn[data-id="p-ai"]').click(); });
await surface("AI settings + privacy note + error message", async () => {
  await run("view.settings"); await page.waitForTimeout(200);
  const set = (k) => page.locator(`.mdn-settings [data-o="ai"][data-k="${k}"]`);
  await set("preset").selectOption("custom"); await page.waitForTimeout(80);
  await set("baseUrl").fill("http://127.0.0.1:9/v1"); await set("baseUrl").dispatchEvent("change");
  await set("model").fill("m"); await set("model").dispatchEvent("change");
  dialogAccept = true; if (!(await set("enabled").isChecked())) await set("enabled").click(); await page.waitForTimeout(200); dialogAccept = false;
  await page.locator('.mdn-rail-btn[data-id="p-ai"]').click();
  const inp = page.locator(".mdn-ai-input").first();
  await inp.click(); await inp.type("你好"); await page.keyboard.press("Enter"); await page.waitForTimeout(1500);
  const err = (await page.locator(".mdn-ai-msg.mdn-ai-assistant").last().textContent().catch(() => "")) ?? "";
  ok(/[\u4e00-\u9fff]/.test(err) && !/cannot reach|request failed|Failed to fetch/i.test(err), "AI connection error shown in Chinese", err.slice(0, 120));
  await page.screenshot({ path: "screenshots/fixes-0.2.1/bug10-after-ai-error-zh.png" });
});
await surface("library panel", async () => { await page.locator('.mdn-rail-btn[data-id="p-library"]').click(); });
await surface("welcome page", async () => { await run("file.close"); await page.waitForTimeout(300); await page.evaluate(() => document.querySelectorAll(".modal-backdrop").forEach((b) => b.querySelector('[data-c="discard"], [data-c="no"], .btn:not(.btn-primary)')?.click())); await page.waitForTimeout(300); });
// toasts produced by common actions
const toasts = [];
await page.evaluate(() => { const t = document.querySelector(".mdn-toast, #toast, .toast"); if (!t) return; new MutationObserver(() => window.__toasts = (window.__toasts || []).concat(t.textContent)).observe(t, { childList: true, characterData: true, subtree: true }); });
for (const id of ["edit.emojiToggle", "edit.emojiToggle", "edit.smartPunct", "edit.smartPunct", "view.readonly", "view.readonly", "edit.copyMarkdown", "file.save"]) { await run(id).catch(() => {}); await page.waitForTimeout(150); }
toasts.push(...(await page.evaluate(() => window.__toasts || [])));
const badToasts = english([...new Set(toasts)]);
const badDialogs = english([...new Set(dialogs)]);
ok(badDialogs.length === 0, "native confirm/prompt texts translated", badDialogs.join(" | "));
ok(badToasts.length === 0, "toasts from common commands translated", badToasts.join(" | "));
ok(errors.length === 0, "no page errors", errors.join(" | "));
if (LIST) { console.log("\n--- untranslated ---"); for (const [s, where] of [...all].sort()) console.log(JSON.stringify(s), "  ←", [...new Set(where)].join(", ")); }
await browser.close();
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
