// "Fixes" round E2E (browser build): footnotes + reference links. Usage: node tests/fixes.mjs [baseUrl]
import { chromium } from "playwright";
import fs from "node:fs";
import path from "node:path";
const base = process.argv[2] ?? "http://127.0.0.1:4173/";
const WS = path.resolve("dev-data/workspace"), OUT = path.resolve("screenshots/fixes");
fs.mkdirSync(OUT, { recursive: true });
const DOC = path.join(WS, "p2-refs.md");
const SRC = fs.readFileSync("tests/fixtures/refs-footnotes.md", "utf8");
fs.writeFileSync(DOC, SRC);
fs.mkdirSync(path.join(WS, "assets"), { recursive: true }); fs.copyFileSync("tests/fixtures/logo.png", path.join(WS, "assets/logo.png"));
const results = []; const ok = (c, name, info = "") => results.push({ pass: !!c, name, info: String(info).slice(0, 200) });
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1280, height: 860 } });
page.setDefaultTimeout(6000);
const errors = []; page.on("pageerror", (e) => errors.push(e.message));
const md = () => page.evaluate(() => window.mdnest.editor.getMarkdown());
const shot = (n, clip) => page.screenshot({ path: path.join(OUT, n), ...(clip ? { clip } : {}) });
await page.goto(base + `?theme=mdnest&file=${encodeURIComponent(DOC)}&folder=${encodeURIComponent(WS)}`);
await page.evaluate(() => localStorage.removeItem("mdnest.autosave"));
await page.waitForSelector("body.mdn-ready"); await page.waitForTimeout(600);
try {
  ok(await md() === SRC, "refs/footnotes: open → getMarkdown byte-identical");
  const dom = await page.evaluate(() => ({
    sups: [...document.querySelectorAll("#write sup.md-footnote")].map((s) => s.textContent + "|" + s.title),
    defs: [...document.querySelectorAll("#write .md-def-footnote")].map((d) => d.querySelector(".md-def-name")?.textContent + "|" + d.querySelector(".md-def-content")?.textContent),
    linkDef: document.querySelector("#write .md-def-link")?.textContent ?? "",
    refA: [...document.querySelectorAll("#write span[md-inline=link] a")].map((a) => a.textContent + "→" + a.getAttribute("href")),
    img: document.querySelector("#write span.md-image img")?.getAttribute("src") ?? "",
  }));
  ok(dom.sups.length === 3 && dom.sups[0].startsWith("1|First footnote"), "footnote refs render as sup.md-footnote with definition tooltip", dom.sups.join(" ; "));
  ok(dom.defs.length === 2 && dom.defs[1].startsWith("note|Named footnote"), ".md-def-footnote > .md-def-name + .md-def-content", dom.defs.join(" ; "));
  ok(dom.linkDef.startsWith("[gh]: https://github.com"), "link definitions shown as .md-def-link raw block", dom.linkDef.split("\n")[0]);
  ok(dom.refA.includes("reference link→https://github.com") && dom.refA.includes("Typora→https://typora.io") && dom.refA.includes("docs→https://example.com/docs"), "reference links resolved (full/collapsed/shortcut)", dom.refA.join(" ; "));
  ok(dom.img.endsWith("assets/logo.png"), "image by reference resolved", dom.img);
  await shot("footnotes-refs.png", { x: 260, y: 0, width: 900, height: 560 });
  // click the footnote ref → raw [^1]
  await page.locator("#write sup.md-footnote").first().click(); await page.waitForTimeout(150);
  const raw = await page.locator("#write .md-src").first().innerText().catch(() => "");
  ok(raw === "[^1]", "click footnote ref reveals editable [^1]", raw);
  await shot("footnote-editing.png", { x: 260, y: 40, width: 900, height: 140 });
  // edit the label: [^1] → [^note]
  await page.keyboard.press("ArrowLeft"); // caret before ]
  for (let i = 0; i < 1; i++) await page.keyboard.press("Backspace");
  await page.keyboard.type("note");
  await page.locator("#write h1").click(); await page.waitForTimeout(150);
  let m = await md();
  ok(m.includes("a footnote[^note], another one[^note]."), "editing footnote label in raw → re-rendered", m.split("\n").find((l) => l.startsWith("An image")));
  // click a reference link → [text][id], change id → href follows definition
  await page.locator("#write span[md-inline=link] a", { hasText: "reference link" }).click(); await page.waitForTimeout(150);
  const rawLink = await page.locator("#write .md-src").first().innerText().catch(() => "");
  ok(rawLink === "[reference link][gh]", "click ref link reveals [text][id]", rawLink);
  await shot("reflink-editing.png", { x: 260, y: 40, width: 900, height: 140 });
  await page.keyboard.press("End");
  // caret is at end of paragraph line; easier: select-all via model: replace id through the editor API
  await page.evaluate(() => {
    const v = window.mdnest.editor.view; let at = -1;
    v.state.doc.descendants((n, p) => { if (at < 0 && n.isText && n.text.includes("[reference link][gh]")) at = p + n.text.indexOf("[gh]") + 1; });
    v.dispatch(v.state.tr.insertText("docs", at, at + 2));
  });
  await page.locator("#write h1").click(); await page.waitForTimeout(150);
  const href = await page.locator("#write span[md-inline=link] a", { hasText: "reference link" }).getAttribute("href");
  m = await md();
  ok(href === "https://example.com/docs" && m.includes("A full [reference link][docs]"), "changing the ref id re-resolves the link", href);
  // Ctrl+click footnote → jumps to definition
  await page.locator("#write sup.md-footnote").nth(1).click({ modifiers: ["Control"] }); await page.waitForTimeout(150);
  const par = await page.evaluate(() => window.mdnest.editor.view.state.selection.$from.parent.type.name);
  ok(par === "footnote_def", "Ctrl+click footnote ref jumps to its definition", par);
  // typing a new footnote ref in a paragraph
  await page.locator("#write p", { hasText: "Final paragraph" }).click(); await page.keyboard.press("End");
  await page.keyboard.type(" More[^1]"); await page.locator("#write h1").click(); await page.waitForTimeout(150);
  const n = await page.locator("#write p", { hasText: "Final paragraph" }).locator("sup.md-footnote").count();
  ok(n === 2, "typed [^1] becomes a footnote ref after leaving", n);
  // export HTML keeps footnote classes, hides link defs
  const html = await page.evaluate(() => window.mdnest.exportHtmlString());
  ok(/<sup class="md-footnote"[^>]*><a href="#dfref-footnote-1"/.test(html) && /class="md-def-footnote/.test(html) && /id="dfref-footnote-note"/.test(html), "export HTML: sup.md-footnote links to #dfref-footnote-*", "");
  // themes: Drake renders its own footnote style
  await page.evaluate(() => window.mdnest.editor && document.querySelector("#theme_css"));
} catch (e) { ok(false, "exception", e.message); }
ok(errors.length === 0, "no page errors", errors.join(" | "));
await browser.close();
const failed = results.filter((r) => !r.pass);
console.log(JSON.stringify({ passed: results.length - failed.length, failed: failed.length, results }, null, 1));
process.exit(failed.length ? 1 : 0);
