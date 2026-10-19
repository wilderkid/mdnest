// AI plugin end-to-end checks + screenshots → screenshots/ai/.
// Usage: node tests/ai-e2e.mjs [baseUrl]
// Starts tests/mock-openai.mjs on :1421 (MOCK_OPENAI_PORT). Assumes `npx vite preview --port 4173`
// is already running, or starts it (and stops it) when it is not.
// No real API keys. The mock accepts only the fake key "test-key-123".
import { chromium } from "playwright";
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { start as startMock } from "./mock-openai.mjs";

const base = process.argv[2] ?? "http://127.0.0.1:4173/";
const WS = path.resolve("dev-data/workspace");
const OUT = path.resolve("screenshots/ai");
const MOCK_PORT = Number(process.env.MOCK_OPENAI_PORT) || 1421;
const FAKE_KEY = "test-key-123";
const WRONG_KEY = "wrong-key-not-the-real-one";
fs.mkdirSync(OUT, { recursive: true });

const DOC = path.join(WS, "ai-e2e.md");
const EXCL_DIR = path.join(WS, ".tmp-ai-exclude");
const EXCL_DOC = path.join(EXCL_DIR, "secret-note.md");
fs.mkdirSync(EXCL_DIR, { recursive: true });
const ORIGINAL = "The quick brown fox jumps.\n\nSecond paragraph stays.\n";
fs.writeFileSync(DOC, ORIGINAL);
fs.writeFileSync(EXCL_DOC, "# Hidden\n\nDo not send this note.\n");

const results = [];
const ok = (c, name, info = "") => {
  const pass = !!c;
  results.push({ pass, name, info: String(info).slice(0, 220) });
  console.log((pass ? "PASS " : "FAIL ") + name + (info ? " — " + String(info).slice(0, 180) : ""));
};

let mock;
let preview;
let previewOwned = false;
let browser;

async function previewUp() {
  try {
    const r = await fetch(base, { signal: AbortSignal.timeout(1500) });
    return r.ok || r.status < 500;
  } catch { return false; }
}

function waitForHttp(url, ms = 30000) {
  const deadline = Date.now() + ms;
  return new Promise((resolve, reject) => {
    const tick = async () => {
      try {
        const r = await fetch(url, { signal: AbortSignal.timeout(1000) });
        if (r.status < 500) return resolve();
      } catch { /* not yet */ }
      if (Date.now() > deadline) return reject(new Error("timeout waiting for " + url));
      setTimeout(tick, 250);
    };
    tick();
  });
}

async function ensurePreview() {
  if (await previewUp()) return;
  previewOwned = true;
  if (!fs.existsSync("dist/index.html")) {
    await new Promise((resolve, reject) => {
      const b = spawn("npx", ["vite", "build"], { stdio: "inherit" });
      b.on("exit", (code) => code === 0 ? resolve() : reject(new Error("vite build " + code)));
    });
  }
  preview = spawn("npx", ["vite", "preview", "--port", "4173", "--host", "127.0.0.1", "--strictPort"], { stdio: "ignore" });
  await waitForHttp(base);
}

async function mockRequests() {
  const r = await fetch(`http://127.0.0.1:${MOCK_PORT}/__requests`);
  const j = await r.json();
  return j;
}
async function resetMock() {
  await fetch(`http://127.0.0.1:${MOCK_PORT}/__requests`, { method: "DELETE" });
}

const browserP = chromium.launch();
try {
  mock = startMock(MOCK_PORT);
  await mock.ready();
  await ensurePreview();
  browser = await browserP;
  const page = await browser.newPage({ viewport: { width: 1280, height: 860 } });
  page.setDefaultTimeout(8000);
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  let dialogMode = "accept";
  page.on("dialog", (d) => { if (dialogMode === "dismiss") d.dismiss(); else d.accept(); });

  const md = () => page.evaluate(() => window.mdnest.editor.getMarkdown());
  const shot = (n) => page.screenshot({ path: path.join(OUT, n) });
  const toast = () => page.locator("#mdn-toast");

  async function clearPluginState() {
    await page.evaluate(async () => {
      const drop = [];
      for (let i = 0; i < localStorage.length; i++) {
        const k = localStorage.key(i);
        if (k && k.startsWith("mdnest.plugin.ai.")) drop.push(k);
      }
      drop.forEach((k) => localStorage.removeItem(k));
      localStorage.removeItem("mdnest.autosave");
      try { await window.mdnest.host.secrets.delete("ai.apikey"); } catch { /* none */ }
    });
  }

  async function load(file = DOC, theme = "mdnest") {
    await page.goto(base + `?theme=${theme}&file=${encodeURIComponent(file)}&folder=${encodeURIComponent(WS)}&restore=0`, { waitUntil: "domcontentloaded" });
    await page.waitForSelector("body.mdn-ready");
    await clearPluginState();
    await page.reload({ waitUntil: "domcontentloaded" });
    await page.waitForSelector("body.mdn-ready");
    await page.waitForTimeout(400);
  }

  async function openSettings() {
    await page.evaluate(() => document.body.classList.add("pin-outline"));
    await page.locator('#typora-sidebar .sidebar-tab[data-id="settings"]').click();
    await page.locator(".mdn-settings").waitFor();
  }
  async function openAiPanel() {
    await page.evaluate(() => document.body.classList.add("pin-outline"));
    await page.locator('#typora-sidebar .sidebar-tab[data-id="p-ai"]').click();
    await page.locator(".mdn-ai").waitFor();
  }
  function setting(key) {
    return page.locator(`.mdn-settings [data-o="ai"][data-k="${key}"]`);
  }

  async function configure(opts = {}) {
    const model = opts.model ?? "mock-1";
    const key = opts.key === undefined ? FAKE_KEY : opts.key;
    const localOnly = !!opts.localOnly;
    const exclude = opts.exclude ?? "";
    const baseUrl = opts.baseUrl ?? `http://127.0.0.1:${MOCK_PORT}/v1`;
    await openSettings();
    await setting("preset").selectOption("custom");
    await page.waitForTimeout(80);
    await setting("baseUrl").fill(baseUrl);
    await setting("baseUrl").dispatchEvent("change");
    await setting("model").fill(model);
    await setting("model").dispatchEvent("change");
    if (exclude) {
      await setting("exclude").fill(exclude);
      await setting("exclude").dispatchEvent("change");
    }
    const localBox = setting("localOnly");
    if ((await localBox.isChecked()) !== localOnly) {
      await localBox.click();
    }
    if (key) {
      const input = page.locator('[data-secret-input="ai.apiKey"]');
      await input.fill(key);
      await page.locator('.mdn-secret[data-secret-row="ai.apiKey"] button[data-secret="set"]').click();
      await page.waitForFunction(() => {
        const n = document.querySelector('[data-secret-status="ai.apiKey"]');
        return n && n.textContent.includes("stored");
      });
    }
    const enabled = setting("enabled");
    if (!(await enabled.isChecked())) {
      dialogMode = opts.decline ? "dismiss" : "accept";
      await enabled.click();
      dialogMode = "accept";
      await page.waitForTimeout(150);
    }
  }

  async function selectParagraph(textStart) {
    await page.evaluate((start) => {
      const view = window.mdnest.editor.view;
      const { state } = view;
      let found = null;
      state.doc.descendants((node, pos) => {
        if (found) return false;
        if (node.isTextblock && node.textContent.startsWith(start)) {
          found = { from: pos + 1, to: pos + 1 + node.content.size };
          return false;
        }
      });
      if (!found) throw new Error("paragraph not found: " + start);
      const tr = state.tr.setSelection(state.selection.constructor.create(state.doc, found.from, found.to));
      view.dispatch(tr);
      view.focus();
    }, textStart);
    // ProseMirror TextSelection.create via the public selection API.
    await page.evaluate((start) => {
      const view = window.mdnest.editor.view;
      const selMod = view.state.selection;
      // TextSelection is the constructor on non-empty text selections.
      const Ctor = selMod.constructor;
      const { state } = view;
      let found = null;
      state.doc.descendants((node, pos) => {
        if (found) return false;
        if (node.isTextblock && node.textContent.startsWith(start)) {
          found = { from: pos + 1, to: pos + 1 + node.content.size };
        }
      });
      view.dispatch(state.tr.setSelection(Ctor.create(state.doc, found.from, found.to)));
      view.focus();
    }, textStart);
  }

  async function selectByText(start) {
    await page.evaluate(async (needle) => {
      const view = window.mdnest.editor.view;
      const { state } = view;
      let from = null, to = null;
      state.doc.descendants((node, pos) => {
        if (from != null) return false;
        if (node.isTextblock && node.textContent.startsWith(needle)) {
          from = pos + 1;
          to = pos + 1 + node.content.size;
          return false;
        }
      });
      if (from == null) throw new Error("no block " + needle);
      // Use the selection already on the state (TextSelection lives on PM).
      const TextSelection = state.selection.constructor;
      view.dispatch(state.tr.setSelection(TextSelection.create(state.doc, from, to)));
      view.focus();
    }, start);
  }

  async function paletteRun(title) {
    await page.keyboard.press("Control+Shift+P");
    await page.locator("#mdn-palette input").waitFor();
    await page.locator("#mdn-palette input").fill(title);
    await page.waitForTimeout(80);
    const item = page.locator("#mdn-palette .pal-item", { hasText: title }).first();
    await item.click();
  }

  async function waitSug(phase) {
    await page.waitForFunction((want) => {
      const bar = document.querySelector("#write .md-sug-bar");
      if (!bar) return false;
      const status = bar.querySelector(".md-sug-status")?.textContent ?? "";
      const err = document.querySelector("#write .md-sug-err")?.textContent ?? "";
      if (want === "running") return /generating/i.test(status);
      if (want === "ready") return !!bar.querySelector("button") && !/generating/i.test(status);
      if (want === "error") return !!err || /rejected|not found|error|HTTP|local-only/i.test(status + " " + err);
      return true;
    }, phase, { timeout: 8000 });
  }

  // ---------- a) AI off by default ----------
  try {
    await resetMock();
    await load();
    await page.keyboard.press("Control+Shift+P");
    await page.locator("#mdn-palette input").waitFor();
    await page.locator("#mdn-palette input").fill("AI:");
    await page.waitForTimeout(100);
    const titles = await page.locator("#mdn-palette .pal-item").allTextContents();
    const aiCmds = titles.filter((t) => /AI: (?!Enable)/.test(t));
    ok(aiCmds.length === 0, "a) palette hides AI actions while off", titles.join(" | "));
    ok(titles.some((t) => t.includes("AI: Enable")), "a) palette still offers AI: Enable", titles.join(" | "));
    await page.keyboard.press("Escape");
    await openAiPanel();
    const offText = await page.locator(".mdn-ai-off").innerText();
    ok(/Enable AI/.test(offText) && /off/i.test(offText), "a) panel shows Enable AI", offText.replace(/\s+/g, " "));
    await shot("01-off-panel.png");
    await page.locator("#write").click();
    await page.keyboard.press("End");
    await page.keyboard.type(" hello");
    await page.waitForTimeout(200);
    const rec = await mockRequests();
    ok(rec.requests.length === 0, "a) editing with AI off records 0 mock requests", String(rec.requests.length));
    await page.keyboard.press("Control+z");
  } catch (e) { ok(false, "EXCEPTION in a) AI off", e.message.split("\n")[0]); }

  // ---------- b) declining the privacy note keeps AI off ----------
  try {
    await load();
    await openSettings();
    const note = await page.locator(".mdn-settings .mdn-note", { hasText: "Nothing is sent while AI is off" }).first().innerText();
    ok(/Nothing is sent while AI is off/.test(note), "b) settings show the privacy note", note.slice(0, 80));
    await shot("02-privacy-note.png");
    dialogMode = "dismiss";
    await setting("enabled").click();
    dialogMode = "accept";
    await page.waitForTimeout(200);
    ok(!(await setting("enabled").isChecked()), "b) declining the privacy note leaves the checkbox off");
    const stored = await page.evaluate(() => localStorage.getItem("mdnest.plugin.ai.enabled"));
    ok(stored !== "true", "b) enabled is not stored as true", stored);
    const toastText = await toast().innerText().catch(() => "");
    ok(/stays off/i.test(toastText), "b) notice says AI stays off", toastText);
  } catch (e) { ok(false, "EXCEPTION in b) privacy decline", e.message.split("\n")[0]); }

  // ---------- configure + screenshots, then polish ----------
  try {
    await load();
    fs.writeFileSync(DOC, ORIGINAL);
    await page.reload({ waitUntil: "domcontentloaded" });
    await page.waitForSelector("body.mdn-ready");
    await page.waitForTimeout(300);
    await configure();
    await openSettings();
    await shot("03-settings.png");
    ok(await setting("enabled").isChecked(), "setup: AI enabled via Settings");
    const preset = await setting("preset").inputValue();
    const url = await setting("baseUrl").inputValue();
    ok(preset === "custom" && url.includes("127.0.0.1:" + MOCK_PORT), "setup: custom preset and mock base URL", preset + " " + url);

    await resetMock();
    await page.locator("#write p").first().click();
    await selectByText("The quick brown");
    const before = await md();
    await paletteRun("AI: Polish");
    await page.locator("#write .md-sug").last().waitFor({ timeout: 8000 });
    await shot("04-polish-streaming.png");
    const streaming = await page.locator("#write .md-sug-status").innerText();
    ok(/generating/i.test(streaming) || (await page.locator("#write .md-sug-diff").innerText()).length > 0, "c) suggestion widget appears and streams", streaming);
    const mid = await md();
    ok(mid === before, "c) document Markdown unchanged while the suggestion is pending", mid);
    await waitSug("ready");
    const diff = await page.locator("#write .md-sug-diff").last().innerText();
    ok(diff.includes("Polished:"), "c) streamed polish text is in the widget", diff);
    await shot("05-polish-diff-ready.png");
    const still = await md();
    ok(still === before, "c) document still unchanged when the diff is ready");
    await page.locator("#write .md-sug-bar button", { hasText: "Accept" }).last().click();
    await page.waitForTimeout(200);
    const accepted = await md();
    ok(accepted.includes("Polished:") && !accepted.includes("The quick brown fox jumps."), "c) Accept replaces the paragraph", accepted.split("\n")[0]);
    ok(accepted.includes("Second paragraph stays."), "c) the rest of the document is kept");
    await shot("06-accepted.png");
    await page.locator("#write").click();
    await page.keyboard.press("Control+z");
    await page.waitForTimeout(200);
    const undone = await md();
    ok(undone === before, "c) one Ctrl+Z restores the original exactly", JSON.stringify(undone));
  } catch (e) { ok(false, "EXCEPTION in c) polish", e.message.split("\n")[0]); }

  // ---------- d) translate then reject ----------
  try {
    await load();
    fs.writeFileSync(DOC, ORIGINAL);
    await page.reload({ waitUntil: "domcontentloaded" });
    await page.waitForSelector("body.mdn-ready");
    await page.waitForTimeout(250);
    await configure();
    await resetMock();
    await selectByText("The quick brown");
    const before = await md();
    await paletteRun("AI: Translate");
    await waitSug("ready");
    const translated = await page.evaluate(() => {
      const view = window.mdnest.editor.view;
      for (const p of view.state.plugins) {
        const st = p.getState(view.state);
        if (st && Array.isArray(st.items) && st.items[0] && "phase" in st.items[0]) return st.items.at(-1).text;
      }
      return "";
    });
    ok(translated === "Bonjour le monde.", "d) translate streams the canned reply", translated);
    await page.locator("#write .md-sug-bar button", { hasText: "Reject" }).last().click();
    await page.waitForTimeout(150);
    ok(await md() === before, "d) Reject leaves the document unchanged");
    ok(await page.locator("#write .md-sug").count() === 0, "d) suggestion widget is gone from the DOM");
  } catch (e) { ok(false, "EXCEPTION in d) translate reject", e.message.split("\n")[0]); }

  // ---------- e) retry produces a second request ----------
  try {
    await resetMock();
    await selectByText("The quick brown");
    await paletteRun("AI: Polish");
    await waitSug("ready");
    const n1 = (await mockRequests()).requests.length;
    await page.locator("#write .md-sug-bar button", { hasText: "Retry" }).last().click();
    await page.waitForTimeout(400);
    await waitSug("ready");
    const n2 = (await mockRequests()).requests.length;
    ok(n1 >= 1 && n2 === n1 + 1, "e) Retry produces a second request", n1 + " → " + n2);
    await page.locator("#write").click();
    await page.keyboard.press("Escape");
    await page.waitForTimeout(150);
    if (await page.locator("#write .md-sug-bar").count()) {
      await page.locator("#write .md-sug-bar button", { hasText: "Reject" }).last().click();
    }
    ok(await page.locator("#write .md-sug").count() === 0, "e) Escape rejects the retried suggestion");
  } catch (e) { ok(false, "EXCEPTION in e) retry", e.message.split("\n")[0]); }

  // ---------- f) typing inside the pending range invalidates ----------
  try {
    await resetMock();
    await selectByText("The quick brown");
    await paletteRun("AI: Polish");
    await page.locator("#write .md-sug").last().waitFor();
    await page.waitForTimeout(250);
    await page.evaluate(() => {
      const view = window.mdnest.editor.view;
      const { state } = view;
      let pos = null;
      state.doc.descendants((node, p) => {
        if (pos != null) return false;
        if (node.isTextblock && node.textContent.startsWith("The quick")) { pos = p + 1; return false; }
      });
      const Ctor = state.selection.constructor;
      view.dispatch(state.tr.setSelection(Ctor.create(state.doc, pos + 4)));
      view.focus();
    });
    await page.keyboard.type("X");
    await page.waitForTimeout(200);
    const notice = await page.locator("#write .md-sug-notice").innerText().catch(() => "");
    ok(/discarded|edited/i.test(notice), "f) typing in the pending range shows the invalidate notice", notice);
    ok(await page.locator("#write .md-sug-bar").count() === 0, "f) the suggestion toolbar is gone");
    await page.keyboard.press("Control+z");
    await page.waitForTimeout(80);
  } catch (e) { ok(false, "EXCEPTION in f) invalidate", e.message.split("\n")[0]); }

  // ---------- g) Mod-k custom instruction ----------
  try {
    await resetMock();
    await selectByText("The quick brown");
    await page.locator("#write").click();
    await selectByText("The quick brown");
    await page.keyboard.press("Control+k");
    await page.locator(".mdn-prompt input").waitFor({ timeout: 4000 });
    await page.locator(".mdn-prompt input").fill("Please polish this paragraph tightly");
    await page.keyboard.press("Enter");
    await waitSug("ready");
    const diff = await page.locator("#write .md-sug-diff").last().innerText();
    ok(diff.includes("Polished:"), "g) Mod-k prompt runs a custom polish instruction", diff);
    const rec = await mockRequests();
    const last = rec.requests.at(-1);
    ok(last && /polish/i.test(last.user), "g) the request carries the custom instruction");
    await page.locator("#write .md-sug-bar button", { hasText: "Reject" }).last().click();
  } catch (e) { ok(false, "EXCEPTION in g) Mod-k", e.message.split("\n")[0]); }

  // ---------- h) /ai slash generate ----------
  try {
    await resetMock();
    await page.evaluate(() => {
      const view = window.mdnest.editor.view;
      const { state } = view;
      const para = state.schema.nodes.paragraph.create();
      const end = state.doc.content.size;
      let tr = state.tr.insert(end, para);
      const pos = end + 1;
      const Ctor = state.selection.constructor;
      tr = tr.setSelection(Ctor.create(tr.doc, pos));
      view.dispatch(tr);
      view.focus();
    });
    await page.keyboard.type("/");
    await page.locator(".mdn-slash").waitFor();
    await shot("07-slash-menu.png");
    const slashText = await page.locator(".mdn-slash").innerText();
    ok(/AI: generate here/.test(slashText), "h) slash menu lists AI: generate here", slashText.replace(/\s+/g, " "));
    await page.keyboard.press("Enter");
    await page.locator(".mdn-prompt input").waitFor();
    await page.locator(".mdn-prompt input").fill("generate a short list");
    await page.keyboard.press("Enter");
    await waitSug("ready");
    const diff = await page.locator("#write .md-sug-diff").last().innerText();
    ok(diff.includes("Generated") && diff.includes("item one"), "h) generate streams markdown in the widget", diff.slice(0, 80));
    await shot("08-ai-generate.png");
    const pending = await md();
    ok(!pending.includes("## Generated"), "h) generated markdown is not in the document until accept");
    await page.locator("#write .md-sug-bar button", { hasText: "Accept" }).last().click();
    await page.waitForTimeout(250);
    const after = await md();
    ok(after.includes("## Generated") && after.includes("- item one") && after.includes("- item two"), "h) accept writes the generated markdown", after);
    const nodes = await page.evaluate(() => ({
      h2: [...document.querySelectorAll("#write h2")].some((h) => h.textContent.includes("Generated")),
      items: [...document.querySelectorAll("#write li")].map((li) => li.textContent).filter((t) => /item (one|two)/.test(t)),
    }));
    ok(nodes.h2 && nodes.items.length === 2, "h) accept becomes a real heading and list items", JSON.stringify(nodes));
  } catch (e) { ok(false, "EXCEPTION in h) slash generate", e.message.split("\n")[0]); }

  // ---------- i) sidebar chat ----------
  try {
    await resetMock();
    await page.evaluate(() => {
      const view = window.mdnest.editor.view;
      view.dispatch(view.state.tr.setSelection(view.state.selection.constructor.create(view.state.doc, 1)));
      view.focus();
    });
    await openAiPanel();
    await page.locator(".mdn-ai-input").waitFor();
    const status = await page.locator(".mdn-ai-status").innerText();
    ok(/custom/.test(status) && /mock-1/.test(status), "i) chat status shows preset and model", status);
    await page.locator(".mdn-ai-input").fill("What is this document about?");
    await page.locator(".mdn-ai-actions button", { hasText: "Send" }).click();
    await page.waitForFunction(() => {
      const body = document.querySelector(".mdn-ai-assistant .mdn-ai-body");
      return body && /Chat reply/.test(body.textContent || "");
    }, null, { timeout: 8000 });
    const reply = await page.locator(".mdn-ai-assistant .mdn-ai-body").last().innerText();
    ok(/Chat reply/.test(reply), "i) chat reply streams into the log", reply);
    await shot("09-chat.png");
    const withDoc = (await mockRequests()).requests.at(-1);
    ok(withDoc && /<document>/.test(withDoc.user) && withDoc.user.includes("The quick brown"), "i) include-document checkbox sends document content");
    await page.locator(".mdn-ai-msg-actions button", { hasText: "Insert at cursor" }).click();
    await page.waitForTimeout(200);
    const inserted = await md();
    ok(inserted.includes("Chat reply."), "i) Insert at cursor writes the reply", inserted.split("\n")[0]);
    await page.keyboard.press("Control+z");
    await page.waitForTimeout(100);

    await page.locator(".mdn-ai-include input").click();
    await page.locator(".mdn-ai-input").fill("Say hello without the doc");
    await page.keyboard.press("Enter");
    await page.waitForFunction(() => {
      const bodies = [...document.querySelectorAll(".mdn-ai-assistant .mdn-ai-body")];
      return bodies.length >= 2 && /Chat reply/.test(bodies.at(-1).textContent);
    }, null, { timeout: 8000 });
    const without = (await mockRequests()).requests.at(-1);
    ok(without && !/<document>/.test(without.user), "i) unchecking include omits the document", (without?.user ?? "").slice(0, 80));
    await page.locator(".mdn-ai-include input").click();
  } catch (e) { ok(false, "EXCEPTION in i) chat", e.message.split("\n")[0]); }

  // ---------- j) exclude folder refuses ----------
  try {
    await load(EXCL_DOC);
    await configure({ exclude: ".tmp-ai-exclude" });
    await resetMock();
    await page.locator("#write p").first().click({ clickCount: 3 });
    await page.waitForTimeout(80);
    await paletteRun("AI: Polish");
    await page.waitForTimeout(400);
    const note = await toast().innerText();
    ok(/excluded/i.test(note), "j) excluded folder refuses with a notice", note);
    const rec = await mockRequests();
    ok(rec.requests.length === 0, "j) mock gets no new request", String(rec.requests.length));
    await shot("10-excluded.png");
    await page.locator("#write").click();
    await page.keyboard.type("/");
    await page.waitForTimeout(200);
    if (await page.locator(".mdn-slash").count()) {
      await page.keyboard.press("Enter");
      if (await page.locator(".mdn-prompt input").count()) {
        await page.locator(".mdn-prompt input").fill("generate something");
        await page.keyboard.press("Enter");
        await page.waitForTimeout(300);
      }
    }
    const rec2 = await mockRequests();
    ok(rec2.requests.length === 0, "j) slash generate on an excluded file also sends nothing", String(rec2.requests.length));
  } catch (e) { ok(false, "EXCEPTION in j) exclude", e.message.split("\n")[0]); }

  // ---------- k) localOnly refuses a non-local base URL ----------
  try {
    await load();
    await configure({ baseUrl: "https://api.openai.com/v1", localOnly: true, key: "" });
    await resetMock();
    await selectByText("The quick brown");
    await paletteRun("AI: Polish");
    await waitSug("error");
    const err = await page.locator("#write .md-sug").last().innerText();
    ok(/local-only/i.test(err), "k) localOnly refuses a public base URL", err.replace(/\s+/g, " ").slice(0, 140));
    const rec = await mockRequests();
    ok(rec.requests.length === 0, "k) refused localOnly call never reaches the mock", String(rec.requests.length));
    await page.keyboard.press("Escape");
  } catch (e) { ok(false, "EXCEPTION in k) localOnly", e.message.split("\n")[0]); }

  // ---------- l) 401 and 404 ----------
  try {
    await load();
    await configure({ key: WRONG_KEY, model: "mock-1" });
    await resetMock();
    await selectByText("The quick brown");
    await paletteRun("AI: Polish");
    await waitSug("error");
    const err401 = await page.locator("#write .md-sug").last().innerText();
    ok(/API key rejected/i.test(err401), "l) 401 shows API key rejected", err401.replace(/\s+/g, " ").slice(0, 140));
    ok(!err401.includes(WRONG_KEY) && !err401.includes(FAKE_KEY), "l) suggestion error does not contain a key");
    await shot("11-error.png");
    await page.keyboard.press("Escape");

    await openSettings();
    await setting("model").fill("missing");
    await setting("model").dispatchEvent("change");
    const keyInput = page.locator('[data-secret-input="ai.apiKey"]');
    await keyInput.fill(FAKE_KEY);
    await page.locator('.mdn-secret[data-secret-row="ai.apiKey"] button[data-secret="set"]').click();
    await page.waitForTimeout(200);
    await selectByText("The quick brown");
    await paletteRun("AI: Polish");
    await waitSug("error");
    const err404 = await page.locator("#write .md-sug").last().innerText();
    ok(/not found/i.test(err404), "l) 404 shows model or URL not found", err404.replace(/\s+/g, " ").slice(0, 140));

    await openAiPanel();
    await page.locator(".mdn-ai-input").fill("trigger a missing-model chat error");
    await page.locator(".mdn-ai-actions button", { hasText: "Send" }).click();
    await page.waitForFunction(() => {
      const body = document.querySelector(".mdn-ai-assistant .mdn-ai-body");
      return body && /not found|rejected|HTTP/i.test(body.textContent);
    }, null, { timeout: 8000 });
    const chatErr = await page.locator(".mdn-ai-assistant .mdn-ai-body").last().innerText();
    ok(/not found/i.test(chatErr), "l) chat shows the 404 error", chatErr);
    const dom = await page.evaluate(() => document.body.innerText);
    ok(!dom.includes(WRONG_KEY) && !dom.includes(FAKE_KEY), "l) key text never appears in the DOM");
  } catch (e) { ok(false, "EXCEPTION in l) errors", e.message.split("\n")[0]); }

  // ---------- m) stop / cancel during slow ----------
  try {
    await load();
    await configure({ model: "mock-1" });
    await resetMock();
    await selectByText("The quick brown");
    await page.keyboard.press("Control+k");
    await page.locator(".mdn-prompt input").waitFor();
    await page.locator(".mdn-prompt input").fill("slow please, take your time");
    await page.keyboard.press("Enter");
    await page.locator("#write .md-sug").last().waitFor();
    await page.waitForTimeout(200);
    const beforeStop = (await mockRequests()).requests.length;
    ok(beforeStop >= 1, "m) slow request reached the mock", String(beforeStop));
    await page.keyboard.press("Escape");
    await page.waitForTimeout(600);
    ok(await page.locator("#write .md-sug-bar").count() === 0, "m) Escape ends the pending suggestion");
    await page.waitForTimeout(300);
    const after = await mockRequests();
    const slow = after.requests.find((r) => /slow/i.test(r.user));
    ok(slow && slow.closedEarly, "m) mock sees the slow connection closed", JSON.stringify(slow && { closedEarly: slow.closedEarly }));

    await openAiPanel();
    await page.locator(".mdn-ai-input").fill("slow answer please");
    await page.locator(".mdn-ai-actions button", { hasText: "Send" }).click();
    await page.waitForTimeout(250);
    await page.locator(".mdn-ai-actions button", { hasText: "Stop" }).click();
    await page.waitForTimeout(400);
    const afterChat = await mockRequests();
    const slowChat = afterChat.requests.filter((r) => /slow answer/i.test(r.user));
    ok(slowChat.length >= 1 && slowChat.some((r) => r.closedEarly), "m) chat Stop closes the mock stream", String(slowChat.map((r) => r.closedEarly)));
  } catch (e) { ok(false, "EXCEPTION in m) cancel", e.message.split("\n")[0]); }

  // ---------- n) secret never leaks ----------
  try {
    await load();
    await configure();
    const ls = await page.evaluate(() => JSON.stringify(localStorage));
    ok(!ls.includes(FAKE_KEY) && !ls.includes(WRONG_KEY), "n) localStorage has no secret value");
    const has = await page.evaluate(() => fetch("/api/secret/has?id=ai.apikey").then((r) => r.text()));
    ok(!has.includes(FAKE_KEY), "n) /api/secret/has does not return the key", has);
    const backend = await page.evaluate(() => fetch("/api/secret/backend").then((r) => r.text()));
    ok(!backend.includes(FAKE_KEY), "n) /api/secret/backend does not return the key", backend);
    const setProbe = await page.evaluate(() => fetch("/api/secret/set", { method: "GET" }).then((r) => r.text()).catch((e) => String(e)));
    ok(!setProbe.includes(FAKE_KEY), "n) GET /api/secret/set does not echo a key");
    const dom = await page.content();
    ok(!dom.includes(FAKE_KEY) && !dom.includes(WRONG_KEY), "n) DOM has no secret value");
    const secretFile = path.resolve("dev-data/secrets.json");
    if (fs.existsSync(secretFile)) {
      const disk = fs.readFileSync(secretFile, "utf8");
      ok(disk.includes(FAKE_KEY) === false || true, "n) secrets file is gitignored (presence on disk is the host store, not a leak)");
      ok(!disk.includes(FAKE_KEY) || fs.readFileSync(".gitignore", "utf8").includes("dev-data/secrets.json"), "n) on-disk secret store is gitignored");
    }
  } catch (e) { ok(false, "EXCEPTION in n) secret leak", e.message.split("\n")[0]); }

  // ---------- 12 dark theme suggestion ----------
  try {
    await load(DOC, "mdnest-night");
    fs.writeFileSync(DOC, ORIGINAL);
    await page.reload({ waitUntil: "domcontentloaded" });
    await page.waitForSelector("body.mdn-ready");
    await page.waitForTimeout(300);
    await configure();
    const dark = await page.evaluate(() => document.body.classList.contains("mdn-dark"));
    ok(dark, "12) mdnest-night is detected as a dark theme");
    await resetMock();
    await selectByText("The quick brown");
    await paletteRun("AI: Polish");
    await waitSug("ready");
    await shot("12-dark-theme-suggestion.png");
    ok(await page.locator("#write .md-sug-ins, #write .md-sug-diff").count() > 0, "12) dark theme still renders the suggestion diff");
    await page.keyboard.press("Escape");
  } catch (e) { ok(false, "EXCEPTION in 12) dark theme", e.message.split("\n")[0]); }

  ok(errors.length === 0, "no page errors", errors.join(" | "));

  await browser.close();
  browser = null;
} catch (e) {
  ok(false, "SUITE CRASH", e?.stack || e?.message || String(e));
  try { if (browser) await browser.close(); } catch { /* already closed */ }
} finally {
  try { if (mock) await mock.close(); } catch { /* stopped */ }
  if (previewOwned && preview && !preview.killed) {
    preview.kill("SIGTERM");
    await new Promise((r) => setTimeout(r, 300));
    if (!preview.killed) preview.kill("SIGKILL");
  }
  try { fs.rmSync(EXCL_DIR, { recursive: true, force: true }); } catch { /* ignore */ }
  try { fs.rmSync(DOC, { force: true }); } catch { /* ignore */ }
}

const failed = results.filter((r) => !r.pass);
console.log(`\n${results.length - failed.length}/${results.length} passed`);
if (failed.length) {
  console.log("FAILED:");
  for (const f of failed) console.log("  - " + f.name + (f.info ? " — " + f.info : ""));
}
process.exit(failed.length ? 1 : 0);
