// Folder exclusion. Patterns are relative to the workspace root or absolute.
// A document under an excluded folder is never sent and AI actions on it are refused.

export interface ExcludeOpts {
  /** Workspace root, when known. Relative patterns are matched against this. */
  workspace?: string | null;
}

function slash(p: string): string {
  return p.replace(/\\/g, "/");
}

function stripTrailing(p: string): string {
  return p.replace(/\/+$/, "");
}

/** Split an exclude box: one folder or glob-ish prefix per line. `#` starts a comment. */
export function parseExclude(text: string): string[] {
  return text
    .split(/\r?\n/)
    .map((line) => line.replace(/#.*$/, "").trim())
    .filter(Boolean);
}

function isAbsolute(p: string): boolean {
  return p.startsWith("/") || /^[A-Za-z]:[\\/]/.test(p);
}

/** Glob-ish prefix: `*` matches within one path segment, `**` matches across segments. */
function globToRegExp(pattern: string): RegExp {
  let re = "";
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i];
    if (c === "*" && pattern[i + 1] === "*") {
      re += ".*";
      i++;
      if (pattern[i + 1] === "/") i++;
    } else if (c === "*") re += "[^/]*";
    else if (c === "?") re += "[^/]";
    else re += c.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  }
  return new RegExp("^" + re, "i");
}

function matchesPattern(file: string, pattern: string): boolean {
  const f = stripTrailing(slash(file)).toLowerCase();
  let pat = stripTrailing(slash(pattern.trim()));
  if (!pat) return false;
  const abs = isAbsolute(pat);
  if (!abs) pat = pat.replace(/^\.\//, "");
  const target = abs ? f : f.replace(/^\/+/, "");
  const p = pat.toLowerCase();
  if (p.includes("*") || p.includes("?")) {
    const rx = globToRegExp(abs ? p : p);
    if (abs) return rx.test(f) || rx.test(f + "/");
    // Relative glob: match a path suffix (workspace-relative or any folder prefix).
    const parts = f.split("/");
    for (let i = 0; i < parts.length; i++) {
      const suffix = parts.slice(i).join("/");
      if (rx.test(suffix) || rx.test(suffix + "/")) return true;
    }
    return false;
  }
  const needle = abs ? p : "/" + p;
  if (abs) return f === p || f.startsWith(p + "/");
  return f === p || f.endsWith(needle) || f.includes(needle + "/") || f.startsWith(p + "/");
}

/**
 * True when `filePath` sits under one of `patterns`.
 * Relative patterns match against `workspace` and also as a path suffix, so
 * `private` matches both `/work/private/a.md` and `C:\work\private\a.md`.
 */
export function isExcluded(filePath: string | null | undefined, patterns: string[], opts: ExcludeOpts = {}): boolean {
  if (!filePath || !patterns.length) return false;
  const file = slash(filePath);
  const ws = opts.workspace ? stripTrailing(slash(opts.workspace)) : "";
  let rel = "";
  if (ws) {
    const fl = file.toLowerCase();
    const wl = ws.toLowerCase();
    if (fl === wl || fl.startsWith(wl + "/")) rel = file.slice(ws.length).replace(/^\/+/, "");
  }
  for (const raw of patterns) {
    const pat = raw.trim();
    if (!pat) continue;
    if (matchesPattern(file, pat)) return true;
    if (rel && matchesPattern(rel, pat)) return true;
    if (ws && !isAbsolute(pat)) {
      const joined = ws + "/" + pat.replace(/^\.\//, "").replace(/\\/g, "/");
      if (matchesPattern(file, joined)) return true;
    }
  }
  return false;
}
