// Language picker for code fences: the input at the block's bottom-right autocompletes known languages
// (Typora-like). Keyboard: ↑/↓ choose, Enter/Tab accept, Esc cancels; mouse click accepts.
import { t } from "../i18n";

/** [fence id, display name, extra aliases] — the first id is what lands in ```lang */
export const LANGUAGES: [string, string, string?][] = [
  ["javascript", "JavaScript", "js jsx node"], ["typescript", "TypeScript", "ts tsx"], ["python", "Python", "py"],
  ["java", "Java"], ["c", "C", "h"], ["cpp", "C++", "c++ cc hpp"], ["csharp", "C#", "cs"], ["go", "Go", "golang"],
  ["rust", "Rust", "rs"], ["kotlin", "Kotlin", "kt"], ["swift", "Swift"], ["scala", "Scala"], ["php", "PHP"],
  ["ruby", "Ruby", "rb"], ["lua", "Lua"], ["sql", "SQL", "mysql postgres"], ["shell", "Shell", "sh"], ["bash", "Bash", "sh zsh"],
  ["powershell", "PowerShell", "ps1 pwsh"], ["console", "Console"], ["html", "HTML", "htm"], ["xml", "XML", "svg"],
  ["css", "CSS"], ["json", "JSON"], ["yaml", "YAML", "yml"], ["toml", "TOML", "ini"], ["markdown", "Markdown", "md"],
  ["latex", "LaTeX", "tex"], ["diff", "Diff", "patch"], ["dockerfile", "Dockerfile", "docker"], ["vue", "Vue"],
  ["mermaid", "Mermaid", "diagram flowchart"], ["text", "Plain Text", "plain txt plaintext"],
];

export function matchLanguages(q: string, limit = 8): [string, string][] {
  const s = q.trim().toLowerCase();
  if (!s) return LANGUAGES.slice(0, limit).map(([id, name]) => [id, name]);
  const scored: [number, string, string][] = [];
  for (const [id, name, alias] of LANGUAGES) {
    const words = [id, name.toLowerCase(), ...(alias ?? "").split(" ").filter(Boolean)];
    let score = -1;
    if (words.some((w) => w === s)) score = 0;
    else if (words.some((w) => w.startsWith(s))) score = 1;
    else if (words.some((w) => w.includes(s))) score = 2;
    if (score >= 0) scored.push([score, id, name]);
  }
  scored.sort((a, b) => a[0] - b[0] || a[1].length - b[1].length);
  return scored.slice(0, limit).map(([, id, name]) => [id, name]);
}

/**
 * Wire autocomplete to a fence's language input. `commit(lang)` writes the language; `done()` returns
 * focus to the code (after Enter / Esc).
 */
export function attachLangPicker(inp: HTMLInputElement, commit: (lang: string) => void, done: () => void) {
  let menu: HTMLDivElement | null = null;
  let items: [string, string][] = [];
  let sel = 0;
  let original = inp.value;
  const close = () => { menu?.remove(); menu = null; };
  const render = () => {
    items = matchLanguages(inp.value);
    if (!items.length) { close(); return; }
    if (!menu) {
      menu = document.createElement("div");
      menu.className = "mdn-lang-menu";
      menu.setAttribute("role", "listbox");
      menu.addEventListener("mousedown", (e) => e.preventDefault());
      document.body.appendChild(menu);
    }
    sel = Math.min(sel, items.length - 1);
    menu.replaceChildren(...items.map(([id, name], i) => {
      const row = document.createElement("div");
      row.className = "mdn-lang-item" + (i === sel ? " sel" : "");
      row.setAttribute("role", "option"); row.dataset.lang = id;
      const b = document.createElement("span"); b.textContent = name;
      const s = document.createElement("small"); s.textContent = id;
      row.append(b, s);
      row.addEventListener("click", () => accept(id));
      return row;
    }));
    const r = inp.getBoundingClientRect();
    const h = menu.offsetHeight || items.length * 24;
    const below = r.bottom + 2 + h < window.innerHeight;
    menu.style.left = Math.max(4, Math.min(r.left, window.innerWidth - menu.offsetWidth - 4)) + "px";
    menu.style.top = (below ? r.bottom + 2 : r.top - 2 - h) + "px";
    menu.querySelector(".sel")?.scrollIntoView({ block: "nearest" });
  };
  const accept = (lang: string) => {
    inp.value = lang; original = lang; close(); commit(lang); done();
  };
  inp.placeholder = t("language…");
  inp.title = t("Code language");
  inp.setAttribute("autocomplete", "off"); inp.spellcheck = false;
  inp.addEventListener("focus", () => { original = inp.value; sel = 0; render(); inp.select(); });
  inp.addEventListener("input", () => { sel = 0; render(); });
  inp.addEventListener("blur", () => { close(); if (inp.value.trim() !== original.trim()) { original = inp.value.trim(); commit(original); } });
  inp.addEventListener("keydown", (e) => {
    if (e.isComposing || e.keyCode === 229) return;
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      if (!menu) { render(); return; }
      sel = (sel + (e.key === "ArrowDown" ? 1 : -1) + items.length) % items.length; render();
    } else if (e.key === "Enter" || (e.key === "Tab" && menu)) {
      e.preventDefault();
      const typed = inp.value.trim();
      // Enter keeps exactly what was typed unless a suggestion was picked with the arrows or matches it
      const pick = menu && items[sel] && (sel > 0 || matchLanguages(typed, 1)[0]?.[0] === items[sel][0] && typed !== "") ? items[sel][0] : typed;
      accept(e.key === "Tab" && items[sel] ? items[sel][0] : pick);
    } else if (e.key === "Escape") {
      e.preventDefault(); inp.value = original; close(); done();
    }
    e.stopPropagation();
  });
}
