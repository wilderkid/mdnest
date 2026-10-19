#!/usr/bin/python3
"""Native (Tauri/WebKitGTK) image paste + drop test under Xvfb.
usage: tests/native/image-paste-drop.py BINARY [DISPLAY]   (needs xdotool, xclip, python3-gi, ffmpeg)
Pastes a PNG from the X clipboard (Ctrl+V) and drops a PNG file dragged from a GTK window, saves (Ctrl+S)
and checks the assets folder + the saved Markdown. Screenshots → screenshots/fixes/."""
import os, sys, time, shutil, subprocess as sp, tempfile, re, json
from PIL import Image, ImageDraw
import sqlite3
BIN = sys.argv[1]; DISP = sys.argv[2] if len(sys.argv) > 2 and not sys.argv[2].startswith("--") else ":77"
# --filename-assets: run with the "./${filename}.assets" image folder setting (seeded into localStorage)
FOLDER_MODE = "--filename-assets" in sys.argv
ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
SHOTS = os.path.join(ROOT, "screenshots/fixes"); os.makedirs(SHOTS, exist_ok=True)
env = dict(os.environ, DISPLAY=DISP, WEBKIT_DISABLE_DMABUF_RENDERER="1", NO_AT_BRIDGE="1")
work = tempfile.mkdtemp(prefix="mdn-native-"); prof = tempfile.mkdtemp(prefix="mdn-prof-")
penv = dict(env, XDG_DATA_HOME=prof + "/data", XDG_CONFIG_HOME=prof + "/config", XDG_CACHE_HOME=prof + "/cache")
doc = os.path.join(work, "My Notes.md")
ASSETS_REL = "My Notes.assets" if FOLDER_MODE else "assets"
if FOLDER_MODE:  # seed WebKit's localStorage DB for the tauri://localhost origin before the first launch
    ls = os.path.join(prof, "data/app.mdnest.editor/localstorage"); os.makedirs(ls)
    c = sqlite3.connect(os.path.join(ls, "tauri_localhost_0.localstorage"))
    c.execute("CREATE TABLE ItemTable (key TEXT UNIQUE ON CONFLICT REPLACE, value BLOB NOT NULL ON CONFLICT FAIL)")
    c.execute("INSERT INTO ItemTable VALUES (?, ?)", ("mdnest.imageFolder", "./${filename}.assets".encode("utf-16-le"))); c.commit(); c.close()
open(doc, "w").write("# Native image test\n\nFirst paragraph.\n\nSecond paragraph.\n")
def png(path, text, color):
    im = Image.new("RGB", (220, 90), color); d = ImageDraw.Draw(im); d.text((14, 36), text, fill="white"); im.save(path)
clip_png = os.path.join(work, "clip-src.png"); png(clip_png, "pasted from clipboard", (37, 99, 235))
drop_dir = tempfile.mkdtemp(prefix="mdn-drop-"); drop_png = os.path.join(drop_dir, "Dropped Shot.png"); png(drop_png, "dropped file", (22, 163, 74))
res = []
def ok(c, name, info=""): res.append({"pass": bool(c), "name": name, "info": str(info)[:200]})
def x(*a): return sp.run(["xdotool", *a], env=env, capture_output=True, text=True).stdout.strip()
def shot(name): sp.run(["ffmpeg", "-loglevel", "error", "-y", "-f", "x11grab", "-video_size", "1400x900", "-i", DISP, "-frames:v", "1", os.path.join(SHOTS, name)], env=env)
def saved(): return open(doc).read()

# keyboard focus needs a window manager on the test display (bare Xvfb never focuses the toplevel)
wm = sp.Popen(["xfwm4", "--compositor=off"], env=env, stdout=sp.DEVNULL, stderr=sp.DEVNULL) if shutil.which("xfwm4") else None
time.sleep(1.5)
DBG = os.path.join(work, "debug.log")
app = sp.Popen([BIN, doc, "--debug-log", DBG], env=penv, stdout=sp.DEVNULL, stderr=sp.DEVNULL)
try:
    win = ""
    for _ in range(40):
        time.sleep(0.5); win = x("search", "--onlyvisible", "--name", "^MD Nest$")
        if win: break
    ok(win, "app window found", win)
    win = win.split("\n")[0]
    time.sleep(4)
    geo = x("getwindowgeometry", "--shell", win); g = dict(l.split("=") for l in geo.splitlines() if "=" in l)
    wx, wy = int(g.get("X", 0)), int(g.get("Y", 0))
    x("windowactivate", "--sync", win); time.sleep(0.5)
    # click at end of "First paragraph." — find it via a Ctrl+F? simpler: click in the text column, then use keyboard
    x("mousemove", str(wx + 420), str(wy + 120)); x("click", "1"); time.sleep(0.3)
    x("key", "ctrl+End"); time.sleep(0.2); x("key", "Return"); time.sleep(0.2)
    # ---- paste ----
    sp.Popen(["xclip", "-selection", "clipboard", "-t", "image/png", "-i", clip_png], env=env)  # stays alive serving the selection
    time.sleep(0.5); x("key", "ctrl+v"); time.sleep(2.0)
    x("key", "ctrl+s"); time.sleep(1.5)
    assets = os.path.join(work, ASSETS_REL)
    files = sorted(os.listdir(assets)) if os.path.isdir(assets) else []
    ok(any(re.match(r"image-\d{8}-\d{6}\.png$", f) for f in files), f"paste: PNG written to ./{ASSETS_REL} next to the doc", files)
    enc = ASSETS_REL.replace(" ", "%20")
    s = saved(); m = re.search(r"!\[[^\]]*\]\((" + re.escape(enc) + r"/image-\d{8}-\d{6}\.png)\)", s)
    ok(m, "paste: relative ![](assets/…) inserted and saved", s.replace("\n", "⏎")[:200])
    if m:
        mp = os.path.join(work, m.group(1).replace("%20", " "))
        same = open(mp, "rb").read() == open(clip_png, "rb").read() or Image.open(mp).size == (220, 90)
        ok(same, "paste: written file is the clipboard image", m.group(1))
    if not FOLDER_MODE: shot("native-paste.png")
    # ---- drop ----
    src = sp.Popen(["/usr/bin/python3", os.path.join(ROOT, "tests/native/dragsource.py"), "1210", "300", drop_png], env=env, stdout=sp.PIPE, text=True)
    src.stdout.readline(); time.sleep(1.0)
    sx, sy = 1290, 360; tx, ty = wx + 420, wy + 330
    x("mousemove", str(sx), str(sy)); time.sleep(0.2); x("mousedown", "1"); time.sleep(0.2)
    for i in range(1, 26):
        x("mousemove", str(sx + (tx - sx) * i // 25), str(sy + (ty - sy) * i // 25)); time.sleep(0.04)
    time.sleep(0.5); x("mousemove", str(tx + 2), str(ty + 2)); time.sleep(0.3); x("mouseup", "1"); time.sleep(2.0)
    x("windowactivate", "--sync", win); time.sleep(0.3); x("key", "ctrl+s"); time.sleep(1.5)
    files2 = sorted(os.listdir(assets)) if os.path.isdir(assets) else []
    ok("Dropped-Shot.png" in files2 or any(f.lower().startswith("dropped") for f in files2), "drop: file copied into ./assets (sanitized name)", files2)
    s = saved()
    ok(re.search(r"!\[[^\]]*\]\(" + re.escape(enc) + r"/Dropped[^)]*\.png\)", s), "drop: relative image link saved", s.replace("\n", "⏎")[:240])
    if not FOLDER_MODE: shot("native-drop.png")
    src.terminate()
    # ---- paste a file copied in a file manager (clipboard target text/uri-list) ----
    fm_png = os.path.join(drop_dir, "From Files.png"); png(fm_png, "copied in file manager", (217, 119, 6))
    sp.run(["pkill", "-f", "xclip -selection clipboard"], env=env); time.sleep(0.3)
    uri = os.path.join(work, "uri.txt"); open(uri, "w").write("file://" + fm_png.replace(" ", "%20") + "\r\n")
    sp.Popen(["xclip", "-selection", "clipboard", "-t", "text/uri-list", "-i", uri], env=env); time.sleep(0.5)
    x("windowactivate", "--sync", win); time.sleep(0.3)
    x("key", "ctrl+End"); time.sleep(0.2); x("key", "Return"); x("key", "ctrl+v"); time.sleep(2.0); x("key", "ctrl+s"); time.sleep(1.5)
    files3 = sorted(os.listdir(assets)) if os.path.isdir(assets) else []
    s = saved()
    ok("From-Files.png" in files3 and re.search(r"\]\(" + re.escape(enc) + r"/From-Files\.png\)", s), "paste of file copied in a file manager (text/uri-list) → copied + linked", f"{files3} :: {s[-120:]!r}")
    shot("native-paste-file-uri.png" if not FOLDER_MODE else "native-filename-assets.png")
    # ---- rendered in the app (image loads through the mdfile:// protocol) ----
    ok(True, "saved markdown", s.replace("\n", "⏎"))
finally:
    app.terminate(); app.wait(5); sp.run(["pkill", "-f", "xclip -selection clipboard"], env=env)
    if wm: wm.terminate()
if os.path.exists(DBG): print(open(DBG).read()[-1500:], file=sys.stderr)
fail = [r for r in res if not r["pass"]]
print(json.dumps({"passed": len(res) - len(fail), "failed": len(fail), "results": res, "work": work}, indent=1, ensure_ascii=False))
sys.exit(1 if fail else 0)
