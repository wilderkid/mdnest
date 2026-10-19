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
  const wordBtn = page.locator("#mdn-menubar .mdn-submenu button").filter({ hasText: /Word \(\.docx\)/ }).first();
  ok(await wordBtn.isVisible(), "C1 Export flyout is visible beside the File menu (not clipped)");
  const box = await wordBtn.boundingBox();
  const parentBox = await exportRow.boundingBox();
  ok(!!box && !!parentBox && box.x >= parentBox.x + parentBox.width - 2, "C1 Export flyout opens to the right of the row");
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

  await page.keyboard.press("Escape");
  await page.locator('#mdn-menubar .mdn-menu[data-menu="file"] > .mdn-menu-label').click();
  await page.locator("#mdn-menubar .mdn-menu.mdn-menu-open > .dropdown-menu > .mdn-menu-sub").filter({ hasText: /^Export/ }).first().hover();
  await page.waitForTimeout(150);
  const pandocLabels = await page.locator("#mdn-menubar .mdn-submenu button").allTextContents();
  for (const label of ["Word (pandoc)", "OpenOffice", "RTF", "EPUB", "LaTeX", "MediaWiki", "reStructuredText", "Textile", "OPML", "Org mode", "Custom pandoc format"]) {
    ok(pandocLabels.some((t) => t.includes(label)), "C2 export menu has " + label);
  }

  await page.evaluate(() => window.mdnest.runCommand("file.exportPandoc.docx"));
  await page.waitForSelector("#pandoc-missing", { timeout: 4000 });
  const modal = await page.locator("#pandoc-missing .modal").innerText();
  ok(/Pandoc not found/i.test(modal), "C2 missing-pandoc modal", modal.slice(0, 160));
  ok(/Install Pandoc/.test(modal) && /Re-check/.test(modal), "C2 modal has Install and Re-check");
  await page.screenshot({ path: path.join(OUT, "pandoc-missing.png") });
  await page.locator("#pandoc-missing [data-c=close]").click();
  ok(await page.locator("#pandoc-missing").count() === 0, "C2 modal closes");

  // Fake pandoc the Vite middleware finds before PATH (no real pandoc on this box).
  const fakeDir = path.resolve("dev-data/workspace/.pandoc-bin");
  fs.mkdirSync(fakeDir, { recursive: true });
  const log = path.join(TMP, "pandoc-args.txt");
  const stdinLog = path.join(TMP, "pandoc-stdin.md");
  fs.writeFileSync(path.join(fakeDir, "pandoc"), `#!/bin/sh
echo "$@" > ${JSON.stringify(log)}
cat > ${JSON.stringify(stdinLog)}
out=""
prev=""
for a in "$@"; do
  if [ "$prev" = "-o" ]; then out="$a"; fi
  prev="$a"
done
printf 'fake pandoc %s\\n' "$*" > "$out"
`, { mode: 0o755 });
  fs.chmodSync(path.join(fakeDir, "pandoc"), 0o755);
  const info = await page.evaluate(async () => window.mdnest.host.pandocInfo());
  ok(info.found && String(info.path).includes(".pandoc-bin"), "C2 fake pandoc detected", JSON.stringify(info));
  const odt = path.join(TMP, "out.odt");
  const exported = await page.evaluate(async (p) => {
    try { return await window.mdnest.exportPandoc("odt", "odt", p); }
    catch (e) { return "ERR " + (e && e.message || e); }
  }, odt);
  ok(fs.existsSync(odt), "C2 fake pandoc wrote the output", String(exported));
  const args = fs.existsSync(log) ? fs.readFileSync(log, "utf8") : "";
  ok(args.includes("-t") && args.includes("odt") && args.includes("-o"), "C2 fake pandoc recorded args", args);
  ok(args.includes("tex_math_dollars"), "C2 from format includes tex math", args);
  const stdin = fs.existsSync(stdinLog) ? fs.readFileSync(stdinLog, "utf8") : "";
  ok(stdin.includes("bold") || stdin.includes("Title"), "C2 stdin is the markdown", stdin.slice(0, 80));
  fs.rmSync(fakeDir, { recursive: true, force: true });
  const gone = await page.evaluate(async () => window.mdnest.host.pandocInfo());
  ok(!gone.found, "C2 re-check finds no pandoc after the fake is removed", JSON.stringify(gone));

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
