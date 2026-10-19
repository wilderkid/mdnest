// Lazy renderers for math (MathJax 4, loaded as a static script from /vendor) and Mermaid 11.
let mjReady: Promise<any> | null = null;
export function loadMathJax(): Promise<any> {
  if (mjReady) return mjReady;
  mjReady = new Promise((resolve, reject) => {
    (window as any).MathJax = {
      tex: { inlineMath: [["$", "$"]], displayMath: [["$$", "$$"]], tags: "ams", packages: { "[+]": ["ams"] } },
      svg: { fontCache: "local" },
      startup: { typeset: false, ready: () => { (window as any).MathJax.startup.defaultReady(); resolve((window as any).MathJax); } },
      loader: { load: ["input/tex", "output/svg"], paths: { mathjax: new URL("./vendor/mathjax", location.href).href, "mathjax-newcm": new URL("./vendor/mathjax-newcm-font", location.href).href } },
      output: { font: "mathjax-newcm" },
      // no context menu / speech / braille / enrichment: avoids loading SRE (~4.6 MB) and its worker
      options: { enableMenu: false, enableSpeech: false, enableBraille: false, enableEnrichment: false, enableExplorer: false },
    };
    const s = document.createElement("script");
    s.src = "./vendor/mathjax/startup.js"; s.async = true; s.id = "MathJax-script";
    s.onerror = () => reject(new Error("MathJax failed to load"));
    document.head.appendChild(s);
  });
  return mjReady;
}
const mathCache = new Map<string, string>();
export async function renderTex(tex: string, display: boolean): Promise<string> {
  const key = (display ? "D:" : "I:") + tex;
  const hit = mathCache.get(key); if (hit) return hit;
  const MJ = await loadMathJax();
  try {
    const node = await MJ.tex2svgPromise(tex, { display });
    const html = node.outerHTML; mathCache.set(key, html); return html;
  } catch (e: any) { return `<span class="md-math-error">${escapeHtml(e.message || String(e))}</span>`; }
}

let mermaidMod: Promise<any> | null = null;
let mermaidTheme = "";
let seq = 0;
export async function renderMermaid(code: string): Promise<string> {
  if (!mermaidMod) mermaidMod = import("mermaid").then((m) => m.default);
  const mermaid = await mermaidMod;
  // Typora themes can pick a mermaid theme through the --mermaid-theme CSS variable.
  const theme = (getComputedStyle(document.body).getPropertyValue("--mermaid-theme") || "default").replace(/['"\s]/g, "") || "default";
  if (theme !== mermaidTheme) { mermaid.initialize({ startOnLoad: false, theme, securityLevel: "strict" }); mermaidTheme = theme; }
  try {
    const { svg } = await mermaid.render("mdn-mermaid-" + ++seq, code);
    return svg;
  } catch (e: any) { document.getElementById("dmdn-mermaid-" + seq)?.remove(); return `<pre class="md-diagram-error">${escapeHtml(e.message || String(e))}</pre>`; }
}
export function resetMermaidTheme() { mermaidTheme = ""; }
export const escapeHtml = (s: string) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]!));
