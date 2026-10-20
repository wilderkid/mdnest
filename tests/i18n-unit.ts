// i18n: string table, language resolution, menu localization coverage.
// Usage: npx tsx tests/i18n-unit.ts
import { t, tTitle, setLang, resolveLang, systemLang, wordsLabel, lang } from "../src/i18n";
import { ZH } from "../src/i18n/zh";
import { menuTemplate, localize, type MenuNode } from "../src/shell/menu";

let failed = 0;
const ok = (c: boolean, name: string, info = "") => {
  console.log((c ? "PASS " : "FAIL ") + name + (info ? " — " + info : ""));
  if (!c) failed++;
};

ok(systemLang(["zh-CN", "en"]) === "zh-CN", "zh system language → zh-CN");
ok(systemLang(["zh-TW"]) === "zh-CN", "any zh variant → zh-CN");
ok(systemLang(["en-US"]) === "en", "en-US → en");
ok(systemLang([]) === "zh-CN", "no locale information → zh-CN default");
ok(resolveLang("en", ["zh-CN"]) === "en", "explicit setting beats system");
ok(resolveLang("auto", ["zh-CN"]) === "zh-CN", "auto follows system");

setLang("en");
ok(t("Open Folder…") === "Open Folder…", "en passthrough");
ok(wordsLabel(0) === "0 words", "en word count format kept");
ok(t("{n} results", { n: 3 }) === "3 results", "en placeholder fill");
setLang("zh-CN");
ok(lang() === "zh-CN", "setLang");
ok(t("Open Folder…") === "打开文件夹…", "zh menu label");
ok(t("Unknown string xyz") === "Unknown string xyz", "missing key falls back to English");
ok(t("{n} results", { n: 3 }) === "3 条结果", "zh placeholder fill");
ok(wordsLabel(1286) === "1,286 字", "zh word count", wordsLabel(1286));
ok(tTitle("File: Close") === "文件：关闭", "palette title split", tTitle("File: Close"));
ok(tTitle("File: Reopen with Encoding") === "文件：以其他编码重新打开", "palette title exact");
ok(tTitle("View: Toggle Sidebar") === "视图：切换侧边栏", "palette pattern/exact");

// Every menu label (both platforms) must be translated or be a proper noun / format name.
const KEEP = /^(UTF-8|windows-1252|UTF-16LE|UTF-16BE|OPML|Word（.*|OpenOffice（.*|UTF-16 LE|UTF-16 BE|GBK|GB18030|Big5|Shift_JIS|EUC-KR|Windows-1252|ISO-8859-1|LF|CRLF|HTML|PDF|Image|LaTeX|EPUB|RTF|reStructuredText|MediaWiki|Textile|Org mode|YAML Front Matter|Unix \(LF\)|Windows \(CRLF\)|Markdown|MD Nest|Services|Hide.*|Show All|About MD Nest)$/;
const missing: string[] = [];
const walk = (ns: MenuNode[]) => { for (const n of ns) {
  if (n.label && /[A-Za-z]/.test(n.label) && !/[\u4e00-\u9fff]/.test(n.label) && !KEEP.test(n.label)) missing.push(n.label);
  if (n.submenu) walk(n.submenu);
} };
for (const mac of [false, true]) walk(menuTemplate(mac).map(localize));
const uniq = [...new Set(missing)];
ok(uniq.length === 0, "all menu labels translated", uniq.join(" | "));
ok(Object.values(ZH).every((v) => v.trim().length > 0), "no empty translations");

setLang("en");
const en: string[] = [];
const walkEn = (ns: MenuNode[]) => { for (const n of ns) { if (n.label && /[\u4e00-\u9fff]/.test(n.label)) en.push(n.label); if (n.submenu) walkEn(n.submenu); } };
walkEn(menuTemplate(false).map(localize));
ok(en.length === 0, "English menus stay English");

console.log(failed ? `${failed} FAILED` : "ALL PASS");
process.exit(failed ? 1 : 0);
