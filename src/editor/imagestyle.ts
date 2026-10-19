// Inline image style: zoom and alignment live on the HTML <img>, never in global CSS.

export type ImageAlign = "left" | "center" | "right" | null;

/** Empty when neither zoom nor alignment is set. */
export function imageStyle(zoom: string | null, align: string | null): string {
  const parts: string[] = [];
  if (align === "center") parts.push("display:block", "margin:0 auto");
  else if (align === "left") parts.push("float:left", "margin:0 12px 8px 0");
  else if (align === "right") parts.push("float:right", "margin:0 0 8px 12px");
  if (zoom) parts.push(`width:${zoom}%`, `zoom:${zoom}%`);
  return parts.join(";");
}

export function imageAlignFromStyle(style: string): ImageAlign {
  if (/float:\s*right/i.test(style)) return "right";
  if (/float:\s*left/i.test(style)) return "left";
  if (/margin:\s*0\s+auto/i.test(style)) return "center";
  return null;
}

export function imageZoomFromStyle(style: string): string | null {
  return (/width:\s*(\d+)%/.exec(style) || /zoom:\s*(\d+)%/.exec(style) || [])[1] || null;
}
