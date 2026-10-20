// Part 2 parity: file commands, welcome, quick open, dirty guard, sidebar chrome.
// Works on a temporary folder under dev-data/workspace and removes it at the end.
// Usage: node tests/parity-files.mjs [baseUrl]
import { chromium } from "playwright";
import fs from "node:fs";
import path from "node:path";

const base = process.argv[2] ?? "http://127.0.0.1:4173/";
const WS = path.resolve("dev-data/workspace");
const OUT = path.resolve("screenshots/parity");
fs.mkdirSync(OUT, { recursive: true });
const TMP = path.join(WS, ".parity-tmp-" + Date.now().toString(36));
fs.mkdirSync(TMP, { recursive: true });
fs.writeFileSync(path.join(TMP, "alpha.md"), "---\ntitle: Alpha\n---\n\n# Alpha heading\n\nA unique-needle-phrase lives here.\n");
fs.writeFileSync(path.join(TMP, "beta.md"), "# Beta\n\nSecond note.\n");
fs.mkdirSync(path.join(TMP, "nested"), { recursive: true });
fs.writeFileSync(path.join(TMP, "nested", "gamma.md"), "# Gamma\n\nNested file.\n");

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
page.on("dialog", (d) => d.accept(d.defaultValue() || TMP));
const md = () => page.evaluate(() => window.mdnest.editor.getMarkdown());

function cleanup() {
  fs.rmSync(TMP, { recursive: true, force: true });
  const stray = path.join(WS, "parity.md");
  if (fs.existsSync(stray)) fs.rmSync(stray, { force: true });
}

try {
  // Welcome page (fresh / no restore)
  await page.goto(base + "?restore=0&menubar=html&theme=mdnest");
  await page.evaluate(() => { localStorage.removeItem("mdnest.autosave"); localStorage.setItem("mdnest.reopenLast", "0"); });
  await page.waitForSelector("body.mdn-ready");
  await page.waitForSelector("#mdn-welcome");
  const welcomeText = await page.locator("#mdn-welcome .wel-sub").innerText();
  ok(welcomeText.includes("MD Nest") && /start writing today/.test(await page.locator("#mdn-welcome h1").innerText()), "welcome page #mdn-welcome", welcomeText);
  ok(await page.locator("#mdn-welcome button", { hasText: "New File" }).count() === 1, "welcome New File button");
  ok(await page.locator("#mdn-welcome button", { hasText: "Open File…" }).count() === 1, "welcome Open File button");
  ok(await page.locator("#mdn-welcome button", { hasText: "Open Folder…" }).count() === 1, "welcome Open Folder button");
  await page.screenshot({ path: path.join(OUT, "welcome.png") });
  await page.screenshot({ path: path.join(OUT, "open-folder-flow-1-welcome.png") });

  // Simulate the folder picker (browser host uses prompt; we call the same path the button uses).
  await page.evaluate(async (folder) => { await window.mdnest.sidebar.openFolder(folder); }, TMP);
  await page.waitForTimeout(300);
  ok(await page.locator("#file-library-tree .file-library-file").count() >= 2, "open folder shows files", String(await page.locator("#file-library-tree .file-node-title").allTextContents()));
  await page.screenshot({ path: path.join(OUT, "open-folder-flow-2-tree.png") });
  await page.screenshot({ path: path.join(OUT, "file-tree-toolbar.png") });

  // List view
  await page.evaluate(() => window.mdnest.runCommand("view.articles"));
  await page.waitForTimeout(400);
  ok(await page.locator("#file-library-list .file-list-item").count() >= 2, "list view items");
  ok(await page.locator("#file-library-list .file-list-item-summary").count() >= 1, "list excerpt");
  ok(await page.locator("#file-library-list .file-list-item-time").count() >= 1, "list time");
  ok(await page.locator("#file-library-list .file-list-item-parent-loc").count() >= 1, "list parent");
  const excerpt = await page.locator("#file-library-list .file-list-item-summary").first().innerText();
  ok(!excerpt.includes("title:"), "excerpt skips front matter", excerpt.slice(0, 80));
  await page.screenshot({ path: path.join(OUT, "file-list.png") });

  // Tree again + context menu
  await page.evaluate(() => window.mdnest.runCommand("view.fileTree"));
  await page.waitForTimeout(200);
  const node = page.locator("#file-library-tree .file-library-file", { hasText: "alpha.md" }).first();
  await node.click({ button: "right" });
  await page.waitForSelector(".context-menu");
  const labels = await page.locator(".context-menu button").allTextContents();
  ok(labels.includes("Open") && labels.includes("Rename") && labels.includes("Duplicate") && labels.includes("Delete"), "file context menu items", labels.join("|"));
  ok(labels.some((l) => /Reveal in Explorer|Reveal in Finder|Open Containing Folder/.test(l)), "reveal label matches OS", labels.join("|"));
  await page.screenshot({ path: path.join(OUT, "sidebar-context-menu.png") });
  await page.keyboard.press("Escape");

  // Blank-area context menu
  await page.locator("#file-library-tree").click({ button: "right", position: { x: 8, y: 8 } });
  await page.waitForSelector(".context-menu");
  const blank = await page.locator(".context-menu button").allTextContents();
  ok(blank.includes("New File") && blank.includes("New Folder") && blank.includes("Refresh"), "blank context menu", blank.join("|"));
  await page.keyboard.press("Escape");
  await page.evaluate(() => document.querySelectorAll(".context-menu").forEach((e) => e.remove()));

  // Search: content hit opens at line
  await page.evaluate(() => window.mdnest.runCommand("view.searchFolder"));
  await page.fill("#file-library-search-input", "unique-needle-phrase");
  await page.waitForTimeout(400);
  ok(await page.locator("#file-library-search-result .typora-search-item").count() >= 1, "content search hit");
  await page.screenshot({ path: path.join(OUT, "sidebar-search.png") });
  await page.locator("#file-library-search-result .typora-search-item").first().click();
  await page.waitForTimeout(300);
  const opened = await page.evaluate(() => window.mdnest.state.path);
  ok(String(opened).endsWith("alpha.md"), "search click opens file", opened);

  // Quick open
  await page.keyboard.press("Control+p");
  await page.waitForSelector("#typora-quick-open");
  await page.fill("#typora-quick-open-input", "beta");
  await page.waitForTimeout(150);
  ok(await page.locator(".typora-quick-open-item").count() >= 1, "quick open matches");
  await page.screenshot({ path: path.join(OUT, "quick-open.png") });
  await page.keyboard.press("Enter");
  await page.waitForTimeout(250);
  ok(String(await page.evaluate(() => window.mdnest.state.path)).endsWith("beta.md"), "quick open Enter opens beta");

  // New file (Ctrl+N) when clean
  await page.keyboard.press("Control+n");
  await page.waitForTimeout(200);
  ok(await page.evaluate(() => window.mdnest.state.path) === null, "Ctrl+N untitled");
  ok(await page.locator("#mdn-welcome").isHidden(), "typing/new dismisses welcome");

  // Dirty guard on Open
  await page.locator("#write").click();
  await page.keyboard.type("unsaved sentence");
  await page.waitForTimeout(250);
  await page.evaluate(() => window.mdnest.runCommand("file.open"));
  await page.waitForSelector(".modal");
  ok(await page.locator(".modal button", { hasText: "Don't Save" }).count() === 1, "dirty modal buttons");
  await page.screenshot({ path: path.join(OUT, "unsaved-modal.png") });
  await page.locator(".modal button", { hasText: "Cancel" }).click();
  ok(await page.evaluate(() => window.mdnest.state.dirty), "cancel keeps dirty doc");

  // Save the untitled doc into the temp folder via the host (no prompt race), then rename / duplicate / trash.
  const saved = path.join(TMP, "saved.md");
  await page.evaluate(async (p) => {
    const md = window.mdnest.editor.getMarkdown();
    await window.mdnest.host.writeFile(p, md);
    window.mdnest.state.path = p;
    window.mdnest.state.lastSaved = md;
    window.mdnest.state.dirty = false;
  }, saved);
  await page.evaluate((p) => window.mdnest.host.renamePath(p, p.replace(/saved\.md$/, "renamed.md")), saved);
  ok(fs.existsSync(path.join(TMP, "renamed.md")), "rename_path");
  const dup = await page.evaluate((p) => window.mdnest.host.duplicatePath(p), path.join(TMP, "renamed.md"));
  ok(String(dup).includes("copy"), "duplicate_path unique name", dup);
  ok(fs.existsSync(dup), "duplicate file exists");
  await page.evaluate((p) => window.mdnest.host.trashPath(p), dup);
  ok(!fs.existsSync(dup), "trash_path removes from workspace");

  // Inline rename through the sidebar
  await page.evaluate(async (folder) => {
    const input = document.querySelector("#file-library-search-input");
    if (input) { input.value = ""; input.dispatchEvent(new Event("input")); }
    await window.mdnest.sidebar.openFolder(folder);
    window.mdnest.sidebar.setView("tree");
    await window.mdnest.sidebar.refresh();
  }, TMP);
  await page.waitForTimeout(300);
  const beta = page.locator("#file-library-tree .file-library-file", { hasText: "beta.md" }).first();
  await beta.click({ button: "right" });
  await page.locator(".context-menu button", { hasText: "Rename" }).click();
  await page.waitForSelector(".file-node-rename");
  await page.screenshot({ path: path.join(OUT, "rename-inline.png") });
  await page.fill(".file-node-rename", "beta-renamed.md");
  await page.keyboard.press("Enter");
  await page.waitForTimeout(300);
  ok(fs.existsSync(path.join(TMP, "beta-renamed.md")), "inline rename");

  // New file from the footer
  await page.locator(".mdn-head[data-for=files] .ph-btn[title='New File']").click();
  await page.waitForTimeout(200);
  await page.keyboard.press("Escape");
  await page.waitForTimeout(200);
  ok(fs.readdirSync(TMP).some((n) => n.startsWith("Untitled") && n.endsWith(".md")), "footer new file", fs.readdirSync(TMP).join(","));

  // New folder
  await page.locator(".mdn-head[data-for=files] .ph-btn[title='New Folder']").click();
  await page.waitForTimeout(200);
  await page.keyboard.press("Escape");
  await page.waitForTimeout(200);
  ok(fs.readdirSync(TMP).some((n) => n.startsWith("Untitled folder")), "footer new folder");

  // Sort persists
  await page.locator("#sidebar-sort-btn").click();
  await page.locator(".context-menu button", { hasText: "Modified" }).click();
  await page.waitForTimeout(150);
  const sort = await page.evaluate(() => localStorage.getItem("mdnest.sidebarSort"));
  ok(String(sort).includes("modified"), "sort persisted", sort);

  // Keyboard nav
  await page.locator("#file-library-tree").focus();
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("ArrowDown");
  const sel = await page.evaluate(() => document.querySelector("#file-library-tree .file-library-node.selected")?.dataset.path ?? "");
  ok(!!sel, "arrow selects a node", sel);

  // Outline highlight
  await page.evaluate(() => window.mdnest.runCommand("file.revealSidebar")).catch(() => {});
  await page.evaluate(async (p) => {
    const text = await window.mdnest.host.readFile(p);
    window.mdnest.editor.setMarkdown(text);
    window.mdnest.sidebar.updateOutline(window.mdnest.editor.view);
  }, path.join(TMP, "alpha.md"));
  await page.evaluate(() => window.mdnest.runCommand("view.outline"));
  await page.locator("#write h1").first().click();
  await page.waitForTimeout(250);
  ok(await page.locator("#outline-content .outline-item-active").count() >= 1, "outline current heading");

  // Export HTML without styles
  const plain = await page.evaluate(async () => window.mdnest.exportHtmlString(false, false));
  ok(!String(plain).includes("mdnest-theme") && !String(plain).includes("#mdn-welcome"), "export HTML without styles omits theme and welcome", String(plain).slice(0, 120));

  // Print command exists and does not throw synchronously (iframe print)
  const printed = await page.evaluate(() => {
    const orig = window.print;
    let n = 0;
    window.print = () => { n++; };
    const iframePrint = HTMLIFrameElement.prototype; // print is on contentWindow
    return window.mdnest.commands.some((c) => c.id === "file.print");
  });
  ok(printed, "print command registered");

  // Reopen closed + clear recent
  await page.evaluate((p) => { localStorage.setItem("mdnest.recent", JSON.stringify([p])); }, path.join(TMP, "alpha.md"));
  await page.evaluate(() => window.mdnest.runCommand("file.clearRecent"));
  const cleared = await page.evaluate(() => JSON.parse(localStorage.getItem("mdnest.recent") || "[]"));
  ok(cleared.length === 0, "clear recent");

  // Close (browser host closes the document, shows welcome)
  await page.evaluate(async (p) => {
    const text = await window.mdnest.host.readFile(p);
    window.mdnest.editor.setMarkdown(text);
    window.mdnest.state.path = p;
    window.mdnest.state.lastSaved = text;
    window.mdnest.state.dirty = false;
  }, path.join(TMP, "alpha.md"));
  await page.evaluate(() => window.mdnest.runCommand("file.close"));
  await page.waitForTimeout(200);
  ok(await page.locator("#mdn-welcome").isVisible(), "close shows welcome");
  await page.evaluate(() => window.mdnest.runCommand("file.reopenClosed"));
  await page.waitForTimeout(300);
  ok(String(await page.evaluate(() => window.mdnest.state.path)).endsWith("alpha.md"), "reopen closed file");

  // Drop a folder / md via uri-list
  const drop = await page.evaluate(async ({ folder, file }) => {
    const a = await window.mdnest.handleNativeDrop({ paths: [folder] });
    const dt = new DataTransfer();
    dt.setData("text/uri-list", "file://" + file + "\n");
    document.dispatchEvent(new DragEvent("drop", { bubbles: true, cancelable: true, dataTransfer: dt }));
    await new Promise((r) => setTimeout(r, 200));
    return { a, path: window.mdnest.state.path };
  }, { folder: TMP, file: path.join(TMP, "alpha.md") });
  ok(drop.a === "folder" && String(drop.path).endsWith("alpha.md"), "drop folder and uri-list md", JSON.stringify(drop));

  // Open recent submenu contains Clear Items
  await page.evaluate((p) => localStorage.setItem("mdnest.recent", JSON.stringify([p])), path.join(TMP, "alpha.md"));
  await page.evaluate(() => window.mdnest.refreshMenu());
  await page.waitForTimeout(200);
  await page.locator('#mdn-menubar .mdn-menu[data-menu="file"] > .mdn-menu-label').click();
  const recentLabel = await page.locator("#mdn-menubar").getByText("Open Recent").count();
  ok(recentLabel >= 1, "Open Recent submenu");
  await page.locator("#mdn-menubar").getByText("Open Recent").hover();
  await page.waitForTimeout(150);
  ok(await page.locator("#mdn-menubar").getByText("Clear Items").count() >= 1, "Clear Items in Open Recent");

  ok(errors.length === 0, "no page errors", errors.join(" | "));
} catch (e) {
  ok(false, "exception", e.message || String(e));
} finally {
  await browser.close().catch(() => {});
  cleanup();
}

const failed = results.filter((r) => !r.pass).length;
console.log(`\n${results.length - failed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
