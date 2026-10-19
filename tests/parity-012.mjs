// Part A parity (0.1.2): editing and UI. Playwright against the browser host.
// Usage: node tests/parity-012.mjs [baseUrl]
// The suite creates and removes its own temp document. It does not touch other workspace files.
import { chromium } from "playwright";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const base = process.argv[2] ?? "http://127.0.0.1:4173/";
const OUT = path.resolve("screenshots/parity-0.1.2");
fs.mkdirSync(OUT, { recursive: true });

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "mdnest-parity-012-"));
const DOC = path.join(TMP, "parity-012.md");
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

  ok(errors.length === 0, "no page errors", errors.join(" | "));
} catch (e) {
  ok(false, "EXCEPTION", e?.message ?? e);
} finally {
  if (browser) await browser.close().catch(() => {});
  fs.rmSync(TMP, { recursive: true, force: true });
}

const failed = results.filter((r) => !r.pass).length;
console.log(`\n${results.length - failed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
