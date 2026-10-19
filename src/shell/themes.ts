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
