// UI string table. English source strings are the keys; zh-CN translations live in zh.ts.
// Language: setting "mdnest.lang" = auto | zh-CN | en (auto follows the OS/webview language).
// ?lang=zh-CN / ?lang=en in the URL overrides for the session (tests, screenshots).
import { ZH } from "./zh";

export type Lang = "zh-CN" | "en";
export type LangSetting = "auto" | Lang;
export const LANG_KEY = "mdnest.lang";

export function langSetting(): LangSetting {
  const v = (typeof localStorage !== "undefined" && localStorage.getItem(LANG_KEY)) || "auto";
  return v === "zh-CN" || v === "en" ? v : "auto";
}

export function systemLang(langs: readonly string[] = typeof navigator !== "undefined" ? (navigator.languages?.length ? navigator.languages : [navigator.language]) : []): Lang {
  const first = String(langs[0] || "en").toLowerCase();
  return first.startsWith("zh") ? "zh-CN" : "en";
}

export function resolveLang(setting: LangSetting = langSetting(), langs?: readonly string[]): Lang {
  try {
    const q = typeof location !== "undefined" ? new URLSearchParams(location.search).get("lang") : null;
    if (q === "zh-CN" || q === "en") return q;
  } catch { /* no location */ }
  return setting === "auto" ? systemLang(langs) : setting;
}

let LANG: Lang = resolveLang();
export function lang(): Lang { return LANG; }
/** Switch language for strings rendered from now on (menus re-render; panels re-render on demand). */
export function setLang(l: Lang) {
  LANG = l;
  if (typeof document !== "undefined") document.documentElement.lang = l === "zh-CN" ? "zh-CN" : "en";
}
export function saveLangSetting(s: LangSetting) {
  localStorage.setItem(LANG_KEY, s);
  setLang(resolveLang(s));
}

const fill = (s: string, vars?: Record<string, string | number>) =>
  vars ? s.replace(/\{(\w+)\}/g, (m, k) => (k in vars ? String(vars[k]) : m)) : s;

/** Translate a UI string. Unknown strings stay English. `{name}` placeholders are filled from vars. */
export function t(en: string, vars?: Record<string, string | number>): string {
  if (LANG !== "zh-CN") return fill(en, vars);
  return fill(ZH[en] ?? en, vars);
}

/** Command palette titles "Category: Title" translate per part; "Reopen X" style patterns too. */
export function tTitle(title: string): string {
  if (LANG !== "zh-CN") return title;
  if (ZH[title]) return ZH[title];
  const i = title.indexOf(": ");
  if (i < 0) return tPattern(title);
  return `${t(title.slice(0, i))}：${tPattern(title.slice(i + 2))}`;
}
function tPattern(s: string): string {
  if (ZH[s]) return ZH[s];
  const rules: [RegExp, string][] = [
    [/^Reopen (.+)$/, "以 $1 重新打开"],
    [/^Save as (.+)$/, "保存为 $1"],
    [/^Line Endings (.+)$/, "换行符 $1"],
    [/^Export (.+)$/, "导出 $1"],
    [/^Toggle (.+)$/, "切换$1"],
  ];
  for (const [re, out] of rules) {
    const m = s.match(re);
    if (m) return out.replace("$1", t(m[1]));
  }
  return s;
}

/** zh: "1,286 字"; en: "1,286 words" */
export function wordsLabel(n: number): string {
  return LANG === "zh-CN" ? `${n.toLocaleString("en-US")} 字` : `${n} words`;
}
export function minutesLabel(n: number): string {
  return LANG === "zh-CN" ? `约 ${n} 分钟` : `~${n} min`;
}
