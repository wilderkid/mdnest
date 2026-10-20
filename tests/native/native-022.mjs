// 0.2.2 features in the REAL app (Tauri + WebKitGTK via tauri-driver), WebDriver key/pointer actions only for the action under test.
// usage: node tests/native/native-022.mjs path/to/mdnest [display]
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { startNative } from "./wd.mjs";

const app = process.argv[2]; const display = process.argv[3] ?? ":79";
const work = fs.mkdtempSync(path.join(os.tmpdir(), "mdn-022-"));
const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAIAAACQkWg2AAAAHElEQVR4nGP8z8DwnwEJMDGgAcYRCRgFAABmLwIfyPo0uQAAAABJRU5ErkJggg==", "base64");
fs.writeFileSync(path.join(work, "pic.png"), png);
const doc = path.join(work, "笔记.md");
const START = "你好 world 这里\n\n```js\nlet a = 1;\n```\n\nAfter\n\n![pic](pic.png)\n";
fs.writeFileSync(doc, START);
fs.writeFileSync(path.join(work, "other.md"), "other\n");
const OUT = path.resolve("screenshots/fixes-0.2.2"); fs.mkdirSync(OUT, { recursive: true });
let pass = 0, fail = 0;
const ok = (c, m, info = "") => { console.log((c ? "PASS " : "FAIL ") + m + (c || info === "" ? "" : " — " + String(typeof info === "string" ? info : JSON.stringify(info)).slice(0, 300))); c ? pass++ : fail++; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const disk = () => fs.readFileSync(doc, "utf8");
const n = await startNative({ app, display, port: 4444, args: [doc], env: { LANG: "zh_CN.UTF-8", LANGUAGE: "zh_CN" } });
try {
  await n.waitFor(() => document.body.classList.contains("mdn-ready") && !!document.querySelector("#write .CodeMirror"));
  await sleep(800);
  const md = () => n.exec(() => window.mdnest.editor.getMarkdown());
  const wordAt = (w) => n.exec((w) => {
    const it = document.createTreeWalker(document.querySelector("#write"), NodeFilter.SHOW_TEXT);
    for (let t; (t = it.nextNode());) { const i = t.data.indexOf(w); if (i >= 0) { const r = document.createRange(); r.setStart(t, i); r.setEnd(t, i + w.length); const b = r.getBoundingClientRect(); return { x: b.x + b.width / 2, y: b.y + b.height / 2 }; } }
    return null;
  }, w);
  const menuItem = async (id) => { await n.click(`.context-menu .mdn-menu-item[data-id="${id}"]`); await sleep(250); };
  const sel = () => n.exec(() => { const s = window.mdnest.editor.view.state.selection; return { t: s.toJSON().type, node: s.node?.type.name ?? null }; });

  // item 4: right-click > 格式 > 加粗 on a double-clicked word
  { const b = await wordAt("world"); await n.mouseAt(b.x, b.y, { clicks: 2 }); await sleep(200);
    await n.mouseAt(b.x, b.y, { button: 2 }); await sleep(300);
    await menuItem("format"); await n.screenshot(path.join(OUT, "native-linux-ctx-format-menu.png")); await menuItem("format.strong"); }
  ok((await md()).startsWith("你好 **world** 这里"), "native item4: context menu 格式 > 加粗 bolds the selected word", (await md()).slice(0, 40));
  { const b = await wordAt("这里"); await n.mouseAt(b.x, b.y); await n.mouseAt(b.x, b.y, { button: 2 }); await sleep(300); await menuItem("format"); await menuItem("format.emphasis"); }
  ok((await md()).startsWith("你好 **world** *这里*"), "native item4: caret-only right-click formats the word under it", (await md()).slice(0, 40));

  // item 1: autosave (default on), footer chip, window title
  await sleep(2600);
  ok(disk().startsWith("你好 **world** *这里*"), "native item1: autosaved ~1.5 s after the edit", disk().slice(0, 40));
  const chip = await n.exec(() => document.querySelector(".saved-text")?.textContent ?? "");
  ok(/保存/.test(chip) && !/未保存/.test(chip), "native item1: footer shows 已自动保存", chip);
  // title: dirty bullet while unsaved
  await n.click("#write > p:first-child"); await n.press("End"); await n.type("!"); await sleep(300);
  const t1 = await n.exec(() => document.title);
  await sleep(2400);
  const t2 = await n.exec(() => document.title);
  ok(/•/.test(t1) && !/•/.test(t2), "native item1: title shows • while unsaved, cleared after autosave", [t1, t2]);

  // item 2: ArrowDown out of the code block that is followed by a paragraph lands there; Ctrl+Enter inserts a paragraph after it
  await n.click("#write .CodeMirror-line"); await sleep(200); await n.press("Enter", ["Control"]); await sleep(200); await n.type("mid"); await sleep(200);
  ok(/```\n\nmid\n\nAfter/.test(await md()), "native item2: Ctrl+Enter in a code block opens a paragraph after it", await md());
  // ArrowDown below the last (image-only) paragraph
  await n.click("#write span.md-image img"); await sleep(200); await n.press("ArrowDown"); await sleep(150); await n.type("end"); await sleep(200);
  ok((await md()).endsWith("![pic](pic.png)\n\nend\n"), "native item2: ↓ from the last image opens a new paragraph", (await md()).slice(-40));

  // item 3: Backspace at the start of the paragraph after the code block selects it, again deletes it
  await n.exec(() => window.mdnest.editor.setMarkdown("Intro\n\n```js\ncode\n```\n\nAfter\n")); await sleep(400);
  await n.click("#write > p:last-child"); await n.press("Home"); await n.press("Backspace"); await sleep(250);
  const s1 = await sel();
  await n.screenshot(path.join(OUT, "native-linux-block-selected.png"));
  ok(s1.t === "node" && s1.node === "code_block", "native item3: Backspace selects the code block", s1);
  await n.press("Backspace"); await sleep(250);
  ok((await md()).trim() === "Intro\n\nAfter", "native item3: second Backspace deletes it", await md());

  // item 5: image toolbar zoom + align, written Typora-style
  await n.exec(() => window.mdnest.editor.setMarkdown("Intro\n\n![pic](pic.png)\n\nAfter\n")); await sleep(400);
  await n.click("#write span.md-image img"); await sleep(250);
  ok(await n.exec(() => { const b = document.querySelector(".mdn-imgbar"); return !!b && getComputedStyle(b).display !== "none" && !b.hidden; }), "native item5: image toolbar shown");
  await n.click('.mdn-imgbar [data-a="center"]'); await sleep(200);
  await n.click('.mdn-imgbar [data-a="zoom"]'); await sleep(200); await n.click('.context-menu .mdn-menu-item[data-id="zoom:200"]'); await sleep(250);
  ok((await md()).includes('<img src="pic.png" alt="pic" style="display:block;margin:0 auto;zoom:200%;" />'), "native item5: center + zoom 200% saved Typora-style", await md());
  await n.screenshot(path.join(OUT, "native-linux-image-toolbar.png"));
} catch (e) { ok(false, "native run", e.message); }
finally { await n.close(); }
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
