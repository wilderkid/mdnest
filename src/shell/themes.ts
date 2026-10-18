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
    resetMermaidTheme();
    this.onChange(name);
  }
}
