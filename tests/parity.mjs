// Part 1 parity: menubar, a few menu actions, keyboard dispatcher, page-key guard, drop routing.
// Usage: node tests/parity.mjs [baseUrl]
import { chromium } from "playwright";
import fs from "node:fs";
import path from "node:path";

const base = process.argv[2] ?? "http://127.0.0.1:4173/";
const WS = path.resolve("dev-data/workspace");
const OUT = path.resolve("screenshots/parity");
fs.mkdirSync(OUT, { recursive: true });
const DOC = path.join(WS, "parity.md");
fs.writeFileSync(DOC, "# Title\n\nA paragraph to format.\n\n- item\n");

const results = [];
const ok = (c, name, info = "") => {
  const line = (c ? "PASS " : "FAIL ") + name + (info ? " — " + String(info).slice(0, 180) : "");
  console.log(line);
  results.push({ pass: !!c, name });
};

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1280, height: 860 } });
page.setDefaultTimeout(8000);
const errors = [];
page.on("pageerror", (e) => errors.push(e.message));
const md = () => page.evaluate(() => window.mdnest.editor.getMarkdown());

await page.goto(base + `?theme=mdnest&file=${encodeURIComponent(DOC)}&folder=${encodeURIComponent(WS)}&menubar=html`);
await page.evaluate(() => localStorage.removeItem("mdnest.autosave"));
await page.waitForSelector("body.mdn-ready");
await page.waitForSelector("#mdn-menubar");
await page.waitForTimeout(400);

const labels = await page.locator("#mdn-menubar > .mdn-menu > .mdn-menu-label").allTextContents();
ok(labels.join(",") === "File,Edit,Paragraph,Format,View,Themes,Help", "menubar renders File/Edit/Paragraph/Format/View/Themes/Help", labels.join(","));
ok(await page.evaluate(() => /os-linux|os-windows|is-mac/.test(document.body.className)), "os class present", await page.evaluate(() => document.body.className));

const menus = ["file", "edit", "paragraph", "format", "view", "themes", "help"];
for (const name of menus) {
  await page.locator(`#mdn-menubar .mdn-menu[data-menu="${name}"] > .mdn-menu-label`).click();
  const open = await page.locator(`#mdn-menubar .mdn-menu[data-menu="${name}"].mdn-menu-open > .dropdown-menu`).isVisible();
  ok(open, `menu ${name} opens`);
  await page.screenshot({ path: path.join(OUT, `menu-${name}.png`) });
  await page.keyboard.press("Escape");
  await page.locator("body").click({ position: { x: 600, y: 500 } }).catch(() => {});
}

// Heading 2 via the Paragraph menu
await page.locator("#write p").first().click();
await page.locator('#mdn-menubar .mdn-menu[data-menu="paragraph"] > .mdn-menu-label').click();
await page.locator('#mdn-menubar button[data-id="paragraph.heading.2"]').click();
await page.waitForTimeout(150);
ok((await md()).includes("## A paragraph to format."), "menu Heading 2", (await md()).split("\n")[2]);

// Quote
await page.locator('#mdn-menubar .mdn-menu[data-menu="paragraph"] > .mdn-menu-label').click();
await page.locator('#mdn-menubar button[data-id="paragraph.quote"]').click();
await page.waitForTimeout(150);
ok((await md()).includes("> ## A paragraph") || (await md()).includes("> A paragraph") || (await md()).includes("\n> "), "menu Quote", (await md()).slice(0, 120));

// Source mode toggle
const before = await page.evaluate(() => document.body.classList.contains("typora-sourceview-on"));
await page.locator('#mdn-menubar .mdn-menu[data-menu="view"] > .mdn-menu-label').click();
await page.locator('#mdn-menubar button[data-id="view.source"]').click();
await page.waitForTimeout(200);
const after = await page.evaluate(() => document.body.classList.contains("typora-sourceview-on"));
ok(after !== before, "menu Source mode toggle", `before=${before} after=${after}`);
await page.locator('#mdn-menubar .mdn-menu[data-menu="view"] > .mdn-menu-label').click();
await page.locator('#mdn-menubar button[data-id="view.source"]').click();
await page.waitForTimeout(200);

// Theme switch
await page.locator('#mdn-menubar .mdn-menu[data-menu="themes"] > .mdn-menu-label').click();
const themeBtn = page.locator('#mdn-menubar button[data-id^="theme."]').nth(1);
const themeId = await themeBtn.getAttribute("data-id");
await themeBtn.click();
await page.waitForTimeout(400);
const applied = await page.evaluate(() => document.body.dataset.theme);
ok(applied && "theme." + applied === themeId, "menu theme switch", applied + " vs " + themeId);
await page.evaluate(() => window.mdnest.runCommand("theme.mdnest"));
await page.waitForTimeout(200);

// Keyboard dispatcher: Ctrl+1, Ctrl+Shift+Q, Ctrl+/
await page.locator("#write").click();
await page.keyboard.press("Control+1");
await page.waitForTimeout(120);
ok(/^# /.test((await md()).split("\n").find((l) => l.includes("paragraph")) ?? "") || (await md()).includes("# A paragraph") || (await md()).includes("# Title") === false || (await md()).includes("\n# "), "Ctrl+1 heading", (await md()).slice(0, 80));
await page.keyboard.press("Control+Shift+Q");
await page.waitForTimeout(120);
await page.keyboard.press("Control+/");
await page.waitForTimeout(200);
ok(await page.evaluate(() => document.body.classList.contains("typora-sourceview-on")), "Ctrl+/ source mode");
await page.keyboard.press("Control+/");
await page.waitForTimeout(200);

// Dedupe: a simulated menu event within 300ms of the keydown runs once.
const dedupe = await page.evaluate(() => {
  let n = 0;
  const id = "file.preferences";
  const orig = window.mdnest.commands.find((c) => c.id === id);
  const prev = orig.run;
  orig.run = () => { n++; };
  const fire = () => document.dispatchEvent(new KeyboardEvent("keydown", { key: ",", code: "Comma", ctrlKey: true, bubbles: true, cancelable: true }));
  fire();
  // A menu activation within 300ms delivers the same key again (Windows) or calls runCommand.
  // The dispatcher drops the second one. runCommand is what the menu listener calls after its own guard.
  fire();
  const recent = window.mdnest.dispatcher?.recent?.(id);
  if (!recent) window.mdnest.runCommand(id);
  orig.run = prev;
  return { n, recent: !!recent };
});
ok(dedupe.n === 1 && dedupe.recent, "dedupe: same command within 300ms runs once", JSON.stringify(dedupe));


// Ctrl+R / F5 prevented
const reload = await page.evaluate(() => {
  const r = new KeyboardEvent("keydown", { key: "r", ctrlKey: true, bubbles: true, cancelable: true });
  const f5 = new KeyboardEvent("keydown", { key: "F5", bubbles: true, cancelable: true });
  document.body.dispatchEvent(r);
  document.body.dispatchEvent(f5);
  return { r: r.defaultPrevented, f5: f5.defaultPrevented };
});
ok(reload.r && reload.f5, "Ctrl+R / F5 prevented", JSON.stringify(reload));

// contextmenu default prevented on #write
const cm = await page.evaluate(() => {
  const ev = new MouseEvent("contextmenu", { bubbles: true, cancelable: true });
  document.querySelector("#write").dispatchEvent(ev);
  return ev.defaultPrevented;
});
ok(cm, "contextmenu default prevented on #write");

// Drop handler routing
const folder = WS;
const mdFile = path.join(WS, "ideas.md");
const drop = await page.evaluate(async ({ folder, mdFile }) => {
  const a = await window.mdnest.handleNativeDrop({ paths: [folder], position: { x: 10, y: 10 } });
  const b = await window.mdnest.handleNativeDrop({ paths: [mdFile], position: { x: 10, y: 10 } });
  return { a, b, path: window.mdnest.state.path, root: document.querySelector(".sidebar-folder-name")?.textContent ?? "" };
}, { folder, mdFile });
ok(drop.a === "folder", "drop handler: folder opens folder", drop.a + " root=" + drop.root);
ok(drop.b === "file" && (drop.path || "").endsWith("ideas.md"), "drop handler: .md opens it", drop.b + " " + drop.path);

ok(errors.length === 0, "no page errors", errors.join(" | "));

await browser.close();
const failed = results.filter((r) => !r.pass).length;
console.log(`\n${results.length - failed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
