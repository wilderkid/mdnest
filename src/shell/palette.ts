import type { Command } from "../plugins/api";
import { accelLabel, prosemirrorToAccel } from "./menu";

function keyLabel(key: string | undefined): string {
  if (!key) return "";
  return accelLabel(key.includes("+") ? key : prosemirrorToAccel(key));
}

export function openPalette(cmds: Command[]) {
  document.getElementById("mdn-palette")?.remove();
  const box = document.createElement("div"); box.id = "mdn-palette";
  box.innerHTML = `<input placeholder="Type a command…" /><div class="pal-list"></div>`;
  document.body.appendChild(box);
  const input = box.querySelector("input")!, list = box.querySelector(".pal-list")!;
  let sel = 0, shown: Command[] = [];
  const draw = () => {
    const q = input.value.toLowerCase();
    shown = cmds.filter((c) => {
      if (c.when) { try { if (!c.when()) return false; } catch { return false; } }
      return c.title.toLowerCase().includes(q) || c.id.includes(q);
    }).slice(0, 30);
    sel = Math.min(sel, Math.max(0, shown.length - 1));
    list.innerHTML = shown.map((c, i) => `<div class="pal-item${i === sel ? " sel" : ""}" data-i="${i}">${c.title}${c.key ? `<small>${keyLabel(c.key)}</small>` : ""}</div>`).join("");
  };
  const close = () => box.remove();
  const run = (i: number) => { const c = shown[i]; close(); c?.run(); };
  input.oninput = () => { sel = 0; draw(); };
  input.onkeydown = (e) => {
    if (e.key === "ArrowDown") { sel = Math.min(sel + 1, shown.length - 1); draw(); e.preventDefault(); }
    else if (e.key === "ArrowUp") { sel = Math.max(sel - 1, 0); draw(); e.preventDefault(); }
    else if (e.key === "Enter") run(sel); else if (e.key === "Escape") close();
  };
  list.addEventListener("mousedown", (e) => { const it = (e.target as HTMLElement).closest(".pal-item") as HTMLElement; if (it) { e.preventDefault(); run(+it.dataset.i!); } });
  input.onblur = () => setTimeout(close, 100);
  draw(); input.focus();
}
