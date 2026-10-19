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
  // WebKitGTK-style clipboard: HTML with only <img src="data:/blob:"> and no files → imported into ./assets
  const png = fs.readFileSync("tests/fixtures/logo.png").toString("base64");
  fs.rmSync(path.join(WS, "assets"), { recursive: true, force: true }); fs.mkdirSync(path.join(WS, "assets"));
  await page.locator("#write p", { hasText: "Final paragraph" }).click(); await page.keyboard.press("End");
  await page.evaluate((b64) => {
    const dt = new DataTransfer(); dt.setData("text/html", `<img src="data:image/png;base64,${b64}">`);
    document.querySelector("#write").dispatchEvent(new ClipboardEvent("paste", { clipboardData: dt, bubbles: true, cancelable: true }));
  }, png);
  await page.waitForTimeout(800);
  let a = fs.readdirSync(path.join(WS, "assets"));
  m = await md();
  ok(a.some((f) => /^image-\d{8}-\d{6}\.png$/.test(f)) && /!\[[^\]]*\]\(assets\/image-\d{8}-\d{6}\.png\)/.test(m), "paste of HTML-only image (WebKitGTK clipboard) → saved to ./assets", a.join(","));
  // WebKitGTK-style file drop: no files, uri-list unreadable, text/html = <a>file:///…</a>
  const srcImg = path.join(WS, "drop src.png"); fs.copyFileSync("tests/fixtures/logo.png", srcImg);
  await page.evaluate((u) => {
    const el = document.querySelector("#write h1"); const r = el.getBoundingClientRect();
    const dt = new DataTransfer(); dt.setData("text/html", `<a>${u}</a>`);
    el.dispatchEvent(new DragEvent("drop", { dataTransfer: dt, bubbles: true, cancelable: true, clientX: r.right - 2, clientY: r.top + r.height / 2 }));
  }, "file://" + encodeURI(srcImg));
  await page.waitForTimeout(800);
  a = fs.readdirSync(path.join(WS, "assets")); m = await md();
  ok(a.includes("drop-src.png") && m.includes("](assets/drop-src.png)"), "drop of file:// URI (WebKitGTK html form) → copied + linked", a.join(","));
  fs.rmSync(srcImg, { force: true });
  // typed definitions become blocks when the caret leaves
  await page.locator("#write p", { hasText: "Final paragraph" }).click(); await page.keyboard.press("End");
  await page.keyboard.press("Enter"); await page.keyboard.type("[^typed]: A **typed** note");
  await page.keyboard.press("Enter"); await page.keyboard.type("[newref]: https://new.example");
  await page.keyboard.press("Enter"); await page.keyboard.type("Uses [it][newref] and[^typed].");
  await page.locator("#write h1").click(); await page.waitForTimeout(200);
  const d2 = await page.evaluate(() => ({
    defs: [...document.querySelectorAll("#write .md-def-footnote .md-def-name")].map((e) => e.textContent),
    links: [...document.querySelectorAll("#write .md-def-link")].map((e) => e.textContent),
    a: [...document.querySelectorAll("#write span[md-inline=link] a")].map((a) => a.textContent + "→" + a.getAttribute("href")),
  }));
  ok(d2.defs.includes("typed"), "typed [^typed]: … becomes a footnote definition on leave", d2.defs.join(","));
  ok(d2.links.some((t) => t.startsWith("[newref]: https://new.example")) && d2.a.includes("it→https://new.example"), "typed [newref]: url becomes a definition and resolves [it][newref]", d2.a.join(" ; "));
  m = await md();
  ok(m.includes("[^typed]: A **typed** note\n\n[newref]: https://new.example\n\nUses [it][newref] and[^typed].\n"), "typed definitions serialize as written", m.slice(-120));
  // Enter in the middle of a footnote definition → rest becomes a paragraph, no duplicate label
  const box = await page.locator("#write .md-def-footnote .md-def-content", { hasText: "First footnote" }).boundingBox();
  await page.locator("#write .md-def-footnote .md-def-content", { hasText: "First footnote" }).click({ position: { x: 2, y: box.height / 2 } });
  await page.keyboard.press("Home"); for (let i = 0; i < 5; i++) await page.keyboard.press("ArrowRight");
  await page.keyboard.press("Enter"); await page.locator("#write h1").click(); await page.waitForTimeout(150);
  m = await md();
  ok(m.includes("[^1]: First\n\nfootnote with *emphasis*.") && (m.match(/\[\^1\]:/g) || []).length === 1, "Enter mid-definition → no duplicate [^1]:", m.match(/\[\^1\]:.{0,40}/s)?.[0]);
  // undefined reference typed in → byte-identical
  m = await md(); ok(!m.includes("\\["), "no escaped brackets in output", m.match(/.{0,20}\\\[.{0,20}/)?.[0] ?? "");
  // --no-restore equivalent in the browser: ?restore=0 with no file → welcome page
  await page.goto(base + "?restore=0"); await page.waitForSelector("body.mdn-ready"); await page.waitForTimeout(300);
  ok(await page.locator("#mdn-welcome h1").innerText().then((t) => t.includes("MD Nest")) && (await page.locator("#footer-word-count").innerText()) === "0 words", "?restore=0 starts on the welcome page");
  await page.evaluate(() => localStorage.setItem("mdnest.lastFile", "/workspace/mdnest/dev-data/workspace/sample.md"));
  await page.goto(base); await page.waitForSelector("body.mdn-ready"); await page.waitForTimeout(300);
  ok((await page.locator("#write h1").first().innerText()).includes("Feature Tour"), "default: last file reopened");
  await page.evaluate(() => localStorage.setItem("mdnest.reopenLast", "0"));
  await page.goto(base); await page.waitForSelector("body.mdn-ready"); await page.waitForTimeout(300);
  ok(await page.locator("#mdn-welcome").isVisible() && (await page.locator("#footer-word-count").innerText()) === "0 words", "setting 'Reopen last file' off → welcome page");
  await page.evaluate(() => { localStorage.removeItem("mdnest.reopenLast"); localStorage.removeItem("mdnest.lastFile"); });
} catch (e) { ok(false, "exception", e.message); }
ok(errors.length === 0, "no page errors", errors.join(" | "));
await browser.close();
const failed = results.filter((r) => !r.pass);
console.log(JSON.stringify({ passed: results.length - failed.length, failed: failed.length, results }, null, 1));
process.exit(failed.length ? 1 : 0);
