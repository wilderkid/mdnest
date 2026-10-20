// 0.2.1 bug repros in the REAL app (Tauri + WebKitGTK via tauri-driver), with WebDriver key/pointer actions.
// usage: node tests/native/native-021.mjs path/to/mdnest [display]
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { startNative } from "./wd.mjs";

const app = process.argv[2]; const display = process.argv[3] ?? ":79";
const work = fs.mkdtempSync(path.join(os.tmpdir(), "mdn-021-"));
const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAIAAACQkWg2AAAAHElEQVR4nGP8z8DwnwEJMDGgAcYRCRgFAABmLwIfyPo0uQAAAABJRU5ErkJggg==", "base64");
fs.mkdirSync(path.join(work, "assets")); fs.writeFileSync(path.join(work, "assets", "图 1#.png"), png); fs.writeFileSync(path.join(work, "abs pic.png"), png);
const doc = path.join(work, "笔记.md");
fs.writeFileSync(doc, `# 标题一\n\n正文\n\n![rel](assets/${encodeURIComponent("图 1#.png")})\n\n![abs](${path.join(work, "abs pic.png").replace(/ /g, "%20")})\n\n<div align="center">\n  <b>HTML</b> 块\n</div>\n\n最后一段\n`);
fs.writeFileSync(path.join(work, "删除我.md"), "# bye\n");
const OUT = path.resolve("screenshots/fixes-0.2.1"); fs.mkdirSync(OUT, { recursive: true });
let pass = 0, fail = 0;
const ok = (c, m, info = "") => { console.log((c ? "PASS " : "FAIL ") + m + (c || info === "" ? "" : " — " + String(typeof info === "string" ? info : JSON.stringify(info)).slice(0, 300))); c ? pass++ : fail++; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const n = await startNative({ app, display, port: 4444, args: [doc], env: { LANG: "zh_CN.UTF-8", LANGUAGE: "zh_CN" } });
try {
  await n.waitFor(() => document.body.classList.contains("mdn-ready") && !!document.querySelector("#write h1"));
  await sleep(800);
  const md = () => n.exec(() => window.mdnest.editor.getMarkdown());
  // bug 1: local images through the mdfile protocol (CJK, space, # in the name; relative and absolute)
  const imgs = await n.waitFor(() => { const l = [...document.querySelectorAll("#write img:not(.ProseMirror-separator)")]; return l.length === 2 && l.every((i) => i.complete) ? l.map((i) => [i.naturalWidth, i.src]) : null; });
  ok(imgs.every(([w]) => w > 0), "native bug1: relative + absolute local images display", imgs);
  // bug 6
  ok(!(await n.exec(() => document.querySelector("#write h1").textContent)).includes("#"), "native bug6: no '#' on a freshly opened file");
  // bug 2
  await n.click("#write h1"); await sleep(200);
  ok((await n.exec(() => document.querySelector("#write h1").textContent)).startsWith("# "), "native bug2: click reveals '# '");
  await n.press("Home"); await n.type("#"); await sleep(200);
  ok(await n.exec(() => document.querySelectorAll("#write h2").length) >= 1 && (await md()).startsWith("## 标题一"), "native bug2: typing '#' in the marker → H2", (await md()).slice(0, 30));
  // bug 4: code block with real keys
  await n.click("#write p:last-of-type"); await n.press("End"); await n.press("Enter");
  await n.type("```"); await n.press("Enter"); await sleep(300);
  await n.type("let x = 1;"); await sleep(200);
  ok(/```\nlet x = 1;\n```/.test(await md()), "native bug4: typing into a code block", (await md()).slice(-60));
  await n.press("Enter", ["Control"]); await sleep(150);
  // bug 5: math block
  await n.type("$$"); await n.press("Enter"); await sleep(300); await n.type("a^2+b^2"); await sleep(200);
  ok(/\$\$\na\^2\+b\^2\n\$\$/.test(await md()), "native bug5: typing into a math block", (await md()).slice(-60));
  await n.press("Enter", ["Control"]); await sleep(150);
  // bug 7: mermaid
  await n.type("```mermaid"); await n.press("Enter"); await sleep(300); await n.type("graph TD"); await n.press("Enter"); await n.type("A-->B"); await sleep(1500);
  ok(/```mermaid\ngraph TD\nA-->B\n```/.test(await md()), "native bug7: typing into a mermaid block", (await md()).slice(-60));
  await n.screenshot(path.join(OUT, "native-linux-blocks-after.png"));
  // bug 8: HTML block
  ok(await n.exec(() => { const b = document.querySelector("#write .md-htmlblock"); return getComputedStyle(b.querySelector(".md-htmlblock-editor")).display === "none" && !!b.querySelector(".md-htmlblock-container b"); }), "native bug8: HTML block rendered, source hidden");
  await n.click("#write .md-htmlblock-container"); await sleep(300);
  ok(await n.exec(() => getComputedStyle(document.querySelector("#write .md-htmlblock-editor")).display !== "none"), "native bug8: click shows the source");
  await n.press("End", ["Control"]); await n.press("ArrowUp"); await n.press("End"); await n.type(" ok"); await sleep(200);
  const a = await n.exec(() => {
    const cur = document.querySelector("#write .md-htmlblock .CodeMirror-cursor")?.getBoundingClientRect();
    const line = [...document.querySelectorAll("#write .md-htmlblock .CodeMirror-line")].find((l) => l.textContent.includes(" ok"));
    if (!cur || !line) return null; const r = document.createRange(); r.selectNodeContents(line); const rs = r.getClientRects(); const last = rs[rs.length - 1];
    return { dx: Math.round(cur.left - last.right), dy: Math.round(cur.top - last.top) };
  });
  ok(a && Math.abs(a.dx) <= 2 && Math.abs(a.dy) <= 4, "native bug8: caret aligned with text (WebKitGTK)", a);
  await n.screenshot(path.join(OUT, "native-linux-html-editing-after.png"));
  await n.press("Escape"); await sleep(200);
  ok((await md()).includes("块 ok"), "native bug8: edits kept", (await md()).slice(0, 200));
  // bug 9: slash menu scroll
  await n.click("#write p:last-of-type"); await n.press("End"); await n.press("Enter"); await n.type("/"); await sleep(300);
  let hidden = 0;
  for (let i = 0; i < 18; i++) { await n.press("ArrowDown"); if (!(await n.exec(() => { const m = document.querySelector(".mdn-slash"), s = m?.querySelector(".sel"); if (!s) return false; const A = m.getBoundingClientRect(), B = s.getBoundingClientRect(); return B.top >= A.top - 1 && B.bottom <= A.bottom + 1; }))) hidden++; }
  ok(hidden === 0, "native bug9: slash ↓ keeps the active item visible", hidden);
  await n.screenshot(path.join(OUT, "native-linux-slash-after.png"));
  await n.press("Escape"); await n.press("Backspace");
  // bug 3: delete via the sidebar context menu (real right click) → GIO trash
  await n.click('.file-node-content[title*="删除我"], .file-node-content:not([data-recent]) .file-node-title', { button: 2 }).catch(async () => {
    await n.exec(() => { const el = [...document.querySelectorAll(".file-node-content")].reverse().find((e) => e.textContent.includes("删除我")); el?.setAttribute("data-t021", "1"); });
    await n.click('[data-t021="1"]', { button: 2 });
  });
  await sleep(300);
  const hasDel = await n.exec(() => !!document.querySelector('.context-menu .mdn-menu-item[data-id="delete"]'));
  if (!hasDel) { await n.press("Escape"); await n.exec(() => { const el = [...document.querySelectorAll(".file-node-content")].reverse().find((e) => e.textContent.includes("删除我")); el?.setAttribute("data-t021", "1"); }); await n.click('[data-t021="1"]', { button: 2 }); await sleep(300); }
  await n.click('.context-menu .mdn-menu-item[data-id="delete"]'); await sleep(300);
  const dlg = await n.exec(() => document.querySelector(".modal h3")?.textContent ?? "");
  ok(/删除/.test(dlg), "native bug3/10: delete dialog in Chinese", dlg);
  await n.press("Enter"); await sleep(1200);
  ok(!fs.existsSync(path.join(work, "删除我.md")), "native bug3: file moved to trash");
} catch (e) { ok(false, "native run", e.message); }
finally { await n.close(); }
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
