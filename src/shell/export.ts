// Export: standalone HTML (current theme CSS inlined, math/diagrams as static SVG, code statically
// highlighted with CodeMirror runMode) and PDF (Linux/Tauri: native WebKitGTK print-to-file;
// elsewhere: system print dialog on the exported HTML).
import CodeMirror from "codemirror";
import "codemirror/addon/runmode/runmode";
import { DOMSerializer, Node as PMNode } from "prosemirror-model";
import { schema, setImageBase, imageBase } from "../editor/schema";
import { renderTex, renderMermaid, loadMathJax } from "../editor/render";
import { loadMode } from "../editor/codeview";
import baseCss from "../styles/base.css?raw";
import type { Host } from "../host/types";

const EXPORT_CSS = `
html, body { height: auto !important; overflow: visible !important; }
body.typora-export { margin: 0; padding: 0; }
.typora-export-content { padding: 0; }
#write { min-height: 0; padding-bottom: 40px; }
#write .md-fences .CodeMirror { height: auto; } #write .md-fences .CodeMirror-code { padding: 0; }
#write .CodeMirror-line { margin: 0; padding: 0 4px; white-space: pre-wrap; word-break: break-word; font-family: var(--monospace); background: transparent; border: 0; box-shadow: none; }
#write .md-fences { white-space: normal; }
#write .md-diagram-panel { white-space: normal; }
#write .md-task-list-item > input { pointer-events: none; }
@media print { #write { max-width: none; padding: 0 !important; } pre, table, .md-diagram-panel, .md-math-block, img { break-inside: avoid; } h1,h2,h3,h4 { break-after: avoid; } }
@page { margin: 15mm 14mm; }
`;

async function fetchText(url: string) { const r = await fetch(url); if (!r.ok) throw new Error(url + " " + r.status); return r.text(); }
async function toDataUri(url: string): Promise<string | null> {
  try { const r = await fetch(url); if (!r.ok) return null; const b = await r.blob(); if (b.size > 4 * 1024 * 1024) return null;
    return await new Promise((res) => { const fr = new FileReader(); fr.onload = () => res(fr.result as string); fr.readAsDataURL(b); }); } catch { return null; }
}
/** inline @import and url() assets of a stylesheet so the export is self-contained */
export async function inlineCss(url: string, depth = 0): Promise<string> {
  let css: string; try { css = await fetchText(url); } catch { return ""; }
  const abs = (u: string) => new URL(u, new URL(url, location.href)).href;
  const imports = [...css.matchAll(/@import\s+(?:url\(\s*)?["']?([^"')\s]+)["']?\s*\)?[^;]*;/g)];
  for (const m of imports) css = css.replace(m[0], depth < 6 && !/^https?:/.test(m[1]) ? await inlineCss(abs(m[1]), depth + 1) : m[0]);
  const urls = [...new Set([...css.matchAll(/url\(\s*["']?([^"')]+)["']?\s*\)/g)].map((m) => m[1]))].filter((u) => !/^(data:|https?:|#|about:)/.test(u));
  for (const u of urls) { const d = await toDataUri(abs(u)); if (d) css = css.split(u).join(d); }
  return css;
}

const slug = (s: string) => s.toLowerCase().trim().replace(/[^\p{L}\p{N}\s-]/gu, "").replace(/\s+/g, "-") || "section";
const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]!));

async function highlight(code: string, lang: string) {
  const spec = await loadMode(lang);
  const lines: string[] = []; let line = "";
  (CodeMirror as any).runMode(code, spec, (text: string, style: string | null) => {
    if (text === "\n") { lines.push(line); line = ""; return; }
    line += style ? `<span class="${style.split(/\s+/).map((s) => "cm-" + s).join(" ")}">${esc(text)}</span>` : esc(text);
  });
  lines.push(line);
  return lines.map((l) => `<pre class="CodeMirror-line" role="presentation"><span role="presentation">${l || "<span cm-text=\"\">\u200b</span>"}</span></pre>`).join("");
}

/** render the document body (#write inner HTML) for export */
export async function renderExportBody(doc: PMNode, opts: { keepRelativeImages: boolean }) {
  const prevBase = imageBase; if (opts.keepRelativeImages) setImageBase("");
  const frag = DOMSerializer.fromSchema(schema).serializeFragment(doc.content);
  setImageBase(prevBase);
  const root = document.createElement("div"); root.appendChild(frag);
  // headings ids + toc
  const used = new Map<string, number>(); const heads: { level: number; text: string; id: string }[] = [];
  root.querySelectorAll<HTMLElement>("h1,h2,h3,h4,h5,h6").forEach((h) => {
    let id = slug(h.textContent || ""); const n = used.get(id) ?? 0; used.set(id, n + 1); if (n) id += "-" + n;
    h.id = id; heads.push({ level: +h.tagName[1], text: h.textContent || "", id });
  });
  root.querySelectorAll<HTMLElement>(".md-toc").forEach((t) => {
    t.innerHTML = `<p class="md-toc-content" role="list">${heads.map((h) => `<span class="md-toc-item md-toc-h${h.level}"><a class="md-toc-inner" href="#${h.id}">${esc(h.text)}</a></span>`).join("")}</p>`;
  });
  // code fences / diagrams
  for (const pre of [...root.querySelectorAll<HTMLElement>("pre.md-fences")]) {
    const lang = pre.getAttribute("lang") || ""; const code = pre.textContent || "";
    pre.classList.add("md-end-block", "ty-contain-cm", "modeLoaded");
    if (/^mermaid\b/i.test(lang)) {
      const div = document.createElement("div"); div.className = "md-diagram-panel md-fences-adv-panel";
      div.innerHTML = `<div class="md-diagram-panel-preview">${await renderMermaid(code)}</div>`;
      pre.replaceWith(div); continue;
    }
    pre.innerHTML = `<div class="CodeMirror cm-s-inner cm-s-null-scroll CodeMirror-wrap" lang="${esc(lang)}"><div class="CodeMirror-code" role="presentation">${await highlight(code, lang)}</div></div>`;
  }
  for (const m of [...root.querySelectorAll<HTMLElement>("div.md-math-block")]) {
    const tex = m.textContent || ""; m.innerHTML = `<div class="mathjax-block md-math-preview">${await renderTex(tex, true)}</div>`;
  }
  for (const m of [...root.querySelectorAll<HTMLElement>("span.md-inline-math")]) m.innerHTML = await renderTex(m.textContent || "", false);
  root.querySelectorAll("input[type=checkbox]").forEach((i) => i.setAttribute("disabled", ""));
  root.querySelectorAll(".md-meta-block").forEach((e) => e.remove()); // front matter is metadata, not content
  return root.innerHTML;
}

export async function buildExportHtml(doc: PMNode, host: Host, o: { theme: string; themeFiles: string[]; title: string; baseHref?: string; keepRelativeImages: boolean }) {
  const body = await renderExportBody(doc, { keepRelativeImages: o.keepRelativeImages });
  const sheets = [o.theme + ".css", "base.user.css", o.theme + ".user.css"].filter((f) => o.themeFiles.includes(f));
  let themeCss = "";
  for (const f of sheets) themeCss += `/* ${f} */\n` + (await inlineCss(host.themeUrl(f))) + "\n";
  let mjCss = "";
  try { const MJ = await loadMathJax(); const st = MJ.svgStylesheet?.(); if (st) mjCss = st.textContent || st.innerHTML || ""; } catch {}
  const bodyClass = ["typora-export", "os-linux", ...["mdn-dark", "mdn-cm-fallback"].filter((c) => document.body.classList.contains(c))].join(" ");
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="generator" content="MD Nest"><title>${esc(o.title)}</title>${o.baseHref ? `<base href="${esc(o.baseHref)}">` : ""}
<style id="mdnest-base">${baseCss}</style>
<style id="mdnest-theme">${themeCss}</style>
<style id="mdnest-export">${EXPORT_CSS}${mjCss}</style>
</head><body class="${bodyClass}"><div class="typora-export-content"><div id="write" class="">${body}</div></div></body></html>`;
}

/** browser / non-Linux fallback: print the export through the system dialog */
export function printHtml(html: string) {
  const iframe = document.createElement("iframe");
  iframe.style.cssText = "position:fixed;right:0;bottom:0;width:0;height:0;border:0";
  document.body.appendChild(iframe);
  iframe.srcdoc = html;
  iframe.onload = () => { iframe.contentWindow!.focus(); iframe.contentWindow!.print(); setTimeout(() => iframe.remove(), 60000); };
}
