// Part B parity (0.1.2): file watch, encodings, smart punctuation, spell check, emoji.
// Playwright against the browser host. Usage: node tests/parity-012b.mjs [baseUrl]
// Temp files live under dev-data/workspace and are removed in finally (including .trash copies).
import { chromium } from "playwright";
import fs from "node:fs";
import path from "node:path";

const base = process.argv[2] ?? "http://127.0.0.1:4173/";
const OUT = path.resolve("screenshots/parity-0.1.2");
fs.mkdirSync(OUT, { recursive: true });

const TMP = path.resolve("dev-data/workspace/.tmp-parity-012b");
const DOC = path.join(TMP, "parity-012b.md");
const TRASH = path.resolve("dev-data/.trash");
fs.rmSync(TMP, { recursive: true, force: true });
fs.mkdirSync(TMP, { recursive: true });
fs.writeFileSync(DOC, "# Title\n\nA paragraph with a word.\n");

const results = [];
const ok = (c, name, info = "") => {
  const line = (c ? "PASS " : "FAIL ") + name + (info ? " — " + String(info).slice(0, 240) : "");
  console.log(line);
  results.push({ pass: !!c, name });
};

function trashCopies() {
  if (!fs.existsSync(TRASH)) return [];
  return fs.readdirSync(TRASH).filter((n) => n.includes("parity-012b") || n.includes("outside-watch") || n.includes("gb18030"));
}

let browser;
try {
  browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1280, height: 860 } });
  page.setDefaultTimeout(10000);
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  const md = () => page.evaluate(() => window.mdnest.editor.getMarkdown());
  const run = (id) => page.evaluate((id) => window.mdnest.runCommand(id), id);

  await page.goto(base + `?theme=mdnest&file=${encodeURIComponent(DOC)}&folder=${encodeURIComponent(TMP)}&menubar=html&restore=0`);
  await page.evaluate(() => localStorage.removeItem("mdnest.autosave"));
  await page.waitForSelector("body.mdn-ready");
  await page.waitForSelector("#mdn-menubar");
  await page.waitForTimeout(400);

  // ---------- B1: external file creation appears in the tree ----------
  const outside = path.join(TMP, "outside-watch.md");
  fs.writeFileSync(outside, "# From disk\n");
  await page.waitForFunction((name) => {
    return [...document.querySelectorAll("#file-library-tree .file-node-title")].some((n) => n.textContent === name);
  }, "outside-watch.md", { timeout: 8000 });
  ok(true, "B1 external file appears in the file tree");
  const stillOpen = await page.evaluate(() => document.body.classList.contains("file-node-expanded") || !!document.querySelector("#file-library-tree .file-library-node.active, #file-library-tree .sidebar-folder-name"));
  ok(stillOpen, "B1 tree stays rendered after the watch refresh");
  await page.screenshot({ path: path.join(OUT, "file-watch.png") });

  ok(errors.length === 0, "B1 no page errors", errors.join(" | "));
} catch (e) {
  ok(false, "parity-012b threw", e?.message || String(e));
} finally {
  if (browser) await browser.close().catch(() => {});
  fs.rmSync(TMP, { recursive: true, force: true });
  for (const name of trashCopies()) fs.rmSync(path.join(TRASH, name), { recursive: true, force: true });
}

const failed = results.filter((r) => !r.pass).length;
console.log(`\n${results.length - failed}/${results.length} passed`);
process.exit(failed ? 1 : 0);
