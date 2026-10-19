// Minimal WebDriver client for the real Tauri app (tauri-driver + WebKitWebDriver), no npm deps.
// startNative({ app, display, env }) → { exec(fn, ...args), execAsync, screenshot(file), close() }
import { spawn, execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export async function startNative({ app, display = ":78", port = 4444, env = {}, width = 1200, height = 800, args = [] } = {}) {
  const procs = [];
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), "mdnest-native-"));
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
    async screenshot(file) {
      const b64 = await call("GET", `${S}/screenshot`);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, Buffer.from(b64, "base64"));
    },
    async close() {
      try { await call("DELETE", S); } catch { /* gone */ }
      for (const p of procs.reverse()) { try { p.kill(); } catch { /* ignore */ } }
      if (ownX) await sleep(200);
      fs.rmSync(profile, { recursive: true, force: true });
    },
  };
}
