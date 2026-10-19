// AI polish E2E: suggestion granularity (words / sentences / block / insert), whole-block inline
// rewrites that keep block syntax, usage counters + daily limit. Mock provider only, fake key.
// Needs `npx vite build && npx vite preview --port 4173`. Run: node tests/ai-polish.mjs
import fs from "node:fs";
import path from "node:path";
import { chromium } from "playwright";
import { start as startMock } from "./mock-openai.mjs";

const base = process.argv[2] ?? "http://127.0.0.1:4173/";
const WS = path.resolve("dev-data/workspace");
const OUT = path.resolve("screenshots/ai-polish");
const PORT = Number(process.env.MOCK_OPENAI_PORT) || 1422;
const FAKE_KEY = "test-key-123";
fs.mkdirSync(OUT, { recursive: true });
const DOC = path.join(WS, "ai-polish.md");
const LONG = "MD Nest keeps notes as plain Markdown files. It renders them as you type, without a split preview. Plugins can add commands, panels and suggestions. The AI plugin is off until you enable it.";
const ORIGINAL = `# Draft **title** here\n\n- first item\n- second item\n\n${LONG}\n\nShort line to fix.\n`;

let fail = 0, pass = 0;
const ok = (c, m, info = "") => { console.log((c ? "PASS " : "FAIL ") + m + (c || !info ? "" : " — " + String(info).slice(0, 300))); c ? pass++ : fail++; };

const mock = await startMock(PORT).ready();
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1100, height: 720 } });
const md = () => page.evaluate(() => window.mdnest.editor.getMarkdown());
try {
  fs.writeFileSync(DOC, ORIGINAL);
  await page.goto(base + "?restore=0", { waitUntil: "domcontentloaded" });
  await page.evaluate(async ({ url, key }) => {
    const s = (k, v) => localStorage.setItem("mdnest.plugin.ai." + k, JSON.stringify(v));
    s("enabled", true); s("preset", "custom"); s("baseUrl", url); s("model", "mock-1");
    s("dailyRequestLimit", 0); s("dailyTokenLimit", 0); localStorage.removeItem("mdnest.plugin.ai.usage");
    await window.mdnest.host.secrets.set("ai.apikey", key);
  }, { url: mock.url, key: FAKE_KEY });
  const open = async () => {
    fs.writeFileSync(DOC, ORIGINAL);
    await page.goto(base + `?file=${encodeURIComponent(DOC)}&folder=${encodeURIComponent(WS)}&restore=0`, { waitUntil: "domcontentloaded" });
    await page.waitForFunction(() => window.mdnest?.editor?.view && document.querySelector("#write h1")?.textContent.includes("Draft"));
  };
  const selectBlock = (start, extendToNext = false) => page.evaluate(({ start, extendToNext }) => {
    const v = window.mdnest.editor.view, { state } = v;
    const blocks = [];
    state.doc.descendants((n, p) => { if (n.isTextblock) blocks.push({ n, p }); });
    const i = blocks.findIndex((b) => b.n.textContent.startsWith(start));
    if (i < 0) throw new Error("no block " + start);
    const from = blocks[i].p + 1;
    const to = extendToNext && blocks[i + 1] ? blocks[i + 1].p + 1 : blocks[i].p + 1 + blocks[i].n.content.size;
    v.dispatch(state.tr.setSelection(state.selection.constructor.create(state.doc, from, to)));
    v.focus();
  }, { start, extendToNext });
  const selectRange = (a, b) => page.evaluate(({ a, b }) => {
    const v = window.mdnest.editor.view, { state } = v;
    const blocks = [];
    state.doc.descendants((n, p) => { if (n.isTextblock) blocks.push({ n, p }); });
    const s = blocks.find((x) => x.n.textContent.startsWith(a)), e = blocks.find((x) => x.n.textContent.startsWith(b));
    v.dispatch(state.tr.setSelection(state.selection.constructor.create(state.doc, s.p + 1, e.p + 1 + e.n.content.size)));
    v.focus();
  }, { a, b });
  const rewrite = async (reply) => {
    await page.keyboard.press("Control+k");
    await page.locator(".mdn-prompt input").waitFor({ timeout: 4000 });
    await page.locator(".mdn-prompt input").fill("REPLY: " + reply);
    await page.keyboard.press("Enter");
    await page.locator("#write .md-sug-bar button", { hasText: "Accept" }).last().waitFor({ timeout: 8000 });
  };
  const lastRequestUser = () => String(mock.requests().at(-1)?.user ?? "");
  const reject = async () => { await page.locator("#write .md-sug-bar button", { hasText: "Reject" }).last().click(); };
  const accept = async () => { await page.locator("#write .md-sug-bar button", { hasText: "Accept" }).last().click(); };

  // 1) whole heading (triple-click style range into the next block) → inline only, '#' kept
  await open();
  await selectBlock("Draft", true);
  await rewrite("# Better *title*");
  const sent = lastRequestUser();
  ok(sent.includes("Draft **title** here") && !/<document>\n?#/.test(sent) && !sent.includes("first item"), "heading selection sends inline content only", sent);
  ok(await page.locator("#write .md-sug.md-sug-v-words").count() === 1, "short heading edit uses in-place word diff");
  ok(await page.locator("#write .md-sug-hide").count() > 0, "original hidden (no duplicate struck text) for word diff");
  const diffText = await page.locator("#write .md-sug-diff").last().innerText();
  ok(!diffText.includes("*") && !diffText.includes("#"), "word diff shows rendered text, no Markdown syntax", diffText);
  await page.screenshot({ path: path.join(OUT, "01-heading-word-diff.png") });
  await accept();
  ok((await md()).startsWith("# Better *title*\n"), "accept keeps heading level, no '# #'", (await md()).split("\n")[0]);

  // 2) list item → marker kept
  await selectBlock("first item");
  await rewrite("**Primary** item");
  ok(/^- \*\*Primary\*\* item$/m.test(await md()) === false, "pending suggestion not in document");
  await accept();
  ok(/^- \*\*Primary\*\* item$/m.test(await md()), "list marker reapplied on accept", await md());

  // 3) long paragraph, one sentence changed → sentence highlights, rendered formatting
  const edited = LONG.replace("It renders them as you type, without a split preview.", "It renders them **live** as you type — no split preview.");
  await selectBlock("MD Nest keeps");
  await rewrite(edited);
  ok(await page.locator("#write .md-sug.md-sug-v-sentences").count() === 1, "long single-sentence edit → sentence view");
  const marks = await page.locator("#write .md-sug-card .md-sug-ins").allInnerTexts();
  const marked = marks.join("");
  ok(marked.trim() === "It renders them live as you type — no split preview.", "exactly the changed sentence is highlighted", JSON.stringify(marks));
  ok(await page.locator("#write .md-sug-card strong", { hasText: "live" }).count() === 1, "proposal is rendered (bold), not raw **", "");
  ok(!(await page.locator("#write .md-sug-card").innerText()).includes("**"), "no raw Markdown in card");
  await page.screenshot({ path: path.join(OUT, "02-sentence-diff.png") });
  await reject();
  ok(await md() === (await md()).replace("live", ""), "reject leaves document unchanged");

  // 4) multi-block full rewrite → block card after the last block
  await selectRange("MD Nest keeps", "Short line");
  await rewrite("## Summary\\n\\nEverything was rewritten here. Nothing from before survives. Totally new words appear.\\n\\n- one\\n- two");
  ok(await page.locator("#write .md-sug.md-sug-v-block").count() === 1, "most sentences changed → block rewrite view");
  ok(await page.locator("#write .md-sug-card h2", { hasText: "Summary" }).count() === 1 && await page.locator("#write .md-sug-card li").count() === 2, "block card renders heading and list");
  await page.screenshot({ path: path.join(OUT, "03-block-rewrite.png") });
  await accept();
  const after = await md();
  ok(after.includes("## Summary") && after.includes("- one") && !after.includes("Short line to fix"), "block rewrite replaced both blocks", after);
  await page.keyboard.press("Control+z");
  ok((await md()).includes("Short line to fix") && (await md()).includes("MD Nest keeps"), "one undo restores the blocks");

  // 5) insert (continue) renders formatted text
  await page.evaluate(() => { const v = window.mdnest.editor.view; const end = v.state.doc.content.size - 1; v.dispatch(v.state.tr.setSelection(v.state.selection.constructor.create(v.state.doc, end))); v.focus(); });
  await page.keyboard.press("Control+Shift+P");
  await page.locator("#mdn-palette input").fill("AI: Continue");
  await page.locator("#mdn-palette .pal-item", { hasText: "AI: Continue" }).first().click();
  await page.locator("#write .md-sug-bar button", { hasText: "Accept" }).last().waitFor({ timeout: 8000 });
  ok(await page.locator("#write .md-sug.md-sug-v-insert").count() === 1, "continue uses insert view");
  await page.screenshot({ path: path.join(OUT, "04-insert.png") });
  await reject();

  // 6) usage counters + daily limit in the AI panel
  if (!(await page.locator("#typora-sidebar").isVisible())) await page.keyboard.press("Control+Shift+l");
  await page.locator('#typora-sidebar .sidebar-tab[data-id="p-ai"]').click();
  await page.locator(".mdn-ai-usage").waitFor({ timeout: 4000 });
  const reqs = mock.requests().filter((r) => r.path?.includes("chat")).length;
  const usageText = await page.locator(".mdn-ai-usage").innerText();
  const m = usageText.match(/Today: (\d+) requests? · (≈?)(\d+) tokens/);
  ok(!!m && +m[1] === reqs && +m[3] > 0 && m[2] === "", `panel shows provider-reported usage (${reqs} requests)`, usageText);
  await page.evaluate(() => localStorage.setItem("mdnest.plugin.ai.dailyRequestLimit", JSON.stringify(1)));
  await page.locator(".mdn-ai-input").first().fill("hello");
  const before = mock.requests().length;
  await page.keyboard.press("Enter");
  await page.waitForTimeout(600);
  const chatText = await page.locator(".mdn-ai").first().innerText();
  ok(/Daily AI limit reached \(1 requests\)/.test(chatText) && mock.requests().length === before, "daily request limit refuses without a network call", chatText);
  await page.locator(".mdn-ai-usage").waitFor();
  ok((await page.locator(".mdn-ai-usage").innerText()).includes("limit 1 req"), "panel shows the limit");
  await page.screenshot({ path: path.join(OUT, "05-usage-limit.png") });
  await page.evaluate(() => localStorage.setItem("mdnest.plugin.ai.dailyRequestLimit", JSON.stringify(0)));
} catch (e) {
  ok(false, "unexpected error", e?.stack ?? e);
} finally {
  await page.evaluate(() => window.mdnest?.host?.secrets?.delete("ai.apikey")).catch(() => {});
  await browser.close();
  await mock.close();
  fs.rmSync(DOC, { force: true });
}
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
