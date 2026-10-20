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

/** navigator.languages, preceded by the desktop locale the native host injects (Linux: LANG/LANGUAGE) */
function defaultLangs(): string[] {
  const out: string[] = [];
  const sys = typeof window !== "undefined" ? (window as { __MDNEST_SYS_LANG__?: unknown }).__MDNEST_SYS_LANG__ : undefined;
  if (typeof sys === "string" && sys) out.push(sys);
  if (typeof navigator !== "undefined") out.push(...(navigator.languages?.length ? navigator.languages : [navigator.language]));
  return out;
}
/** The default UI language is Chinese; only a clearly non-Chinese OS/webview locale switches to English. */
export function systemLang(langs: readonly string[] = defaultLangs()): Lang {
  const first = String(langs.find((l) => l && String(l).trim()) ?? "").toLowerCase();
  if (!first) return "zh-CN";
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
// <html lang> also steers CJK font fallback
if (typeof document !== "undefined") document.documentElement.lang = LANG === "zh-CN" ? "zh-CN" : "en";
export function lang(): Lang { return LANG; }
/** Switch language for strings rendered from now on (menus re-render; panels re-render on demand). */
export function setLang(l: Lang) {
  LANG = l;
  if (typeof document !== "undefined") document.documentElement.lang = l === "zh-CN" ? "zh-CN" : "en";
}
export function saveLangSetting(s: LangSetting) {
  localStorage.setItem(LANG_KEY, s);
  // an explicit choice wins over the session's ?lang= override
  setLang(s === "auto" ? resolveLang(s) : s);
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

/** Error texts from providers/the host are built in English; show them translated (patterns keep the details). */
const ERROR_PATTERNS: [RegExp, string][] = [
  [/^API key rejected$/, "API 密钥被拒绝"],
  [/^model or URL not found$/, "找不到模型或地址"],
  [/^cannot reach (.+)$/, "无法连接 $1"],
  [/^HTTP (\d+): (.*)$/, "HTTP $1：$2"],
  [/^request failed$/, "请求失败"],
  [/^cancelled$/, "已取消"],
  [/^AI is disabled$/, "AI 已关闭"],
  [/^local-only mode refuses (.+)$/, "仅本地模式拒绝连接 $1"],
  [/^no embedding endpoint configured.*$/, "未配置向量（Embeddings）服务（设置 → AI → Embeddings）"],
  [/^embedding endpoint returned no JSON$/, "向量服务没有返回 JSON"],
  [/^Daily AI limit reached \((\d+) requests\)\..*$/, "已达到每日 AI 上限（$1 次请求），可在 设置 → AI 中修改。"],
  [/^Daily AI limit reached \((\d+) tokens\)\..*$/, "已达到每日 AI 上限（$1 个 token），可在 设置 → AI 中修改。"],
  [/^(?:TypeError: )?Failed to fetch$/, "网络请求失败"],
  [/^missing$/, "文件不存在"],
  [/^(.+): the file is open in another program$/, "$1：文件正被其他程序占用"],
  [/^(.+): access denied$/, "$1：拒绝访问"],
  [/^(.+): invalid path$/, "$1：路径无效"],
  [/^(.+): could not move to the Recycle Bin \((.+)\)$/, "$1：无法移到回收站（$2）"],
];
export function tError(msg: string): string {
  if (LANG !== "zh-CN") return msg;
  const m = msg.trim();
  if (ZH[m]) return ZH[m];
  for (const [re, zh] of ERROR_PATTERNS) if (re.test(m)) return m.replace(re, zh);
  return m;
}
