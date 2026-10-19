// Native smoke: GTK menu bar exists, and a menu-level shortcut reaches the webview.
// The binary must be a Tauri release build (npx tauri build --no-bundle) so the frontend is embedded.
// Usage: node tests/native/parity-smoke.mjs [binary]
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFile, spawn } from "node:child_process";
import { startNative } from "./wd.mjs";

const APP = process.argv[2] ?? process.env.APP ?? "src-tauri/target/release/mdnest";
const DISPLAY = process.env.DISPLAY_TEST ?? ":79";
const OUT = path.resolve("screenshots/parity");
fs.mkdirSync(OUT, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const env = { ...process.env, DISPLAY, NO_AT_BRIDGE: "1" };
const sh = (cmd, args) => new Promise((res) => execFile(cmd, args, { env }, (err, stdout, stderr) => res({ err, stdout: String(stdout || ""), stderr: String(stderr || "") })));

let n;
let wm;
let fail = 0;
const ok = (c, m, info = "") => { console.log((c ? "PASS " : "FAIL ") + m + (info ? " — " + String(info).slice(0, 200) : "")); if (!c) fail++; };

const tmp = path.join(os.tmpdir(), "mdnest-parity-native-" + Date.now().toString(36));
fs.mkdirSync(tmp, { recursive: true });
const fakeDir = path.join(tmp, "bin");
fs.mkdirSync(fakeDir, { recursive: true });
const argLog = path.join(tmp, "pandoc-args.txt");
fs.writeFileSync(path.join(fakeDir, "pandoc"), `#!/bin/sh
echo "$@" >> ${JSON.stringify(argLog)}
if [ "$1" = "--version" ]; then
  echo "pandoc 0.0-fake"
  exit 0
fi
cat > /dev/null
out=""
prev=""
for a in "$@"; do
  if [ "$prev" = "-o" ]; then out="$a"; fi
  prev="$a"
done
if [ -n "$out" ]; then printf 'fake %s\\n' "$*" > "$out"; fi
exit 0
`, { mode: 0o755 });
fs.chmodSync(path.join(fakeDir, "pandoc"), 0o755);

try {
  n = await startNative({
    app: APP,
    display: DISPLAY,
    args: ["--no-restore"],
    env: { PATH: fakeDir + path.delimiter + (process.env.PATH || "") },
  });
  // Bare Xvfb never focuses the toplevel, so F10 / Ctrl+2 need a window manager on this display only.
  wm = spawn("xfwm4", ["--compositor=off"], { env, stdio: "ignore" });
  await n.waitFor(() => window.mdnest?.editor?.view && window.mdnest.host.kind === "tauri" && document.body.classList.contains("mdn-ready"), { timeout: 20000 });
  await sleep(1200);
  const wid = (await sh("xdotool", ["search", "--onlyvisible", "--name", "MD Nest"])).stdout.split("\n").filter(Boolean)[0];
  ok(!!wid, "GTK window is visible", wid || "no window");
  let origin = { x: 8, y: 32 };
  if (wid) {
    await sh("xdotool", ["windowactivate", "--sync", wid]);
    await sleep(300);
    const geo = (await sh("xdotool", ["getwindowgeometry", "--shell", wid])).stdout;
    const g = Object.fromEntries(geo.split("\n").filter((l) => l.includes("=")).map((l) => l.split("=")));
    origin = { x: +g.X || 0, y: +g.Y || 0 };
  }
  const shot = path.join(OUT, "native-menu-file.png");
  await new Promise((res, rej) => execFile("python3", ["-c", `
import os, sys
os.environ["DISPLAY"] = sys.argv[1]
import gi
gi.require_version("Gdk", "3.0")
from gi.repository import Gdk
Gdk.init([])
win = Gdk.get_default_root_window()
w, h = win.get_width(), win.get_height()
pb = Gdk.pixbuf_get_from_window(win, 0, 0, w, h)
if pb is None:
    raise SystemExit("pixbuf is empty")
pb.savev(sys.argv[2], "png", [], [])
print(w, h)
`, DISPLAY, shot], (err, stdout, stderr) => err ? rej(new Error(String(stderr || err))) : res(String(stdout))));
  ok(fs.existsSync(shot) && fs.statSync(shot).size > 8000, "native menu screenshot captured", shot + " " + (fs.existsSync(shot) ? fs.statSync(shot).size : 0));
  if (wid) await sh("xdotool", ["key", "--window", wid, "Escape"]);
  await sleep(200);

  await n.exec(() => {
    window.mdnest.editor.setMarkdown("# Hello\n\nA paragraph.\n");
    window.mdnest.editor.view.focus();
  });
  await sleep(300);
  if (wid) {
    await sh("xdotool", ["windowactivate", "--sync", wid]);
    await sleep(200);
    // Click the editor so the shell has focus, then send the Paragraph > Heading 2 accelerator.
    await sh("xdotool", ["mousemove", String(origin.x + 480), String(origin.y + 180)]);
    await sh("xdotool", ["click", "1"]);
    await sleep(200);
    await sh("xdotool", ["key", "--clearmodifiers", "ctrl+2"]);
  }
  await sleep(500);
  const level = await n.exec(() => {
    const v = window.mdnest.editor.view;
    let name = "";
    v.state.doc.descendants((node) => { if (!name && node.isTextblock) name = node.type.name + ":" + (node.attrs.level ?? ""); });
    return { name, md: window.mdnest.editor.getMarkdown().slice(0, 60) };
  });
  ok(String(level.md).includes("## "), "Ctrl+2 reaches the webview as heading 2", JSON.stringify(level));

  // File commands through the real host, on a temp folder. No GTK menu clicking.
  try {
    const ops = await n.exec(async (dir) => {
      const h = window.mdnest.host;
      const file = dir + "/note.md";
      await h.createFile(file);
      await h.writeFile(file, "# Native\n");
      const renamed = dir + "/note-renamed.md";
      await h.renamePath(file, renamed);
      const dup = await h.duplicatePath(renamed);
      await h.trashPath(dup);
      const kind = await h.pathKind(renamed);
      const listed = await h.listFiles(dir, 20);
      return { renamed, dup, kind, names: listed.map((f) => f.name), dupGone: (await h.pathKind(dup)) === "missing" };
    }, tmp);
    ok(ops.kind === "file" && ops.names.includes("note-renamed.md"), "native create + rename", JSON.stringify(ops.names));
    ok(String(ops.dup).includes("copy") && ops.dupGone, "native duplicate + trash", ops.dup);

    // B1: open the temp folder, then a file created outside the app appears in the watched tree.
    await n.exec(async (dir) => { await window.mdnest.openFolder(dir); }, tmp);
    await sleep(400);
    const external = path.join(tmp, "outside-watch.txt");
    fs.writeFileSync(external, "created outside\n");
    await sleep(900);
    const seen = await n.exec(async () => {
      const names = [...document.querySelectorAll("#file-library-tree .file-node-title, .file-list-item-file-name")].map((n) => (n.textContent || "").trim());
      return names.join(" | ");
    });
    ok(seen.includes("outside-watch"), "B1 external file appears in the tree", seen.slice(0, 180));

    // B4: the spell-check command reaches WebKitGTK and does not crash.
    const spell = await n.exec(async () => {
      await window.mdnest.runCommand("edit.spellcheck");
      await new Promise((r) => setTimeout(r, 200));
      const attr = document.getElementById("write")?.getAttribute("spellcheck");
      await window.mdnest.runCommand("edit.spellcheck");
      return { attr, ready: document.body.classList.contains("mdn-ready") };
    });
    ok(spell.attr === "true" && spell.ready, "B4 spell-check toggle does not crash", JSON.stringify(spell));

    const pandoc = await n.exec(async (dir) => {
      const h = window.mdnest.host;
      const info = await h.pandocInfo();
      const out = dir + "/note.odt";
      let err = "";
      try { await h.pandocExport("# Native\n", "odt", out, dir); }
      catch (e) { err = String(e && e.message || e); }
      const kind = await h.pathKind(out);
      return { found: info.found, version: info.version, path: info.path, err, kind };
    }, tmp);
    ok(pandoc.found && /fake/.test(pandoc.version || ""), "C2 fake pandoc detected", JSON.stringify(pandoc));
    ok(pandoc.kind === "file" && !pandoc.err, "C2 fake pandoc wrote the output", JSON.stringify(pandoc));
    const recorded = fs.existsSync(argLog) ? fs.readFileSync(argLog, "utf8") : "";
    ok(recorded.includes("-t") && recorded.includes("odt"), "C2 fake pandoc recorded args", recorded.slice(0, 180));
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
} catch (e) {
  ok(false, "native smoke threw", e.message || String(e));
} finally {
  if (n) await n.close().catch(() => {});
  if (wm) { try { wm.kill(); } catch { /* gone */ } }
}
process.exit(fail ? 1 : 0);
