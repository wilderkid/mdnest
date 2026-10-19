// Part A parity (0.1.2): editing and UI. Playwright against the browser host.
// Usage: node tests/parity-012.mjs [baseUrl]
// The suite creates and removes its own temp document. It does not touch other workspace files.
import { chromium } from "playwright";
import fs from "node:fs";
import path from "node:path";

const base = process.argv[2] ?? "http://127.0.0.1:4173/";
const OUT = path.resolve("screenshots/parity-0.1.2");
fs.mkdirSync(OUT, { recursive: true });

// Inside the browser-host sandbox (dev-data). Removed in finally, including any .trash copy.
const TMP = path.resolve("dev-data/workspace/.tmp-parity-012");
const DOC = path.join(TMP, "parity-012.md");
fs.rmSync(TMP, { recursive: true, force: true });
fs.mkdirSync(TMP, { recursive: true });
fs.writeFileSync(DOC, "# Title\n\nA paragraph with a word.\n");

const results = [];
const ok = (c, name, info = "") => {
  const line = (c ? "PASS " : "FAIL ") + name + (info ? " — " + String(info).slice(0, 220) : "");
  console.log(line);
  results.push({ pass: !!c, name });
};

let browser;
try {
  browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1280, height: 860 } });
  page.setDefaultTimeout(8000);
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  const md = () => page.evaluate(() => window.mdnest.editor.getMarkdown());
  const run = (id) => page.evaluate((id) => window.mdnest.runCommand(id), id);
  const setMd = async (text) => {
    await page.evaluate((text) => window.mdnest.editor.setMarkdown(text), text);
    await page.waitForTimeout(80);
  };

  await page.goto(base + `?theme=mdnest&file=${encodeURIComponent(DOC)}&folder=${encodeURIComponent(TMP)}&menubar=html&restore=0`);
  await page.evaluate(() => localStorage.removeItem("mdnest.autosave"));
  await page.waitForSelector("body.mdn-ready");
  await page.waitForSelector("#mdn-menubar");
  await page.waitForTimeout(300);

  // ---------- A1: Ctrl+K is Hyperlink even with AI on; Rewrite is Ctrl+J ----------
  await page.evaluate(() => {
    localStorage.setItem("mdnest.plugin.ai.enabled", JSON.stringify(true));
    localStorage.setItem("mdnest.plugin.ai.privacyAck", JSON.stringify(true));
    localStorage.setItem("mdnest.plugin.ai.rewriteShortcut", JSON.stringify("Mod-j"));
  });
  await page.reload();
  await page.waitForSelector("body.mdn-ready");
  await page.waitForTimeout(300);
  await setMd("linkme\n");
  await page.locator("#write").click();
  await page.keyboard.press("Control+a");
  await page.keyboard.press("Control+k");
  await page.waitForSelector(".mdn-prompt input", { timeout: 4000 });
  ok(await page.locator(".mdn-prompt input").isVisible(), "A1 Ctrl+K opens the link prompt with AI on");
  await page.locator(".mdn-prompt input").fill("https://example.com/a1");
  await page.keyboard.press("Enter");
  await page.waitForTimeout(120);
  ok((await md()).includes("](https://example.com/a1)") || (await md()).includes("[linkme](https://example.com/a1)"), "A1 Ctrl+K inserts a hyperlink", await md());

  // Settings page shows the rewrite shortcut field (default Mod-j).
  await page.evaluate(() => { document.body.classList.add("pin-outline"); window.mdnest.sidebar.select("settings"); });
  await page.waitForTimeout(150);
  const setting = page.locator("#sidebar-content label", { hasText: "Rewrite shortcut" }).locator("input");
  ok(await setting.inputValue() === "Mod-j", "A1 settings show Rewrite shortcut", await setting.inputValue().catch(() => ""));
  await page.screenshot({ path: path.join(OUT, "ai-shortcut-setting.png") });
  await page.evaluate(() => window.mdnest.sidebar.select("files"));

  const accel = await page.evaluate(() => {
    const link = window.mdnest.commands.find((c) => c.id === "format.link");
    const rewrite = window.mdnest.commands.find((c) => c.id === "ai.rewrite" || c.id === "rewrite");
    return { link: link && link.key, rewrite: rewrite && rewrite.key };
  });
  ok(accel.link === "CmdOrCtrl+K", "A1 Hyperlink keeps CmdOrCtrl+K", JSON.stringify(accel));
  ok(accel.rewrite === "Mod-j", "A1 Rewrite default is Mod-j", JSON.stringify(accel));

  await page.locator('#mdn-menubar .mdn-menu[data-menu="format"] > .mdn-menu-label').click();
  const linkAccel = await page.locator('#mdn-menubar button[data-id="format.link"] .mdn-menu-accel').innerText();
  ok(/Ctrl\+K|⌘K/.test(linkAccel), "A1 Format menu shows Ctrl+K on Hyperlink", linkAccel);
  await page.keyboard.press("Escape");

  // Custom rewrite key: Alt-Shift-j. The palette shows the active key. Empty disables it.
  await page.evaluate(() => window.mdnest.plugins.commitSetting("ai", "rewriteShortcut", "Alt-Shift-j"));
  await page.waitForTimeout(80);
  const custom = await page.evaluate(() => {
    const rewrite = window.mdnest.commands.find((c) => c.id === "ai.rewrite" || c.id === "rewrite");
    return rewrite ? rewrite.key : null;
  });
  ok(custom === "Alt-Shift-j", "A1 custom rewrite shortcut is the active key", String(custom));

  await page.keyboard.press("Control+Shift+p");
  await page.waitForSelector("#mdn-palette input");
  await page.locator("#mdn-palette input").fill("Rewrite");
  await page.waitForTimeout(80);
  const pal = await page.locator("#mdn-palette .pal-item").first().innerText();
  ok(/Alt\+Shift\+J/i.test(pal), "A1 palette shows the active rewrite key", pal);
  await page.keyboard.press("Escape");

  // Ctrl+J no longer opens rewrite after the custom key; Ctrl+K still opens the link prompt.
  await setMd("again\n");
  await page.locator("#write").click();
  await page.keyboard.press("Control+a");
  await page.keyboard.press("Control+j");
  await page.waitForTimeout(200);
  ok(!(await page.locator(".mdn-prompt input").count()), "A1 Ctrl+J does not open rewrite when the shortcut is custom");
  await page.keyboard.press("Control+k");
  await page.waitForSelector(".mdn-prompt input", { timeout: 4000 });
  ok(await page.locator(".mdn-prompt").isVisible(), "A1 Ctrl+K still opens the link prompt after a custom rewrite key");
  await page.keyboard.press("Escape");

  // ---------- A2: editor context-menu submenus open beside the parent ----------
  await setMd("Context menu paragraph.\n");
  await page.locator("#write").click();
  const box = await page.locator("#write").boundingBox();
  await page.mouse.click(box.x + 40, box.y + 30, { button: "right" });
  await page.waitForSelector(".context-menu");
  const parentCount = () => page.locator("body > .context-menu").count();
  ok(await parentCount() === 1, "A2 one context menu opens");
  const para = page.locator(".context-menu button[data-id='paragraph']");
  await para.hover();
  await page.waitForTimeout(80);
  ok(await parentCount() === 2, "A2 hover opens a submenu beside the parent", String(await parentCount()));
  const parentBox = await page.locator("body > .context-menu").first().boundingBox();
  const subBox = await page.locator("body > .context-menu.mdn-submenu").boundingBox();
  ok(!!parentBox && !!subBox && subBox.x >= parentBox.x + parentBox.width - 12, "A2 submenu sits to the right of the parent", JSON.stringify({ parentBox, subBox }));
  ok(await page.locator("body > .context-menu").first().locator("button[data-id='paragraph']").count() === 1, "A2 parent stays open");
  await page.screenshot({ path: path.join(OUT, "context-submenu.png") });
  await page.keyboard.press("Enter");
  await page.waitForTimeout(100);
  ok((await md()).startsWith("# Context"), "A2 Enter on Heading 1 applies it", await md());

  // ArrowRight opens, Escape closes the submenu first, then the menu.
  await page.mouse.click(box.x + 40, box.y + 40, { button: "right" });
  await page.waitForSelector(".context-menu");
  for (let i = 0; i < 8; i++) {
    const id = await page.evaluate(() => document.querySelector(".context-menu .mdn-menu-active")?.getAttribute("data-id"));
    if (id === "format") break;
    await page.keyboard.press("ArrowDown");
  }
  await page.keyboard.press("ArrowRight");
  await page.waitForTimeout(60);
  ok(await page.locator(".context-menu.mdn-submenu button[data-id='format.strong']").count() === 1, "A2 ArrowRight opens Format");
  await page.keyboard.press("Escape");
  await page.waitForTimeout(40);
  ok(await page.locator(".context-menu.mdn-submenu").count() === 0 && await page.locator(".context-menu").count() === 1, "A2 Escape closes the submenu, parent stays");
  await page.keyboard.press("Escape");
  await page.waitForTimeout(40);
  ok(await page.locator(".context-menu").count() === 0, "A2 second Escape closes the menu");

  // Flip left when the menu is opened near the right edge (dispatch so the hit stays on #write).
  await page.evaluate(() => {
    const el = document.querySelector("#write");
    el.dispatchEvent(new MouseEvent("contextmenu", {
      bubbles: true, cancelable: true, clientX: window.innerWidth - 16, clientY: 180, button: 2,
    }));
  });
  await page.waitForSelector(".context-menu");
  for (let i = 0; i < 12; i++) {
    const id = await page.evaluate(() => document.querySelector("body > .context-menu .mdn-menu-active")?.getAttribute("data-id"));
    if (id === "insert") break;
    await page.keyboard.press("ArrowDown");
  }
  await page.keyboard.press("ArrowRight");
  await page.waitForTimeout(80);
  const edgeParent = await page.locator("body > .context-menu").first().boundingBox();
  const edgeSub = await page.locator(".context-menu.mdn-submenu").boundingBox();
  ok(!!edgeParent && !!edgeSub && edgeSub.x + edgeSub.width <= edgeParent.x + 8, "A2 submenu flips left near the window edge", JSON.stringify({ edgeParent, edgeSub }));
  await page.keyboard.press("Escape");
  await page.keyboard.press("Escape");

  // ---------- A3: Window menu ----------
  await page.locator('#mdn-menubar .mdn-menu[data-menu="window"] > .mdn-menu-label').click();
  await page.waitForTimeout(80);
  const winItems = await page.locator('#mdn-menubar .mdn-menu[data-menu="window"] .dropdown-menu button').allTextContents();
  const joined = winItems.join(" | ");
  ok(winItems.some((t) => /Minimize/.test(t)), "A3 Window menu has Minimize", joined);
  ok(winItems.some((t) => /Maximize|Restore|Zoom/.test(t)), "A3 Window menu has Maximize/Restore", joined);
  ok(winItems.some((t) => /Always on Top/.test(t)), "A3 Window menu has Always on Top", joined);
  ok(winItems.some((t) => /Full Screen/.test(t)), "A3 Window menu has Full Screen", joined);
  ok(winItems.some((t) => /MD Nest|browser|parity/.test(t)), "A3 Window menu lists this window", joined);
  await page.screenshot({ path: path.join(OUT, "window-menu.png") });
  await page.keyboard.press("Escape");
  // View still has the alias.
  await page.locator('#mdn-menubar .mdn-menu[data-menu="view"] > .mdn-menu-label').click();
  ok(await page.locator('#mdn-menubar button[data-id="view.alwaysOnTop"]').count() === 1, "A3 View keeps Always on Top alias");
  await page.keyboard.press("Escape");
  await run("window.maximize");
  await page.waitForTimeout(80);
  const note = await page.locator("#mdn-toast").innerText();
  ok(/Maximize|Restore|Zoom/.test(note), "A3 Maximize runs in the browser host", note);
  const minAccel = await page.evaluate(() => window.mdnest.commands.find((c) => c.id === "window.minimize")?.key);
  ok(minAccel === "CmdOrCtrl+M", "A3 Minimize is Ctrl+M", String(minAccel));

  ok(errors.length === 0, "no page errors", errors.join(" | "));
} catch (e) {
  ok(false, "EXCEPTION", e?.message ?? e);
} finally {
  if (browser) await browser.close().catch(() => {});
  fs.rmSync(TMP, { recursive: true, force: true });
  const trash = path.resolve("dev-data/.trash");
  if (fs.existsSync(trash)) {
    for (const name of fs.readdirSync(trash)) {
      if (name.includes("parity-012") || name.includes(".tmp-parity-012")) fs.rmSync(path.join(trash, name), { recursive: true, force: true });
    }
  }
}

const failed = results.filter((r) => !r.pass).length;
console.log(`\n${results.length - failed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
