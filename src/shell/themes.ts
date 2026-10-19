// Typora-compatible theme loading:
//   <themes>/<name>.css   + optional asset folder <themes>/<name>/ (resolved relative to the css URL)
//   <themes>/base.user.css (always, after the theme) and <themes>/<name>.user.css (after base.user.css)
// Theme name = file stem; "Drake Dark" display name from "drake-dark".
import type { Host } from "../host/types";
import { resetMermaidTheme } from "../editor/render";

const linkEl = (id: string) => {
  let l = document.getElementById(id) as HTMLLinkElement | null;
  if (!l) { l = document.createElement("link"); l.rel = "stylesheet"; l.id = id; document.head.appendChild(l); }
  return l;
};
export const displayName = (stem: string) => stem.split(/[-_ ]/).map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join(" ");

export class ThemeManager {
  files: string[] = [];
  current = "";
  constructor(private host: Host, private onChange: (name: string) => void) {}
  async refresh() {
    this.files = await this.host.listThemes();
    return this.themes();
  }
  themes() { return this.files.filter((f) => f.endsWith(".css") && !f.endsWith(".user.css")).map((f) => f.slice(0, -4)).sort(); }
  async apply(name: string) {
    if (!this.files.length) await this.refresh();
    if (!this.themes().includes(name)) name = "mdnest";
    const theme = linkEl("theme_css");
    const loaded = new Promise<void>((res) => { theme.onload = () => res(); theme.onerror = () => res(); setTimeout(res, 3000); });
    theme.href = this.host.themeUrl(name + ".css");
    const base = linkEl("base_user_css"), user = linkEl("theme_user_css");
    // keep order: theme → base.user.css → <name>.user.css
    document.head.appendChild(base); document.head.appendChild(user);
    const setHref = (l: HTMLLinkElement, f: string) => this.files.includes(f) ? (l.href = this.host.themeUrl(f)) : l.removeAttribute("href");
    setHref(base, "base.user.css"); setHref(user, name + ".user.css");
    await loaded;
    this.current = name; localStorage.setItem("mdnest.theme", name);
    document.body.dataset.theme = name;
    // dark detection: some themes only set colors on body/#write — expose a hint class
    const bg = getComputedStyle(document.body).backgroundColor.match(/\d+/g)?.map(Number) ?? [255, 255, 255];
    document.body.classList.toggle("mdn-dark", (bg[0] * 299 + bg[1] * 587 + bg[2] * 114) / 1000 < 128);
    document.body.classList.toggle("mdn-cm-fallback", !themeColorsCode());
    applyShellColors(name !== "mdnest");
    resetMermaidTheme();
    this.onChange(name);
  }
}

/** does the active theme colour CodeMirror tokens? (Vue, Purple… don't; then base.css supplies a palette) */
function themeColorsCode(): boolean {
  const host = document.getElementById("write") ?? document.body;
  const probe = document.createElement("div");
  probe.style.cssText = "position:absolute;visibility:hidden;pointer-events:none;left:-9999px";
  probe.innerHTML = `<pre class="md-fences"><div class="CodeMirror cm-s-inner"><span class="cm-plain">x</span><span class="cm-keyword">x</span><span class="cm-string">x</span><span class="cm-comment">x</span></div></pre>`;
  document.body.classList.remove("mdn-cm-fallback");
  host.appendChild(probe);
  const c = (sel: string) => getComputedStyle(probe.querySelector(sel)!).color;
  const plain = c(".cm-plain");
  const colored = [".cm-keyword", ".cm-string", ".cm-comment"].filter((k) => c(k) !== plain).length;
  probe.remove();
  return colored >= 2;
}

const BASE_PRIMARY = "#4a7bd0";
const transparent = (c: string) => !c || c === "transparent" || /rgba\([^)]*,\s*0\)$/.test(c);

/**
 * Shell colours follow the active theme: the page background and text colour come from #write
 * (falling back to body), the accent from the theme's --primary-color when it sets its own.
 * shell.css mixes every other shell token from these three.
 */
export function applyShellColors(followAccent = true) {
  const root = document.documentElement;
  const write = document.getElementById("write");
  const pick = (els: (Element | null)[], prop: "backgroundColor" | "color") => {
    for (const el of els) {
      if (!el) continue;
      const v = getComputedStyle(el)[prop];
      if (!transparent(v)) return v;
    }
    return "";
  };
  // read the theme's own colours: drop the shell classes for the (synchronous, unpainted) probe,
  // since the shell paints the editor surface with the previous --mdn-tbg
  const cls = ["shell-b", "shell-plain"].filter((c) => document.body.classList.contains(c));
  document.body.classList.remove(...cls);
  const bg = pick([write, write?.parentElement ?? null, document.body, root], "backgroundColor") || "#ffffff";
  const fg = pick([write, document.body], "color") || "#1f2330";
  document.body.classList.add(...cls);
  root.style.setProperty("--mdn-tbg", bg);
  root.style.setProperty("--mdn-tfg", fg);
  const primary = getComputedStyle(root).getPropertyValue("--primary-color").trim();
  if (followAccent && primary && primary.toLowerCase() !== BASE_PRIMARY) root.style.setProperty("--mdn-taccent", primary);
  else root.style.removeProperty("--mdn-taccent");
}

export type ShellStyle = "b" | "plain";
export const SHELL_KEY = "mdnest.shellStyle";
export function shellStyle(): ShellStyle {
  let q: string | null = null;
  try { q = new URLSearchParams(location.search).get("shell"); } catch { /* none */ }
  const v = q || localStorage.getItem(SHELL_KEY) || "b";
  return v === "plain" ? "plain" : "b";
}
export function applyShellStyle(s: ShellStyle = shellStyle()) {
  document.body.classList.remove("shell-b", "shell-plain");
  document.body.classList.add("shell-" + s);
}
