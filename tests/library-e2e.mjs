// Library E2E (browser host → kb-cli → same Rust index as the desktop app). Mock chat + mock
// embeddings only, fake key. Needs: cargo build --release --bin kb-cli; npx vite build; vite preview :4173.
// Run: node tests/library-e2e.mjs
import fs from "node:fs";
import path from "node:path";
import { chromium } from "playwright";
import { start as startMock } from "./mock-openai.mjs";

const base = process.argv[2] ?? "http://127.0.0.1:4173/";
const WS = path.resolve("dev-data/workspace/lib-e2e");
const OUT = path.resolve("screenshots/library");
const PORT = Number(process.env.MOCK_OPENAI_PORT) || 1423;
const FAKE_KEY = "test-key-123";
fs.mkdirSync(OUT, { recursive: true });
fs.rmSync(WS, { recursive: true, force: true });
fs.rmSync(path.resolve("dev-data/library-data"), { recursive: true, force: true });
const files = {
  "cats.md": "# Cats\n\nNotes about our two cats.\n\n## Sleep\n\nThey nap on the sofa for most of the afternoon and purr loudly.\n\n## Food\n\nWet food twice a day, never milk.\n",
  "dogs.md": "# Dogs\n\nThe puppy barks at the mailman every morning.\n",
  "budget/2026.md": "# Household budget\n\n| item | cost |\n|---|---|\n| rent | 1200 |\n| groceries | 400 |\n\nThe vet expense is the hardest to predict.\n",
  "notes/中文.md": "# 笔记\n\n向量数据库可以做语义搜索，也支持关键词。\n",
  "private/diary.md": "# Diary\n\nTop secret: the cats ate my homework.\n",
};
for (const [f, t] of Object.entries(files)) { fs.mkdirSync(path.dirname(path.join(WS, f)), { recursive: true }); fs.writeFileSync(path.join(WS, f), t); }

let pass = 0, fail = 0;
const ok = (c, m, info = "") => { console.log((c ? "PASS " : "FAIL ") + m + (c || !info ? "" : " — " + String(info).slice(0, 300))); c ? pass++ : fail++; };
const mock = await startMock(PORT).ready();
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1200, height: 760 } });
const stats = () => page.evaluate((root) => window.mdnest.host.index.call({ op: "stats", root }), fs.realpathSync(WS));
const waitIdle = async (pred, ms = 20000) => { const t0 = Date.now(); for (;;) { const s = await stats(); if (pred(s)) return s; if (Date.now() - t0 > ms) return s; await page.waitForTimeout(250); } };
const embedReqs = () => mock.requests().filter((r) => r.path === "/v1/embeddings");
const openPanel = async (id) => {
  await page.evaluate(() => document.body.classList.add("pin-outline"));
  await page.locator(`#typora-sidebar .sidebar-tab[data-id="p-${id}"]`).click();
};
try {
  await page.goto(base + "?restore=0", { waitUntil: "domcontentloaded" });
  await page.evaluate(async ({ url, key }) => {
    const s = (o, k, v) => localStorage.setItem(`mdnest.plugin.${o}.${k}`, JSON.stringify(v));
    s("ai", "enabled", true); s("ai", "preset", "custom"); s("ai", "baseUrl", url); s("ai", "model", "mock-1");
    s("ai", "embedBaseUrl", url); s("ai", "embedModel", "toy-1"); s("ai", "exclude", "private");
    s("library", "enabled", true); localStorage.removeItem("mdnest.plugin.ai.usage");
    await window.mdnest.host.secrets.set("ai.apikey", key);
  }, { url: mock.url, key: FAKE_KEY });
  await page.goto(base + `?folder=${encodeURIComponent(WS)}&restore=0`, { waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => window.mdnest?.editor?.view);

  // 1) initial index: excluded folder skipped, every chunk embedded
  let s = await waitIdle((x) => x.chunks > 0 && x.embedded === x.chunks);
  ok(s.files === 4, "4 files indexed (private/ excluded via the AI exclude list)", JSON.stringify(s));
  ok(s.chunks >= 6 && s.embedded === s.chunks && s.model === "toy-1" && s.dim === 64, "all chunks embedded with the configured model", JSON.stringify(s));
  ok(!embedReqs().some((r) => /diary|homework/i.test(r.user)), "excluded note text never sent to the embeddings endpoint");
  ok(embedReqs().length >= 1 && embedReqs().every((r) => r.count <= 32), "batched embedding requests", embedReqs().map((r) => r.count).join(","));

  // 2) hybrid search panel
  await openPanel("library");
  await page.locator(".mdn-lib-q").fill("kitten");
  await page.locator(".mdn-lib-hit").first().waitFor({ timeout: 5000 });
  const first = await page.locator(".mdn-lib-hit").first().innerText();
  ok(/cats\.md/.test(first) && /meaning/.test(first), "semantic hit: 'kitten' finds cats.md by meaning", first);
  await page.locator(".mdn-lib-q").fill("groceries");
  await page.waitForTimeout(700);
  const g = await page.locator(".mdn-lib-hit").first().innerText();
  ok(/budget\/2026\.md/.test(g) && /keyword/.test(g), "keyword hit for a table cell", g);
  await page.locator(".mdn-lib-q").fill("语义");
  await page.waitForTimeout(700);
  ok(/中文\.md/.test(await page.locator(".mdn-lib-hit").first().innerText()), "CJK substring keyword search");
  await page.locator(".mdn-lib-q").fill("sofa afternoon nap");
  await page.waitForTimeout(700);
  const both = await page.locator(".mdn-lib-hit").first().innerText();
  ok(/Cats › Sleep/.test(both) && /keyword/.test(both) && /meaning/.test(both), "fused result found by both routes ranks first", both);
  await page.screenshot({ path: path.join(OUT, "01-hybrid-search.png") });

  // 3) click → open file at source line with highlight
  await page.locator(".mdn-lib-hit").first().click();
  await page.waitForFunction(() => window.mdnest.state.path?.endsWith("cats.md"));
  await page.waitForTimeout(150);
  const at = await page.evaluate(() => { const v = window.mdnest.editor.view; const $p = v.state.selection.$from; return { text: $p.node(1)?.textContent ?? "", flash: !!document.querySelector("#write .md-cite-flash") }; });
  ok(at.text.startsWith("Sleep") || at.text.startsWith("They nap"), "jumped to the Sleep section (line → block)", JSON.stringify(at));
  ok(at.flash || await page.waitForSelector("#write .md-cite-flash", { timeout: 1000 }).then(() => true, () => false), "target block briefly highlighted");
  await page.screenshot({ path: path.join(OUT, "02-jump-to-source.png") });
  const rel = await page.locator(".mdn-lib-related .mdn-lib-hit").allInnerTexts();
  ok(rel.length > 0 && rel.every((t) => !t.includes("cats.md")), "related notes for the open file exclude itself", JSON.stringify(rel));

  // 4) incremental: edit one file → only its new chunk is embedded; delete → removed
  const before = await stats(); mock.reset();
  fs.appendFileSync(path.join(WS, "dogs.md"), "\n## Walks\n\nTwo long walks in the park, rain or shine.\n");
  s = await waitIdle((x) => x.chunks > before.chunks && x.embedded === x.chunks);
  ok(s.chunks === before.chunks + 1 && s.embedded === s.chunks, "watcher picked up the edit: +1 chunk, embedded", JSON.stringify({ before: before.chunks, after: s.chunks }));
  const sent = embedReqs().reduce((n, r) => n + r.count, 0);
  ok(sent >= 1 && sent <= 2, "only changed chunks re-embedded (" + sent + ")");
  fs.rmSync(path.join(WS, "notes/中文.md"));
  s = await waitIdle((x) => x.files === 3);
  ok(s.files === 3, "deleted file dropped from the index", JSON.stringify(s));

  // 5) @library in chat with clickable citations
  await openPanel("ai");
  mock.reset();
  await page.locator(".mdn-ai-input").fill("@library how long do the cats nap?");
  await page.keyboard.press("Enter");
  await page.locator(".mdn-ai-cite").first().waitFor({ timeout: 8000 });
  const chatReq = mock.requests().find((r) => r.path === "/v1/chat/completions");
  ok(!!chatReq && chatReq.user.includes("<sources>") && /\[1\] cats\.md › Cats › Sleep/.test(chatReq.user), "chat request carries numbered sources", chatReq?.user?.slice(0, 300));
  ok(!chatReq.user.includes("@library") && !/diary|homework/i.test(chatReq.user), "mention stripped; excluded note absent");
  const srcList = await page.locator(".mdn-ai-sources li").allInnerTexts();
  ok(srcList.length >= 1 && /cats\.md › Cats › Sleep\s+· line \d+/.test(srcList[0]), "sources listed under the answer", JSON.stringify(srcList));
  await page.evaluate(() => window.mdnest.editor.setMarkdown("# scratch\n"));
  await page.evaluate(() => { window.mdnest.state.path = null; });
  await page.locator(".mdn-ai-cite").first().click();
  await page.waitForFunction(() => window.mdnest.state.path?.endsWith("cats.md"));
  await page.waitForTimeout(150);
  const cite = await page.evaluate(() => window.mdnest.editor.view.state.selection.$from.node(1)?.textContent ?? "");
  ok(/^(Sleep|They nap)/.test(cite), "citation [1] opens cats.md at the cited section", cite);
  await page.screenshot({ path: path.join(OUT, "03-library-chat-citations.png") });
  mock.reset();
  // toy hashed embeddings collide a lot; a strict cut-off makes nonsense match nothing
  await page.evaluate(() => localStorage.setItem("mdnest.plugin.library.maxDistance", "0.3"));
  await page.locator(".mdn-ai-input").fill("@library qwzx vvkj");
  await page.keyboard.press("Enter");
  await page.waitForTimeout(800);
  const none = await page.locator(".mdn-ai-assistant").last().innerText();
  ok(/Nothing in @library matches/.test(none) && !mock.requests().some((r) => r.path === "/v1/chat/completions"), "no sources → says so, no model call", none);

  // 6) library exclude → folder dropped on re-index
  await page.evaluate(() => localStorage.setItem("mdnest.plugin.library.exclude", JSON.stringify("budget")));
  await page.evaluate(() => window.mdnest.runCommand("library.reindex"));
  s = await waitIdle((x) => x.files === 2);
  ok(s.files === 2, "library exclude drops budget/ on re-index", JSON.stringify(s));

  // 7) dark theme panel, keyword-only fallback when embeddings fail
  await page.evaluate(() => localStorage.setItem("mdnest.plugin.ai.embedModel", JSON.stringify("missing")));
  await page.evaluate(() => window.mdnest.runCommand("library.rebuild"));
  await openPanel("library");
  await page.waitForFunction(() => /Embeddings unavailable/.test(document.querySelector(".mdn-lib-status")?.textContent ?? ""), null, { timeout: 10000 }).catch(() => {});
  const st = await page.locator(".mdn-lib-status").innerText();
  ok(/Embeddings unavailable: no embeddings at 127\.0\.0\.1/.test(st), "embedding failure is reported", st);
  await page.locator(".mdn-lib-q").fill("puppy");
  await page.waitForTimeout(700);
  ok(/dogs\.md/.test(await page.locator(".mdn-lib-hit").first().innerText().catch(() => "")), "keyword search still works without vectors");
  await page.screenshot({ path: path.join(OUT, "04-keyword-fallback.png") });

  // 8) library off → nothing indexed, @library gone
  await page.evaluate(() => { localStorage.setItem("mdnest.plugin.library.enabled", "false"); localStorage.setItem("mdnest.plugin.ai.embedModel", JSON.stringify("toy-1")); });
  await page.goto(base + `?folder=${encodeURIComponent(WS)}&restore=0`, { waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => window.mdnest?.editor?.view);
  mock.reset();
  await page.waitForTimeout(1200);
  ok(embedReqs().length === 0, "library off: no embedding requests at startup");
  await openPanel("library");
  ok(/library is off/i.test(await page.locator(".mdn-lib").innerText()), "panel shows the off state");
  await page.screenshot({ path: path.join(OUT, "05-library-off.png") });
} catch (e) {
  ok(false, "unexpected error", e?.stack ?? e);
} finally {
  await page.evaluate(() => window.mdnest?.host?.secrets?.delete("ai.apikey")).catch(() => {});
  await browser.close();
  await mock.close();
  fs.rmSync(WS, { recursive: true, force: true });
}
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
