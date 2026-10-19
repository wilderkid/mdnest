// Leftover fixes E2E: (1) word diff keeps inline formatting, (2) math rendered in suggestion
// diffs/cards, (3) library meaning cut-off with real nomic-embed-text embeddings (skipped when no
// local embeddings server answers), (4) one-line source/citation lists with ellipsis.
// Mock chat (fake key) + kb-cli; needs `npx vite build`, `vite preview` and
// `cargo build --release --bin kb-cli`. Real embeddings: llama-server --embedding on EMBED_URL.
// Run: node tests/leftovers.mjs [base]   (SHOT_PREFIX=before|after names the screenshots)
import fs from "node:fs";
import path from "node:path";
import { chromium } from "playwright";
import { start as startMock } from "./mock-openai.mjs";

const base = process.argv[2] ?? "http://127.0.0.1:4173/";
const PREFIX = process.env.SHOT_PREFIX ?? "after";
const OUT = path.resolve(process.env.SHOT_DIR ?? "screenshots/leftovers");
const ROOT = path.resolve(process.env.WS_ROOT ?? "dev-data/workspace");
const PORT = Number(process.env.MOCK_OPENAI_PORT) || 1424;
const EMBED_URL = process.env.EMBED_URL ?? "http://127.0.0.1:11434/v1";
const FAKE_KEY = "test-key-123";
fs.mkdirSync(OUT, { recursive: true });
const shot = (page, name) => page.screenshot({ path: path.join(OUT, `${PREFIX}-${name}.png`) });

let fail = 0, pass = 0, skip = 0;
const ok = (c, m, info = "") => { console.log((c ? "PASS " : "FAIL ") + m + (c || !info ? "" : " — " + String(info).slice(0, 300))); c ? pass++ : fail++; };

const mock = await startMock(PORT).ready();
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1100, height: 720 } });
const setAi = (extra = {}) => page.evaluate(async ({ url, key, extra }) => {
  const s = (o, k, v) => localStorage.setItem(`mdnest.plugin.${o}.${k}`, JSON.stringify(v));
  s("ai", "enabled", true); s("ai", "preset", "custom"); s("ai", "baseUrl", url); s("ai", "model", "mock-1");
  s("ai", "dailyRequestLimit", 0); s("ai", "dailyTokenLimit", 0); s("library", "enabled", false);
  for (const [k, v] of Object.entries(extra)) { const [o, a] = k.split("."); v === null ? localStorage.removeItem(`mdnest.plugin.${o}.${a}`) : s(o, a, v); }
  await window.mdnest.host.secrets.set("ai.apikey", key);
}, { url: mock.url, key: FAKE_KEY, extra });
const selectBlock = (start) => page.evaluate((start) => {
  const v = window.mdnest.editor.view, { state } = v;
  let r = null;
  state.doc.descendants((n, p) => { if (!r && n.isTextblock && n.textContent.startsWith(start)) r = [p + 1, p + 1 + n.content.size]; });
  if (!r) throw new Error("no block " + start);
  v.dispatch(state.tr.setSelection(state.selection.constructor.create(state.doc, r[0], r[1])));
  v.focus();
}, start);
const rewrite = async (reply) => {
  await page.keyboard.press("Control+k");
  await page.locator(".mdn-prompt input").waitFor({ timeout: 4000 });
  await page.locator(".mdn-prompt input").fill("REPLY: " + reply);
  await page.keyboard.press("Enter");
  await page.locator("#write .md-sug-bar button", { hasText: "Accept" }).last().waitFor({ timeout: 8000 });
};
const reject = () => page.locator("#write .md-sug-bar button", { hasText: "Reject" }).last().click();
const openPanel = async (id) => {
  await page.evaluate(() => document.body.classList.add("pin-outline"));
  await page.locator(`#typora-sidebar .sidebar-tab[data-id="p-${id}"]`).click();
};
const write = (dir, files) => { fs.rmSync(dir, { recursive: true, force: true }); for (const [f, t] of Object.entries(files)) { fs.mkdirSync(path.dirname(path.join(dir, f)), { recursive: true }); fs.writeFileSync(path.join(dir, f), t); } };

const WS1 = path.join(ROOT, "leftovers-ai");
const DOC = path.join(WS1, "draft.md");
const LONG = "Energy and mass are related. The famous formula is $E=mc^2$ and it is short. Light is fast. Nothing travels faster than light in a vacuum, as far as we know today.";
const ORIGINAL = `# Physics notes\n\nThe **quick** fox reads the docs and the code here.\n\n${LONG}\n\nArea grows as $r^2$ here.\n`;
try {
  write(WS1, { "draft.md": ORIGINAL });
  await page.goto(base + "?restore=0", { waitUntil: "domcontentloaded" });
  await setAi();
  const open = async () => {
    fs.writeFileSync(DOC, ORIGINAL);
    await page.goto(base + `?file=${encodeURIComponent(DOC)}&folder=${encodeURIComponent(WS1)}&restore=0`, { waitUntil: "domcontentloaded" });
    await page.waitForFunction(() => window.mdnest?.editor?.view && document.querySelector("#write h1")?.textContent.includes("Physics"));
  };

  // 1) word diff keeps bold / italic / code / links
  await open();
  await selectBlock("The quick");
  await rewrite("The **lazy** fox reads the [docs](https://example.org/docs) and the `code` *carefully* here.");
  ok(await page.locator("#write .md-sug.md-sug-v-words").count() === 1, "short edit uses the in-place word diff");
  const marks = await page.evaluate(() => {
    const d = document.querySelector("#write .md-sug-diff");
    const q = (s) => [...d.querySelectorAll(s)].map((e) => e.textContent);
    return { strong: q("strong"), em: q("em"), code: q("code"), a: [...d.querySelectorAll("a")].map((a) => a.getAttribute("href") + "|" + a.textContent),
      insStrong: q(".md-sug-ins strong"), oldStrong: q(".md-sug-old strong"), text: d.innerText };
  });
  ok(marks.insStrong.includes("lazy") && marks.oldStrong.includes("quick"), "bold kept on inserted and deleted words", JSON.stringify(marks));
  ok(marks.em.includes("carefully"), "italic rendered in the diff", JSON.stringify(marks.em));
  ok(marks.code.includes("code"), "inline code rendered in the diff", JSON.stringify(marks.code));
  ok(marks.a.includes("https://example.org/docs|docs"), "link rendered with its href", JSON.stringify(marks.a));
  ok(!/[*`\[\]]/.test(marks.text), "no Markdown syntax in the diff", marks.text);
  await shot(page, "01-word-diff-inline-marks");
  await reject();

  // 2) math in the word diff and in sentence / block cards
  await selectBlock("Area grows");
  await rewrite("Area grows as $\\pi r^2$ here.");
  const wordMath = await page.evaluate(() => [...document.querySelectorAll("#write .md-sug-v-words .md-sug-diff .md-inline-math")].map((m) => !!m.querySelector("svg")));
  ok(wordMath.length >= 1, "math atoms in the word diff", JSON.stringify(wordMath));
  await page.waitForFunction(() => [...document.querySelectorAll("#write .md-sug-v-words .md-sug-diff .md-inline-math")].every((m) => m.querySelector("svg")), null, { timeout: 8000 }).catch(() => {});
  ok(await page.evaluate(() => [...document.querySelectorAll("#write .md-sug-v-words .md-sug-diff .md-inline-math")].every((m) => m.querySelector("svg"))), "word diff math rendered with MathJax (SVG)");
  await reject();
  await selectBlock("Energy and mass");
  await rewrite(LONG.replace("it is short", "it links energy $E$ to mass $m$ through $c^2$"));
  ok(await page.locator("#write .md-sug.md-sug-v-sentences").count() === 1, "longer edit uses the sentence card");
  await page.waitForFunction(() => { const m = [...document.querySelectorAll("#write .md-sug-card .md-inline-math")]; return m.length >= 4 && m.every((x) => x.querySelector("svg")); }, null, { timeout: 8000 }).catch(() => {});
  const card = await page.evaluate(() => { const c = document.querySelector("#write .md-sug-card .md-sug-diff"); return { n: c.querySelectorAll(".md-inline-math").length, svg: [...c.querySelectorAll(".md-inline-math")].filter((m) => m.querySelector("svg")).length, text: c.innerText, ins: c.querySelectorAll(".md-sug-ins").length, mathIns: c.querySelectorAll(".md-inline-math.md-sug-ins").length }; });
  ok(card.n >= 4 && card.svg === card.n, "inline math in the sentence card rendered (" + card.svg + "/" + card.n + ")", JSON.stringify(card));
  ok(!/E=mc\^2|c\^2/.test(card.text), "no raw TeX visible in the card", card.text);
  ok(card.ins >= 1 && card.mathIns === 4, "changed sentence still highlighted, including its formulas", JSON.stringify(card));
  await page.locator("#write .md-sug-card").scrollIntoViewIfNeeded();
  await shot(page, "02-math-in-sentence-card");
  await reject();
  await page.evaluate(() => {
    const v = window.mdnest.editor.view, { state } = v, b = [];
    state.doc.descendants((n, p) => { if (n.isTextblock) b.push([n, p]); });
    const s = b.find(([n]) => n.textContent.startsWith("Energy")), e = b.find(([n]) => n.textContent.startsWith("Area"));
    v.dispatch(state.tr.setSelection(state.selection.constructor.create(state.doc, s[1] + 1, e[1] + 1 + e[0].content.size)));
    v.focus();
  });
  await rewrite("Mass is energy: $E=mc^2$.\\n\\n$$\\n\\int_0^1 x^2\\,dx = \\frac{1}{3}\\n$$\\n\\nEverything else is new and different here. Light speed is a limit. Areas scale as $r^2$.");
  await page.waitForFunction(() => { const c = document.querySelector("#write .md-sug-card"); return c && c.querySelector(".md-math-block svg") && [...c.querySelectorAll(".md-inline-math")].every((x) => x.querySelector("svg")); }, null, { timeout: 8000 }).catch(() => {});
  const blk = await page.evaluate(() => { const c = document.querySelector("#write .md-sug-card .md-sug-diff"); return { disp: c.querySelectorAll(".md-math-block svg").length, inl: [...c.querySelectorAll(".md-inline-math")].filter((m) => m.querySelector("svg")).length, text: c.innerText }; });
  ok(blk.disp === 1 && blk.inl >= 2 && !/\\int|\\frac/.test(blk.text), "display and inline math rendered in the rewrite card", JSON.stringify(blk));
  await page.locator("#write .md-sug-card").scrollIntoViewIfNeeded();
  await shot(page, "02b-math-in-rewrite-card");
  await reject();

  // 4) source / citation list: one line each, ellipsis, line number visible
  const WS2 = path.join(ROOT, "leftovers-lib");
  write(WS2, {
    "cats.md": "# Cats\n\nNotes about our two cats.\n\n## Sleep\n\nThey nap on the sofa for most of the afternoon and purr loudly.\n",
    "budget/2026.md": "# Household budget\n\nThe cats' vet expense is the hardest to predict; cats nap a lot, vet bills too.\n",
    "projects/2026/household-renovation/kitchen-and-bathroom-plans.md": "# Renovation plans for the kitchen and the upstairs bathroom\n\n## Where the cats nap while the builders are in\n\nThe cats nap in the spare room during the works.\n",
  });
  fs.rmSync(path.resolve("dev-data/library-data"), { recursive: true, force: true });
  await setAi({ "ai.embedBaseUrl": mock.url, "ai.embedModel": "toy-1", "library.enabled": true, "library.maxDistance": null, "library.cutoffs": null });
  await page.goto(base + `?file=${encodeURIComponent(path.join(WS2, "cats.md"))}&folder=${encodeURIComponent(WS2)}&restore=0`, { waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => window.mdnest?.editor?.view);
  const root2 = fs.realpathSync(WS2);
  for (let t0 = Date.now(); Date.now() - t0 < 20000; await page.waitForTimeout(250)) {
    const s = await page.evaluate((root) => window.mdnest.host.index.call({ op: "stats", root }), root2).catch(() => null);
    if (s && s.files === 3 && s.chunks > 0 && s.embedded === s.chunks) break;
  }
  await openPanel("ai");
  await page.locator(".mdn-ai-input").fill("@library where do the cats nap?");
  await page.keyboard.press("Enter");
  await page.locator(".mdn-ai-sources li").first().waitFor({ timeout: 8000 });
  const lines = await page.evaluate(() => [...document.querySelectorAll(".mdn-ai-sources li")].map((li) => {
    const b = li.querySelector("button"), lab = b.querySelector(".mdn-ai-source-label") ?? b, ln = b.querySelector(".mdn-ai-source-line");
    const lh = parseFloat(getComputedStyle(b).lineHeight) || parseFloat(getComputedStyle(b).fontSize) * 1.4;
    const r = li.getBoundingClientRect(), panel = li.closest(".mdn-ai").getBoundingClientRect();
    return { text: li.innerText, gap: ln ? ln.getBoundingClientRect().left - lab.getBoundingClientRect().right : 0, h: r.height, lh, cut: lab.scrollWidth > lab.clientWidth, lineVisible: !!ln && ln.getBoundingClientRect().right <= panel.right + 1, title: b.title };
  }));
  ok(lines.length >= 3, "three sources listed", JSON.stringify(lines));
  ok(lines.every((l) => l.h < l.lh * 1.6), "every source on one line (no wrapping)", JSON.stringify(lines.map((l) => [l.text, l.h, l.lh])));
  ok(lines.some((l) => l.cut) && lines.every((l) => l.lineVisible), "long label cut with an ellipsis; '· line N' stays visible", JSON.stringify(lines));
  ok(lines.every((l) => /· line \d+$/.test(l.title)), "full label in the tooltip", JSON.stringify(lines.map((l) => l.title)));
  ok(lines.every((l) => l.gap >= 2), "gap kept between label and '· line N'", JSON.stringify(lines.map((l) => l.gap)));
  await shot(page, "04-source-list");
  await openPanel("library");
  await page.locator(".mdn-lib-q").fill("cats nap");
  await page.locator(".mdn-lib-hit").first().waitFor({ timeout: 5000 });
  await page.waitForTimeout(400);
  const hits = await page.evaluate(() => [...document.querySelectorAll(".mdn-lib-results:not(.mdn-lib-related) .mdn-lib-hit-top")].map((t) => {
    const title = t.querySelector(".mdn-lib-hit-title"), lh = parseFloat(getComputedStyle(title).lineHeight) || 18;
    return { h: t.getBoundingClientRect().height, lh, cut: title.scrollWidth > title.clientWidth, right: t.lastElementChild.getBoundingClientRect().right, box: t.closest(".mdn-lib").getBoundingClientRect().right };
  }));
  ok(hits.length >= 2 && hits.every((h) => h.h < h.lh * 1.8 && h.right <= h.box + 1), "library hit titles on one line, badges inside the panel", JSON.stringify(hits));
  await shot(page, "04b-library-hits");

  // 3) meaning cut-off with real nomic-embed-text vectors
  let real = false;
  try { const r = await fetch(EMBED_URL + "/embeddings", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ model: "nomic-embed-text", input: ["x"] }) }); real = r.ok; } catch { /* none */ }
  if (!real) { console.log("SKIP real-embedding cut-off checks (no embeddings server at " + EMBED_URL + ")"); skip += 3; }
  else {
    const WS3 = path.join(ROOT, "leftovers-calib");
    write(WS3, JSON.parse(fs.readFileSync(path.resolve("tests/fixtures/library-calib.json"))).files);
    await setAi({ "ai.embedBaseUrl": EMBED_URL, "ai.embedModel": "nomic-embed-text", "library.enabled": true, "library.maxDistance": null, "library.cutoffs": null });
    await page.goto(base + `?file=${encodeURIComponent(path.join(WS3, "home/boiler.md"))}&folder=${encodeURIComponent(WS3)}&restore=0`, { waitUntil: "domcontentloaded" });
    await page.waitForFunction(() => window.mdnest?.editor?.view);
    const root3 = fs.realpathSync(WS3);
    let s;
    for (let t0 = Date.now(); Date.now() - t0 < 60000; await page.waitForTimeout(400)) {
      s = await page.evaluate((root) => window.mdnest.host.index.call({ op: "stats", root }), root3).catch(() => null);
      if (s && s.files === 20 && s.chunks > 0 && s.embedded === s.chunks && s.model === "nomic-embed-text") break;
    }
    await openPanel("library");
    const searchAll = async (q) => {
      await page.locator(".mdn-lib-q").fill(q);
      await page.waitForTimeout(900);
      await page.waitForFunction(() => document.querySelector(".mdn-lib-results:not(.mdn-lib-related)")?.children.length, null, { timeout: 8000 }).catch(() => {});
      return page.evaluate(() => [...document.querySelectorAll(".mdn-lib-results:not(.mdn-lib-related) .mdn-lib-hit")].map((h) => h.querySelector(".mdn-lib-hit-title").textContent + " [" + [...h.querySelectorAll(".mdn-lib-via")].map((v) => v.textContent).join(",") + "]"));
    };
    const irr = await searchAll("kubernetes ingress configuration");
    ok(!irr.some((h) => /meaning/.test(h)), "unrelated question: no meaning matches (" + irr.length + " hits)", JSON.stringify(irr));
    await shot(page, "03-cutoff-unrelated-query");
    const relv = await searchAll("boiler pressure is low");
    ok(/home\/boiler\.md/.test(relv[0] ?? "") && relv.length <= 3, "relevant question: the right note first, short tail (" + relv.length + " hits)", JSON.stringify(relv));
    const para = await searchAll("tips to fall asleep better");
    ok(/health\/sleep\.md/.test(para[0] ?? "") && /meaning/.test(para[0] ?? ""), "paraphrase without shared keywords still found by meaning", JSON.stringify(para));
    await shot(page, "03b-cutoff-relevant-query");
    fs.rmSync(WS3, { recursive: true, force: true });
  }
  fs.rmSync(WS2, { recursive: true, force: true });
} catch (e) {
  ok(false, "unexpected error", e?.stack ?? e);
  await page.screenshot({ path: "/tmp/leftovers-fail.png" }).catch(() => {});
} finally {
  await page.evaluate(() => window.mdnest?.host?.secrets?.delete("ai.apikey")).catch(() => {});
  await browser.close();
  await mock.close();
  fs.rmSync(WS1, { recursive: true, force: true });
}
console.log(`\n${pass} passed, ${fail} failed${skip ? `, ${skip} skipped` : ""}`);
process.exit(fail ? 1 : 0);
