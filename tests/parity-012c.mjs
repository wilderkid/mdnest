// Part C parity (0.1.2): built-in docx export and the pandoc-missing modal.
// Playwright against the browser host. Usage: node tests/parity-012c.mjs [baseUrl]
// Temp files live under dev-data/workspace and are removed in finally.
import { chromium } from "playwright";
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";

const base = process.argv[2] ?? "http://127.0.0.1:4173/";
const OUT = path.resolve("screenshots/parity-0.1.2");
fs.mkdirSync(OUT, { recursive: true });

const TMP = path.resolve("dev-data/workspace/.tmp-parity-012c");
const DOC = path.join(TMP, "parity-012c.md");
const DOCX = path.join(TMP, "out.docx");
const TRASH = path.resolve("dev-data/.trash");
fs.rmSync(TMP, { recursive: true, force: true });
fs.mkdirSync(TMP, { recursive: true });

const TINY_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAgAAAAECAYAAACzzX7wAAAAEklEQVR4nGP8z8Dwn4EIwDiqECgAAG8AB2z0a0YAAAAASUVORK5CYII=",
  "base64",
);
fs.writeFileSync(path.join(TMP, "pixel.png"), TINY_PNG);
fs.writeFileSync(DOC, [
  "# Title",
  "",
  "A **bold** word and a [link](https://example.com).",
  "",
  "- item",
  "- [x] done",
  "",
  "![pic](pixel.png)",
  "",
].join("\n"));

const results = [];
const ok = (c, name, info = "") => {
  const line = (c ? "PASS " : "FAIL ") + name + (info ? " — " + String(info).slice(0, 240) : "");
  console.log(line);
  results.push({ pass: !!c, name });
};

let browser;
try {
  browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1280, height: 860 } });
  page.setDefaultTimeout(10000);
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("dialog", async (d) => { await d.accept(DOCX); });

  await page.goto(base + `?theme=mdnest&file=${encodeURIComponent(DOC)}&folder=${encodeURIComponent(TMP)}&menubar=html&restore=0`);
  await page.evaluate(() => localStorage.removeItem("mdnest.autosave"));
  await page.waitForSelector("body.mdn-ready");
  await page.waitForSelector("#mdn-menubar");
  await page.waitForTimeout(300);

  await page.locator('#mdn-menubar .mdn-menu[data-menu="file"] > .mdn-menu-label').click();
  const exportRow = page.locator("#mdn-menubar .mdn-menu.mdn-menu-open > .dropdown-menu > .mdn-menu-sub").filter({ hasText: /^Export/ }).first();
  await exportRow.hover();
  await page.waitForTimeout(200);
  const labels = await page.locator("#mdn-menubar .mdn-submenu button").allTextContents();
  ok(labels.some((t) => /Word \(\.docx\)/.test(t)), "C1 export menu has Word (.docx)", labels.join(" | "));
  ok(labels.some((t) => /PDF/.test(t)) && labels.some((t) => /HTML/.test(t)), "C1 built-in PDF and HTML stay in Export");
  await page.screenshot({ path: path.join(OUT, "export-menu.png") });

  await page.evaluate(() => window.mdnest.runCommand("file.exportDocx"));
  await page.waitForFunction(() => document.getElementById("mdn-toast")?.textContent?.includes("Exported"), null, { timeout: 15000 });
  ok(fs.existsSync(DOCX) && fs.statSync(DOCX).size > 200, "C1 docx written", DOCX);

  const summary = execFileSync("python3", ["-c", `
import zipfile, xml.etree.ElementTree as ET, sys
z = zipfile.ZipFile(sys.argv[1])
need = ["[Content_Types].xml", "word/document.xml", "word/styles.xml", "word/numbering.xml"]
missing = [n for n in need if n not in z.namelist()]
assert not missing, missing
W = "{http://schemas.openxmlformats.org/wordprocessingml/2006/main}"
root = ET.fromstring(z.read("word/document.xml"))
text = "".join(t.text or "" for t in root.iter(W + "t"))
styles = z.read("word/styles.xml").decode()
assert "Title" in styles and "ListParagraph" in styles
assert "bold" in text and "Title" in text
print(text)
`, DOCX], { encoding: "utf8" });
  ok(summary.includes("bold") && summary.includes("Title"), "C1 document.xml has the title and bold", summary.trim().slice(0, 180));

  // Render extracted paragraph text so the screenshot is a readable summary of document.xml.
  const shotHtml = `<!doctype html><meta charset="utf-8"><style>body{font:16px sans-serif;padding:24px;background:#fff;color:#222}pre{white-space:pre-wrap}</style><h1>document.xml</h1><pre>${summary.replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c]))}</pre>`;
  const shot = await browser.newPage({ viewport: { width: 900, height: 400 } });
  await shot.setContent(shotHtml);
  await shot.screenshot({ path: path.join(OUT, "docx-export.png") });
  await shot.close();

  // C2 modal is added in the next commit. If the command exists already, exercise it.
  const hasPandoc = await page.evaluate(() => window.mdnest.commands.some((c) => c.id === "file.exportPandoc.docx"));
  if (hasPandoc) {
    await page.evaluate(() => window.mdnest.runCommand("file.exportPandoc.docx"));
    await page.waitForSelector(".modal-backdrop", { timeout: 4000 });
    const modal = await page.locator(".modal").innerText();
    ok(/Pandoc not found/i.test(modal), "C2 missing-pandoc modal", modal.slice(0, 120));
    await page.screenshot({ path: path.join(OUT, "pandoc-missing.png") });
    await page.locator(".modal button", { hasText: "Close" }).click().catch(() => {});
  } else {
    ok(true, "C2 pandoc menu not in this build yet (C1 only)");
  }

  ok(errors.length === 0, "C1 no page errors", errors.join(" | "));
} catch (e) {
  ok(false, "parity-012c threw", e?.stack || String(e));
} finally {
  if (browser) await browser.close().catch(() => {});
  fs.rmSync(TMP, { recursive: true, force: true });
  if (fs.existsSync(TRASH)) {
    for (const n of fs.readdirSync(TRASH)) {
      if (n.includes("parity-012c") || n.includes("pixel.png")) fs.rmSync(path.join(TRASH, n), { recursive: true, force: true });
    }
  }
}

const failed = results.filter((r) => !r.pass);
console.log(`\n${results.length - failed.length}/${results.length} passed`);
process.exit(failed.length ? 1 : 0);
