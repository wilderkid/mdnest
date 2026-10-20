// Static i18n coverage: every UI string literal that reaches a translating sink — t()/tr(), notify(),
// menu/context labels, command titles, settings rows, plugin panel titles, buttons — has a zh-CN entry.
// Usage: npx tsx tests/i18n-keys.ts [--list]
import fs from "node:fs";
import path from "node:path";
import { ZH } from "../src/i18n/zh";
import { setLang, tTitle, t } from "../src/i18n";

setLang("zh-CN");
const files: string[] = [];
const walk = (d: string) => { for (const f of fs.readdirSync(d)) { const p = path.join(d, f); if (fs.statSync(p).isDirectory()) { if (f !== "i18n") walk(p); } else if (/\.ts$/.test(f) && !/emoji-data|\.d\.ts$/.test(f)) files.push(p); } };
walk("src");
const STR = String.raw`"((?:[^"\\\n]|\\.)*)"`;
const sinks: [string, RegExp][] = [
  ["t()", new RegExp(String.raw`(?<![\w.])(?:t|tr)\(\s*` + STR, "g")],
  ["notify", new RegExp(String.raw`notify\(\s*` + STR + String.raw`\s*\)`, "g")],
  ["label", new RegExp(String.raw`\blabel:\s*` + STR, "g")],
  ["title", new RegExp(String.raw`\btitle:\s*` + STR, "g")],
  ["hint", new RegExp(String.raw`\bhint:\s*` + STR, "g")],
  ["button", new RegExp(String.raw`\bbutton\(\s*` + STR, "g")],
  ["item", new RegExp(String.raw`\bitem\(\s*"[\w.]+",\s*` + STR, "g")],
  ["switchRow", new RegExp(String.raw`switchRow\(\s*"[^"]+",\s*` + STR, "g")],
  ["t(?:)", new RegExp(String.raw`(?<![\w.])t\([^()"]{1,60}\?\s*` + STR, "g")],
  ["t(?:)", new RegExp(String.raw`(?<![\w.])t\([^()"]{1,60}\?\s*"[^"]*"\s*:\s*` + STR, "g")],
];
// English written straight into HTML templates never reaches t() at all
const RAW = [/(?<![=-])>\s*([A-Z][a-z]+(?:[ '][A-Za-z]+)*[.…?!]?)\s*</g, /\b(?:title|placeholder|aria-label)="([A-Z][a-z][^"$]*)"/g];
// proper nouns, formats, ids — nothing to translate
const KEEP = /^(|[^A-Za-z]*|MD Nest.*|HTML|PDF|EPUB|LaTeX|RTF|OPML|Markdown|YAML Front Matter|UTF-.*|GBK|GB18030|Big5|Shift_JIS|EUC-KR|Windows-1252|ISO-8859-1|LF|CRLF|Unix \(LF\)|Windows \(CRLF\)|OpenOffice|MediaWiki|Textile|reStructuredText|Org mode|Mermaid|KaTeX|Pandoc|AI|API|URL|[a-z0-9._/-]+|[A-Z][a-z]+[A-Z]\w*|\.\/.*|Ctrl.*|Cmd.*|Alt.*|Shift.*|F\d+|Esc|Tab|Enter|Aa|H[1-6]|GitHub.*|OpenAI.*|Ollama.*|DeepSeek.*|Grok.*|Claude.*|Gemini.*|Word \(pandoc\)|Typora|JSON|Emoji.*:|\{.*\})$/;
const missing = new Map<string, string>();
for (const f of files) {
  const src = fs.readFileSync(f, "utf8");
  for (const [kind, re] of sinks) {
    for (const m of src.matchAll(re)) {
      const s = JSON.parse(`"${m[1]}"`) as string;
      if (KEEP.test(s) || !/[A-Za-z]{2}/.test(s)) continue;
      // hints are English search keywords, never shown in zh except the first word (see slashHint)
      if (kind === "hint") continue;
      const ok = kind === "title" ? /[\u4e00-\u9fff]/.test(tTitle(s)) || ZH[s] != null : ZH[s] != null || /[\u4e00-\u9fff]/.test(t(s));
      if (!ok && !missing.has(s)) missing.set(s, `${kind} ${f}`);
    }
  }
}
const raw: string[] = [];
for (const f of files) {
  const src = fs.readFileSync(f, "utf8");
  for (const re of RAW) for (const m of src.matchAll(re)) if (!KEEP.test(m[1]) && !/^(Aa)$/.test(m[1])) raw.push(`${JSON.stringify(m[1])}  ←  raw template ${f}`);
}
if (raw.length) { console.log(raw.join("\n")); console.log(`FAIL ${raw.length} English strings hard-coded in HTML templates`); }
if (process.argv.includes("--list")) for (const [s, w] of missing) console.log(JSON.stringify(s) + "  ←  " + w);
console.log(missing.size ? `FAIL ${missing.size} strings without a zh-CN translation` : "PASS every UI string literal has a zh-CN translation");
process.exit(missing.size || raw.length ? 1 : 0);
