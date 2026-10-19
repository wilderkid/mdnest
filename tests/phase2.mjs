// Phase 2 end-to-end checks + screenshots → screenshots/phase2/. Usage: node tests/phase2.mjs [baseUrl]
import { chromium } from "playwright";
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
const base = process.argv[2] ?? "http://127.0.0.1:4173/";
const WS = path.resolve("dev-data/workspace"), OUT = path.resolve("screenshots/phase2");
fs.mkdirSync(OUT, { recursive: true });
const DOC = path.join(WS, "p2.md");
fs.writeFileSync(DOC, fs.readFileSync("samples/sample.md", "utf8"));
for (const d of ["assets", "p2.assets"]) fs.rmSync(path.join(WS, d), { recursive: true, force: true });
let m = ""; const results = []; const ok = (c, name, info = "") => { results.push({ pass: !!c, name, info: String(info).slice(0, 160) }); };

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1280, height: 860 } });
page.setDefaultTimeout(6000);
const errors = []; page.on("pageerror", (e) => errors.push(e.message));
let dialogAnswer = null; page.on("dialog", (d) => d.accept(dialogAnswer ?? undefined));
const md = () => page.evaluate(() => window.mdnest.editor.getMarkdown());
const parent = () => page.evaluate(() => window.mdnest.editor.view.state.selection.$from.parent.toString());
const shot = (n, clip) => page.screenshot({ path: path.join(OUT, n), ...(clip ? { clip } : {}) });
const clipOf = async (sel, pad = 30) => { const b = await page.locator(sel).first().boundingBox(); return { x: Math.max(0, b.x - pad), y: Math.max(0, b.y - pad), width: Math.min(1280, b.width + pad * 2), height: b.height + pad * 2 }; };
async function load(theme = "mdnest") {
  await page.goto(base + `?theme=${theme}&file=${encodeURIComponent(DOC)}&folder=${encodeURIComponent(WS)}`);
  await page.evaluate(() => { localStorage.removeItem("mdnest.autosave"); });
  await page.waitForSelector("body.mdn-ready"); await page.waitForTimeout(700);
}
await load();

// ---- 1. editable markers ----
try {await page.locator("#write p strong").first().click();
await page.waitForTimeout(120);
const rawText = await page.locator("#write .md-src").first().innerText().catch(() => "");
ok(rawText === "**bold**", "markers: click into bold reveals editable **bold**", rawText);
await shot("marker-editing-bold.png", await clipOf("#write p:has(.md-src)", 20));
for (let i = 0; i < 4; i++) await page.keyboard.press("ArrowRight");
await page.keyboard.press("Backspace"); await page.keyboard.press("Backspace");
await page.locator("#write h2").first().click(); await page.waitForTimeout(100);
m = await md();
ok(m.includes("This paragraph has \\*\\*bold,"), "markers: deleting closing ** removes bold (literal \\*\\* kept)", m.split("\n").find((l) => l.startsWith("This paragraph")));
await page.keyboard.press("Control+z"); await page.keyboard.press("Control+z"); await page.waitForTimeout(100);
// typed delimiters become formatting
await page.locator("#write h1").first().click(); await page.waitForTimeout(80);
await page.keyboard.press("End"); await page.keyboard.press("Enter");
await page.keyboard.type("Typing **live bold** and ==mark== then `code`");
await page.waitForTimeout(100);
await shot("marker-editing-typing.png", await clipOf("#write p.md-focus", 20));
const rawTyped = await page.locator("#write .md-src").first().innerText().catch(() => "");
ok(rawTyped.includes("**live bold**"), "markers: typed Markdown stays raw (with styling) while caret inside", rawTyped);
await page.locator("#write h2").first().click(); await page.waitForTimeout(100);
const typedHtml = await page.evaluate(() => [...document.querySelectorAll("#write p")].find((p) => p.textContent.startsWith("Typing"))?.innerHTML ?? "");
ok(/<strong>live bold<\/strong>/.test(typedHtml) && /<mark>mark<\/mark>/.test(typedHtml) && /<code>code<\/code>/.test(typedHtml), "markers: leaving the span renders strong/mark/code", typedHtml.replace(/<[^>]*md-inline[^>]*>/g, ""));
m = await md(); ok(m.includes("Typing **live bold** and ==mark== then `code`"), "markers: markdown output exact", m.split("\n").find((l) => l.startsWith("Typing")));
// link editing: change URL inside raw link
await page.locator("#write p span[md-inline=link] a").first().click(); await page.waitForTimeout(100);
const rawLink = await page.locator("#write .md-src").first().innerText().catch(() => "");
ok(rawLink.startsWith("[link](https://example.com"), "markers: link reveals [text](url)", rawLink);
// click-then-type immediately (no wait) lands where clicked
await page.locator("#write h2:text('Lists')").click();
await page.keyboard.press("End"); await page.keyboard.type("Z");
ok((await parent()).includes('heading("ListsZ")'), "cursor: click-then-type lands in clicked heading", await parent());
await page.keyboard.press("Backspace");
// inline math: click → raw $…$ + live preview popover
await page.locator("#write .md-inline-math").first().click(); await page.waitForTimeout(400);
const rawMath = await page.locator("#write .md-src").first().innerText().catch(() => "");
ok(rawMath.includes("$E = mc^2$"), "inline math: click reveals editable $tex$ with preview", rawMath);
await page.keyboard.press("ArrowLeft"); await page.keyboard.type("+1"); await page.waitForTimeout(500);
ok(await page.locator("#write .md-inline-math-preview mjx-container").count() > 0, "inline math: live preview popover renders");
await shot("inline-math-editor.png", await clipOf("#write p:has(.md-src)", 20));
await page.locator("#write h2").first().click(); await page.waitForTimeout(100);
ok((await md()).includes("$E = mc^2+1$"), "inline math: edit saved", (await md()).match(/\$E[^$]*\$/)?.[0]);

} catch (e) { ok(false, "EXCEPTION in ---- 1. editable markers ----", e.message.split("\n")[0]); }

// ---- 2. table toolbar ----
try {await page.locator("#write td:text('Tables')").click(); await page.waitForTimeout(150);
ok(await page.locator("#mdn-table-tools").isVisible(), "table: toolbar appears when caret in table");
const btn = (c) => page.locator(`#mdn-table-tools button[data-cmd="${c}"]`).click();
await btn("row-below"); await btn("col-right"); await page.waitForTimeout(100);
const dims = await page.evaluate(() => { const t = document.querySelector("#write table"); return [t.rows.length, t.rows[0].cells.length]; });
ok(dims[0] === 4 && dims[1] === 4, "table: add row + column → 4×4", dims);
await page.locator("#write td:text('Tables')").click(); await btn("align-center"); await page.waitForTimeout(100);
await shot("table-toolbar.png", await clipOf("#write table", 60));
m = await md(); const sep = m.split("\n").find((l) => /^\|\s*:?-+/.test(l));
ok(sep === "|:---:|---|:---:|---:|", "table: first column centred, others kept (new column default) on save", sep);
await btn("col-del"); await page.locator("#write td").last().click(); await btn("row-del"); await page.waitForTimeout(100);
const dims2 = await page.evaluate(() => { const t = document.querySelector("#write table"); return [t.rows.length, t.rows[0].cells.length]; });
ok(dims2[0] === 3 && dims2[1] === 3, "table: delete row/column", dims2);
m = await md(); ok(m.includes("|---|:---:|---:|") || m.includes("|:---:|"), "table: alignment survives edits", m.split("\n").find((l) => /^\|\s*:?-+/.test(l)));

} catch (e) { ok(false, "EXCEPTION in ---- 2. table toolbar ----", e.message.split("\n")[0]); }

// ---- 3. find / replace ----
try {await page.locator("#write h1").first().click();
await page.keyboard.press("Control+f"); await page.keyboard.type("done");
await page.waitForTimeout(150);
const doneCount = +(await page.locator("#mdn-find .fb-count").innerText()).split("/")[1];
const expectDone = (m.match(/\bdone\b/gi) || []).length;
const ctx = await page.evaluate(() => { const st = window.mdnest.editor.view.state; const ps = []; st.doc.descendants((n, p) => { if (n.isTextblock && /done/i.test(n.textContent)) ps.push(n.type.name + ":" + n.textContent); }); return ps.join(" | ") + " hits=" + [...document.querySelectorAll("#write .md-search-hit")].map((e) => e.closest("[mdtype],td,th,li,p")?.tagName + ":" + e.textContent).join(","); });
ok(doneCount === expectDone && doneCount >= 2, "find: counts matches (table cells + task text)", doneCount + " vs " + expectDone + " :: " + ctx);
ok(await page.locator("#write .md-search-hit").count() >= 2, "find: hits highlighted");
await page.locator("#mdn-find .fb-find").fill("fib\\(n\\s-\\s\\d\\)");
await page.locator('#mdn-find [data-opt="regex"]').click(); await page.waitForTimeout(150);
ok((await page.locator("#mdn-find .fb-count").innerText()).endsWith("/2"), "find: regex matches inside code blocks", await page.locator("#mdn-find .fb-count").innerText());
ok(await page.evaluate(() => [...document.querySelectorAll("#write .CodeMirror")].reduce((n, c) => n + c.CodeMirror.getAllMarks().filter((m) => m.className.includes("md-search-hit")).length, 0)) === 2, "find: hits mirrored inside CodeMirror fences (2 marks)");
await page.locator("#write pre.md-fences").nth(1).scrollIntoViewIfNeeded();
await shot("find-regex-code.png");
await page.locator('#mdn-find [data-opt="regex"]').click();
await page.keyboard.press("Escape");
await page.keyboard.press("Control+h"); await page.locator("#mdn-find .fb-find").fill("done");
await page.locator('#mdn-find [data-opt="caseSensitive"]').click();
await page.locator("#mdn-find .fb-repl").fill("finished"); await page.waitForTimeout(100);
await page.locator("#write table").scrollIntoViewIfNeeded();
await shot("find-replace.png");
await page.locator('#mdn-find [data-act="all"]').click(); await page.waitForTimeout(100);
m = await md(); ok(!/\bdone\b/.test(m) && (m.match(/finished/g) || []).length === expectDone, "replace: replace all (case-sensitive)", (m.match(/finished/g) || []).length);
ok(m.includes("[x] Task finished"), "replace: task item text replaced, checkbox kept");
await page.locator('#mdn-find [data-opt="caseSensitive"]').click();
await page.keyboard.press("Escape");
// source mode find
await page.keyboard.press("Control+/"); await page.waitForTimeout(300);
await page.keyboard.press("Control+f"); await page.keyboard.type("heading"); await page.waitForTimeout(150);
const srcCount = await page.locator("#mdn-find .fb-count").innerText();
ok(/\/[2-9]/.test(srcCount) && await page.locator("#typora-source .md-search-hit").count() >= 2, "find: works in source mode (CodeMirror)", srcCount);
await shot("find-source-mode.png");
await page.locator("#mdn-find .fb-repl").fill("Heading").catch(() => {});
await page.keyboard.press("Escape"); await page.keyboard.press("Control+/"); await page.waitForTimeout(300);

} catch (e) { ok(false, "EXCEPTION in ---- 3. find / replace ----", e.message.split("\n")[0]); }

// ---- 4. image paste / drop ----
try {dialogAnswer = DOC; await page.keyboard.press("Control+s"); await page.waitForTimeout(300); dialogAnswer = null;
await page.locator("#write h2:text('Image')").click(); await page.keyboard.press("End"); await page.keyboard.press("Enter");
await page.evaluate(async () => {
  const c = document.createElement("canvas"); c.width = 360; c.height = 120; const g = c.getContext("2d");
  const gr = g.createLinearGradient(0, 0, 360, 0); gr.addColorStop(0, "#ff7a59"); gr.addColorStop(1, "#7a5cff"); g.fillStyle = gr; g.fillRect(0, 0, 360, 120);
  g.fillStyle = "#fff"; g.font = "bold 30px sans-serif"; g.fillText("pasted image", 70, 72);
  const blob = await new Promise((r) => c.toBlob(r, "image/png"));
  const dt = new DataTransfer(); dt.items.add(new File([blob], "image.png", { type: "image/png" }));
  window.mdnest.editor.view.dom.dispatchEvent(new ClipboardEvent("paste", { clipboardData: dt, bubbles: true, cancelable: true }));
});
await page.waitForTimeout(800);
m = await md(); const imgRef = m.match(/!\[[^\]]*\]\((assets\/image-[^)]+\.png)\)/);
ok(imgRef && fs.existsSync(path.join(WS, decodeURIComponent(imgRef[1]))), "image paste: saved to ./assets and relative path inserted", imgRef?.[1]);
ok(await page.locator('#write img[src*="assets/image-"]').evaluate((i) => i.complete && i.naturalWidth === 360).catch(() => false), "image paste: image displays");
await page.locator('#write img[src*="assets/image-"]').scrollIntoViewIfNeeded();
await shot("pasted-image.png", await clipOf('#write span.md-image:has(img[src*="assets/image-"])', 80));
// drop with ${filename}.assets
await page.evaluate(() => localStorage.setItem("mdnest.imageFolder", "./${filename}.assets"));
await page.evaluate(async () => {
  const c = document.createElement("canvas"); c.width = 80; c.height = 80; c.getContext("2d").fillRect(0, 0, 80, 80);
  const blob = await new Promise((r) => c.toBlob(r, "image/png"));
  const dt = new DataTransfer(); dt.items.add(new File([blob], "dropped shot.png", { type: "image/png" }));
  const img = document.querySelector('#write img[src*="assets/image-"]').getBoundingClientRect();
  window.mdnest.editor.view.dom.dispatchEvent(new DragEvent("drop", { dataTransfer: dt, clientX: img.right + 5, clientY: img.top + 10, bubbles: true, cancelable: true }));
});
await page.waitForTimeout(800);
m = await md(); const dropRef = m.match(/!\[[^\]]*\]\((p2\.assets\/dropped-shot\.png)\)/);
ok(dropRef && fs.existsSync(path.join(WS, "p2.assets/dropped-shot.png")), "image drop: ${filename}.assets folder + original name", dropRef?.[1]);
await page.evaluate(() => localStorage.removeItem("mdnest.imageFolder"));

} catch (e) { ok(false, "EXCEPTION in ---- 4. image paste / drop ----", e.message.split("\n")[0]); }

// ---- 5. export ----
try {dialogAnswer = path.join(WS, "p2.html");
await page.evaluate(() => window.mdnest.editor.view.focus());
await page.evaluate(() => document.dispatchEvent(new KeyboardEvent("keydown", { key: "P", ctrlKey: true, shiftKey: true })));
await page.keyboard.type("export html"); await page.keyboard.press("Enter");
await page.waitForFunction(() => document.getElementById("mdn-toast").textContent.startsWith("Exported"), null, { timeout: 30000 }).catch(() => {});
dialogAnswer = null;
const htmlPath = path.join(WS, "p2.html");
ok(fs.existsSync(htmlPath), "export html: file written", fs.existsSync(htmlPath) ? fs.statSync(htmlPath).size + " bytes" : "missing");
if (fs.existsSync(htmlPath)) {
  const html = fs.readFileSync(htmlPath, "utf8");
  ok(html.includes("mdnest-theme") && html.includes("--bg-color") && /cm-keyword/.test(html) && /<svg/.test(html) && !/mdtheme:|\/themes\//.test(html.replace(/\/\*[^*]*\*\//g, "")), "export html: theme CSS inlined, code highlighted, math/mermaid SVG", "");
  ok(html.includes('src="assets/image-'), "export html: relative image paths kept");
  ok(/<table[^>]*><thead><tr[^>]*><th/.test(html) && html.includes("finished"), "export html: table exported with thead");
  const ex = await browser.newPage({ viewport: { width: 1000, height: 1300 } });
  await ex.goto("file://" + htmlPath); await ex.waitForTimeout(500);
  await ex.screenshot({ path: path.join(OUT, "exported-html.png") });
  await ex.evaluate(() => window.scrollTo(0, document.querySelector("#write h2:nth-of-type(3)")?.offsetTop ?? 1200));
  await ex.screenshot({ path: path.join(OUT, "exported-html-2.png") });
  await ex.pdf({ path: path.join(OUT, "exported-chromium.pdf"), format: "A4", printBackground: true, margin: { top: "15mm", bottom: "15mm", left: "14mm", right: "14mm" } });
  await ex.close();
  try { execFileSync("pdftoppm", ["-png", "-r", "60", "-f", "1", "-l", "2", path.join(OUT, "exported-chromium.pdf"), path.join(OUT, "exported-chromium-page")]); ok(true, "export pdf (browser print path): rendered via Chromium print"); } catch (e) { ok(false, "pdftoppm", e.message); }
}

} catch (e) { ok(false, "EXCEPTION in ---- 5. export ----", e.message.split("\n")[0]); }

// ---- 6. syntax-colour fallback ----
try {await load("vue");
ok(await page.evaluate(() => document.body.classList.contains("mdn-cm-fallback")), "theme: Vue has no code colours → fallback palette applied");
await page.locator("#write pre.md-fences").first().scrollIntoViewIfNeeded(); await page.waitForTimeout(200);
await shot("syntax-fallback-vue.png", await clipOf("#write pre.md-fences", 20));
await load("drake");
ok(await page.evaluate(() => !document.body.classList.contains("mdn-cm-fallback")), "theme: Drake colours code itself → no fallback");

} catch (e) { ok(false, "EXCEPTION in ---- 6. syntax-colour fallback ----", e.message.split("\n")[0]); }

// ---- 7. autosave + file watching + recent ----
try {await load();
await page.evaluate(() => localStorage.setItem("mdnest.autosave", "1"));
await page.locator("#write h1").first().click(); await page.keyboard.press("End"); await page.keyboard.type(" (autosaved)");
await page.waitForTimeout(2600);
ok(fs.readFileSync(DOC, "utf8").includes("# mdnest Feature Tour (autosaved)"), "autosave: written 1.5 s after edits");
await page.locator("#write h2").first().click();
fs.writeFileSync(DOC, fs.readFileSync(DOC, "utf8").replace("Final paragraph.", "Final paragraph — edited externally."));
await page.waitForTimeout(3500);
ok((await md()).includes("edited externally"), "file watching: external change reloaded");
await page.click('.sidebar-tab[data-id="recent"]');
ok(await page.locator(".recent-file").count() >= 1, "recent files: listed", await page.locator(".recent-file .file-node-title").first().innerText().catch(() => ""));
await page.evaluate(() => localStorage.removeItem("mdnest.autosave"));

} catch (e) { ok(false, "EXCEPTION in ---- 7. autosave + file watching + recent ----", e.message.split("\n")[0]); }

console.log(JSON.stringify({ passed: results.filter((r) => r.pass).length, failed: results.filter((r) => !r.pass).length, results, errors: errors.slice(0, 10) }, null, 1));
await browser.close();
process.exit(results.every((r) => r.pass) ? 0 : 1);
