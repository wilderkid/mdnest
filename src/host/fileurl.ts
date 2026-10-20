// Local file <-> `mdfile` URL path, shared by the Tauri host and exporters. Must match
// decode_mdfile_path_for in src-tauri/src/protocols.rs.
//   /home/a b.png             → home/a%20b.png
//   C:\Users\张三\a#1.png      → C:/Users/%E5%BC%A0%E4%B8%89/a%231.png   (every segment encoded: # ? % are legal in names)
//   \\?\C:\x\a.png            → C:/x/a.png                              (verbatim prefix dropped)
//   \\nas\share\a.png         → UNC/nas/share/a.png
export function fileUrlPath(abs: string): string {
  let p = abs.replace(/\\/g, "/");
  p = p.replace(/^\/\/\?\/UNC\//i, "//").replace(/^\/\/\?\//, "");
  if (p.startsWith("//")) p = "UNC/" + p.replace(/^\/+/, "");
  else p = p.replace(/^\/+/, "");
  return p.split("/").map((seg, i) => (i === 0 && /^[A-Za-z]:$/.test(seg) ? seg : encodeURIComponent(seg))).join("/");
}

/** Inverse of fileUrlPath: the part after the scheme's host → a local path. `win` picks backslashes. */
export function pathFromFileUrlPath(urlPath: string, win: boolean): string {
  let p = urlPath.replace(/^\/+/, "");
  try { p = decodeURIComponent(p); } catch { /* keep */ }
  if (/^[A-Za-z]:(\/|$)/.test(p)) return win ? p.replace(/\//g, "\\") : p;
  if (/^UNC\//.test(p)) return "\\\\" + p.slice(4).replace(/\//g, "\\");
  return "/" + p;
}

/** If `src` is one of our local-file URLs (`mdfile://localhost/…`, `http://mdfile.localhost/…`, `/fs/…`), its path. */
export function localPathOfUrl(src: string, win: boolean): string | null {
  const m = /^(?:mdfile:\/\/localhost|https?:\/\/mdfile\.localhost)\/(.*)$/i.exec(src);
  if (m) return pathFromFileUrlPath(m[1].split(/[?#]/)[0], win);
  const fs = /^(?:https?:\/\/[^/]+)?\/fs(\/.*)$/.exec(src);
  if (fs) { try { return decodeURIComponent(fs[1]); } catch { return fs[1]; } }
  return null;
}
