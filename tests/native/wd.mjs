// Minimal WebDriver client for the real Tauri app (tauri-driver + WebKitWebDriver), no npm deps.
// startNative({ app, display, env }) → { exec(fn, ...args), execAsync, screenshot(file), close() }
import { spawn, execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// WebDriver special keys
const KEY = { Enter: "\uE007", Backspace: "\uE003", Tab: "\uE004", Escape: "\uE00C", Delete: "\uE017", Home: "\uE011", End: "\uE010",
  ArrowLeft: "\uE012", ArrowUp: "\uE013", ArrowRight: "\uE014", ArrowDown: "\uE015", Control: "\uE009", Shift: "\uE008", Alt: "\uE00A" };

export async function startNative({ app, display = ":78", port = 4444, env = {}, width = 1200, height = 800, args = [], profile: keep = null } = {}) {
  const procs = [];
  // `profile`: use (and keep) this folder as the XDG profile instead of a throwaway one
  const profile = keep ?? fs.mkdtempSync(path.join(os.tmpdir(), "mdnest-native-"));
  if (keep) fs.mkdirSync(keep, { recursive: true });
  const baseEnv = {
    ...process.env, DISPLAY: display,
    XDG_CONFIG_HOME: path.join(profile, "config"), XDG_DATA_HOME: path.join(profile, "data"),
    XDG_CACHE_HOME: path.join(profile, "cache"), HOME_PROFILE: profile,
    DBUS_SESSION_BUS_ADDRESS: "disabled:", ...env,
  };
  let ownX = false;
  try { execFileSync("xdpyinfo", ["-display", display], { stdio: "ignore" }); }
  catch {
    procs.push(spawn("Xvfb", [display, "-screen", "0", `${width + 200}x${height + 100}x24`, "-nolisten", "tcp"], { stdio: "ignore" }));
    ownX = true;
    await sleep(800);
  }
  const td = spawn(path.join(os.homedir(), ".cargo/bin/tauri-driver"), ["--port", String(port), "--native-port", String(port + 1)], { env: baseEnv, stdio: ["ignore", "pipe", "pipe"] });
  procs.push(td);
  let tdLog = "";
  td.stdout.on("data", (d) => (tdLog += d)); td.stderr.on("data", (d) => (tdLog += d));
  const base = `http://127.0.0.1:${port}`;
  const call = async (method, p, body) => {
    const r = await fetch(base + p, { method, headers: { "content-type": "application/json" }, body: body ? JSON.stringify(body) : undefined });
    const j = await r.json().catch(() => ({}));
    if (!r.ok || j?.value?.error) throw new Error(`${method} ${p}: ${JSON.stringify(j?.value ?? j).slice(0, 400)}`);
    return j.value;
  };
  for (let i = 0; i < 50; i++) { try { await fetch(base + "/status"); break; } catch { await sleep(200); } }
  let sid;
  try {
    const s = await call("POST", "/session", { capabilities: { alwaysMatch: { "tauri:options": { application: path.resolve(app), args: ["--no-restore", ...args] } } } });
    sid = s.sessionId;
  } catch (e) { for (const p of procs) p.kill(); throw new Error(e.message + "\n" + tdLog.slice(-1500)); }
  const S = `/session/${sid}`;
  return {
    profile,
    /** run fn(...args) in the webview; fn may be async (WebDriver async script wrapper) */
    async exec(fn, ...args) {
      const script = `const done = arguments[arguments.length - 1]; Promise.resolve((${fn.toString()}).apply(null, Array.from(arguments).slice(0, -1))).then((v) => done({ ok: v === undefined ? null : v }), (e) => done({ err: String(e && e.stack || e) }));`;
      const v = await call("POST", `${S}/execute/async`, { script, args });
      if (v && v.err) throw new Error("in webview: " + v.err);
      return v?.ok;
    },
    async waitFor(fn, { timeout = 15000, interval = 200, args = [] } = {}) {
      const t0 = Date.now();
      for (;;) {
        const v = await this.exec(fn, ...args).catch(() => null);
        if (v) return v;
        if (Date.now() - t0 > timeout) throw new Error("waitFor timeout: " + fn.toString().slice(0, 160));
        await sleep(interval);
      }
    },
    /** real key events through WebDriver actions: type("abc"), press("Enter"), press("Home", ["Control"]) */
    async type(text) {
      const actions = [];
      for (const ch of text) actions.push({ type: "keyDown", value: ch === "\n" ? KEY.Enter : ch }, { type: "keyUp", value: ch === "\n" ? KEY.Enter : ch });
      await call("POST", `${S}/actions`, { actions: [{ type: "key", id: "kbd", actions }] });
      await call("DELETE", `${S}/actions`).catch(() => {});
    },
    async press(key, mods = []) {
      const k = KEY[key] ?? key;
      const m = mods.map((x) => KEY[x]);
      const actions = [...m.map((v) => ({ type: "keyDown", value: v })), { type: "keyDown", value: k }, { type: "keyUp", value: k }, ...m.reverse().map((v) => ({ type: "keyUp", value: v }))];
      await call("POST", `${S}/actions`, { actions: [{ type: "key", id: "kbd", actions }] });
      await call("DELETE", `${S}/actions`).catch(() => {});
    },
    /** real pointer click at the centre of the first element matching css (button 0 left, 2 right) */
    async click(css, { button = 0, dx = null } = {}) {
      const r = await this.exec((css) => { const e = document.querySelector(css); if (!e) return null; e.scrollIntoView({ block: "center" }); const b = e.getBoundingClientRect(); return { x: b.left, y: b.top, w: b.width, h: b.height }; }, css);
      if (!r) throw new Error("no element " + css);
      const x = Math.round(r.x + (dx ?? r.w / 2)), y = Math.round(r.y + r.h / 2);
      await call("POST", `${S}/actions`, { actions: [{ type: "pointer", id: "mouse", parameters: { pointerType: "mouse" }, actions: [
        { type: "pointerMove", duration: 0, x, y, origin: "viewport" }, { type: "pointerDown", button }, { type: "pointerUp", button }] }] });
      await call("DELETE", `${S}/actions`).catch(() => {});
    },
    /** real pointer clicks at viewport x,y (clicks: 2 = double-click; 0 = just move/hover) */
    async mouseAt(x, y, { button = 0, clicks = 1 } = {}) {
      const acts = [{ type: "pointerMove", duration: 0, x: Math.round(x), y: Math.round(y), origin: "viewport" }];
      for (let i = 0; i < clicks; i++) acts.push({ type: "pointerDown", button }, { type: "pointerUp", button });
      await call("POST", `${S}/actions`, { actions: [{ type: "pointer", id: "mouse", parameters: { pointerType: "mouse" }, actions: acts }] });
      await call("DELETE", `${S}/actions`).catch(() => {});
    },
    async screenshot(file) {
      const b64 = await call("GET", `${S}/screenshot`);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, Buffer.from(b64, "base64"));
    },
    async close() {
      try { await call("DELETE", S); } catch { /* gone */ }
      for (const p of procs.reverse()) { try { p.kill(); } catch { /* ignore */ } }
      if (ownX) await sleep(200);
      if (!keep) fs.rmSync(profile, { recursive: true, force: true });
    },
  };
}
