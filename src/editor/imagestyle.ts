// Image size and alignment, Typora-compatible:
//   zoom       → <img … style="zoom:50%;" />            (exactly what Typora writes for "Zoom Image")
//   width (px) → <img … width="320" />
//   align      → style="display:block;margin:0 auto;" (center) / margin-left:auto (right) / margin-right:auto (left)
// A plain ![]() stays plain until the user sizes or aligns it. An image that came from an HTML tag keeps
// that tag verbatim until it is changed, and then only the size/alignment parts of it are rewritten.

export type ImageAlign = "left" | "center" | "right" | null;
export const ZOOM_PRESETS = [25, 33, 50, 67, 75, 100, 150, 200];

/** CSS for the <img> itself (display and saved form). */
export function imageStyle(zoom: string | null, align: string | null): string {
  const parts: string[] = [];
  if (align === "center") parts.push("display:block", "margin:0 auto");
  else if (align === "left") parts.push("display:block", "margin-right:auto");
  else if (align === "right") parts.push("display:block", "margin-left:auto");
  if (zoom) parts.push(`zoom:${zoom}%`);
  return parts.join(";");
}

export function imageAlignFromStyle(style: string): ImageAlign {
  const s = style.replace(/\s+/g, "").toLowerCase();
  if (/float:right/.test(s)) return "right";
  if (/float:left/.test(s)) return "left";
  if (/margin:0auto|margin:0pxauto|margin-left:auto;?.*margin-right:auto|margin-right:auto;?.*margin-left:auto/.test(s)) return "center";
  if (/margin-left:auto/.test(s)) return "right";
  if (/display:block/.test(s) && /margin-right:auto/.test(s)) return "left";
  return null;
}

export function imageZoomFromStyle(style: string): string | null {
  const z = /(?:^|;)\s*zoom:\s*(\d+(?:\.\d+)?)%/i.exec(style);
  if (z) return String(Math.round(+z[1]));
  // 0.1.x wrote width:N% next to zoom; a lone width:N% is the user's own CSS, not a zoom
  return null;
}

/** width="320" / width="320px" / style width:320px → "320" */
export function imageWidthFromAttrs(widthAttr: string | null | undefined, style: string): string | null {
  const w = /^\s*(\d+(?:\.\d+)?)(?:px)?\s*$/i.exec(widthAttr || "");
  if (w) return String(Math.round(+w[1]));
  const s = /(?:^|;)\s*width:\s*(\d+(?:\.\d+)?)px/i.exec(style);
  return s ? String(Math.round(+s[1])) : null;
}

export interface ImgAttrs { src: string; alt: string | null; title: string | null; zoom: string | null; align: string | null; width: string | null }

const ATTR_RE = /([^\s=/>"']+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+)))?/g;
/** attributes of an `<img …>` tag, in source order */
export function imgTagAttrs(tag: string): [string, string | null][] {
  const m = /^<img\b([\s\S]*?)\/?>$/i.exec(tag.trim());
  if (!m) return [];
  const out: [string, string | null][] = [];
  for (const a of m[1].matchAll(ATTR_RE)) out.push([a[1], a[2] ?? a[3] ?? a[4] ?? null]);
  return out;
}
const decode = (v: string) => v.replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");
const enc = (v: string) => v.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");

/** image attributes described by an `<img>` tag (null when it is not one) */
export function parseImgTag(tag: string): ImgAttrs | null {
  const attrs = imgTagAttrs(tag);
  const get = (n: string) => { const a = attrs.find(([k]) => k.toLowerCase() === n); return a ? (a[1] == null ? "" : decode(a[1])) : null; };
  const src = get("src");
  if (!src) return null;
  const style = get("style") || "";
  return { src, alt: get("alt"), title: get("title"), zoom: imageZoomFromStyle(style), align: imageAlignFromStyle(style), width: imageWidthFromAttrs(get("width"), style) };
}

const OURS = /^(zoom|display|margin|margin-left|margin-right|float)$/i;
/** `<img>` markup for `a`; when `orig` is an `<img>` tag, everything we do not manage in it is kept. */
export function imgTag(a: ImgAttrs, orig?: string | null): string {
  const attrs: [string, string | null][] = orig ? imgTagAttrs(orig) : [];
  const set = (name: string, value: string | null) => {
    const i = attrs.findIndex(([k]) => k.toLowerCase() === name);
    if (value == null) { if (i >= 0) attrs.splice(i, 1); return; }
    if (i >= 0) attrs[i] = [attrs[i][0], value]; else attrs.push([name, value]);
  };
  set("src", a.src);
  set("alt", a.alt ?? "");
  if (a.title) set("title", a.title); else set("title", null);
  // style: drop the declarations we manage (and 0.1.x's width:N%), then put ours first
  const oldStyle = (attrs.find(([k]) => k.toLowerCase() === "style")?.[1] ?? "");
  const keep = decode(oldStyle).split(";").map((d) => d.trim()).filter(Boolean)
    .filter((d) => { const [k, v = ""] = d.split(":").map((x) => x.trim()); return !OURS.test(k) && !(k.toLowerCase() === "width" && (/%$/.test(v) || /px$/.test(v))); });
  const ours = imageStyle(a.zoom, a.align);
  const style = [ours, ...keep].filter(Boolean).join(";");
  set("style", style ? style + ";" : null);
  set("width", a.width);
  // Typora order: src, alt, (width), then the rest
  const order = (k: string) => ({ src: 0, alt: 1, width: 2 } as Record<string, number>)[k.toLowerCase()] ?? 3;
  attrs.sort((x, y) => order(x[0]) - order(y[0]));
  return "<img " + attrs.map(([k, v]) => (v == null ? k : `${k}="${enc(v)}"`)).join(" ") + " />";
}

export const sameImg = (x: ImgAttrs, y: ImgAttrs) =>
  x.src === y.src && (x.alt || "") === (y.alt || "") && (x.title || "") === (y.title || "") && (x.zoom || null) === (y.zoom || null) && (x.align || null) === (y.align || null) && (x.width || null) === (y.width || null);

/** the style attribute value the <img> is shown with (ours + whatever else the original tag had) */
export function displayStyle(a: ImgAttrs, orig?: string | null): string {
  if (!orig) return imageStyle(a.zoom, a.align);
  const st = imgTagAttrs(imgTag(a, orig)).find(([k]) => k.toLowerCase() === "style")?.[1];
  return st ? decode(st) : "";
}
