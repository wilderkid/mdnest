// Spell check is off by default. Turning it on sets the spellcheck attribute on #write
// and on CodeMirror source mode. Linux also enables WebKitGTK's enchant/hunspell checker
// through host.setSpellcheck. Windows uses the WebView2 OS spellchecker; macOS uses WKWebView.

export const SPELL_KEY = "mdnest.spellcheck";

export function spellcheckOn(): boolean {
  if (typeof localStorage === "undefined") return false;
  return localStorage.getItem(SPELL_KEY) === "1";
}

/** Apply the current setting to the WYSIWYG surface and, when present, the source editor. */
export function applySpellcheck(on = spellcheckOn()): void {
  const write = document.getElementById("write");
  if (write) write.setAttribute("spellcheck", on ? "true" : "false");
  const source = document.querySelector("#typora-source .CodeMirror") as HTMLElement | null;
  if (source) source.setAttribute("spellcheck", on ? "true" : "false");
  document.body.classList.toggle("mdn-spellcheck", on);
}
