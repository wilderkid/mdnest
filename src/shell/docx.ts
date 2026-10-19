// Built-in Word (.docx) writer. STORE zip + CRC32, no dependencies.
// document.xml, styles, numbering, media, and hyperlink relationships.

import { Node as PMNode } from "prosemirror-model";
import type { Host } from "../host/types";

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

export function crc32(data: Uint8Array): number {
  let c = 0xffffffff;
  for (let i = 0; i < data.length; i++) c = CRC_TABLE[(c ^ data[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function u16(n: number): Uint8Array {
  return new Uint8Array([n & 0xff, (n >>> 8) & 0xff]);
}
function u32(n: number): Uint8Array {
  return new Uint8Array([n & 0xff, (n >>> 8) & 0xff, (n >>> 16) & 0xff, (n >>> 24) & 0xff]);
}

function concat(parts: Uint8Array[]): Uint8Array {
  let n = 0;
  for (const p of parts) n += p.length;
  const out = new Uint8Array(n);
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}

const enc = new TextEncoder();

/** STORE-method zip (method 0). Names are ASCII. */
export function zipStore(files: { name: string; data: Uint8Array }[]): Uint8Array {
  const locals: Uint8Array[] = [];
  const centrals: Uint8Array[] = [];
  let offset = 0;
  for (const f of files) {
    const name = enc.encode(f.name);
    const crc = crc32(f.data);
    const local = concat([
      u32(0x04034b50), u16(20), u16(0), u16(0), u16(0), u16(0),
      u32(crc), u32(f.data.length), u32(f.data.length),
      u16(name.length), u16(0), name, f.data,
    ]);
    const central = concat([
      u32(0x02014b50), u16(20), u16(20), u16(0), u16(0), u16(0), u16(0),
      u32(crc), u32(f.data.length), u32(f.data.length),
      u16(name.length), u16(0), u16(0), u16(0), u16(0), u32(0), u32(offset), name,
    ]);
    locals.push(local);
    centrals.push(central);
    offset += local.length;
  }
  const centralDir = concat(centrals);
  const end = concat([
    u32(0x06054b50), u16(0), u16(0), u16(files.length), u16(files.length),
    u32(centralDir.length), u32(offset), u16(0),
  ]);
  return concat([...locals, centralDir, end]);
}

export function bytesToBase64(bytes: Uint8Array): string {
  let bin = "";
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}

function xml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&apos;" }[c]!));
}

const MAX_CX = 6.5 * 914400; // EMUs, 6.5 inches

interface Img {
  name: string;
  data: Uint8Array;
  ext: string;
  cx: number;
  cy: number;
  relId: string;
}

interface LinkRel {
  id: string;
  target: string;
  external: boolean;
}

export interface DocxOptions {
  title?: string;
  /** Resolve a relative image src against the document folder. Absolute http(s)/data/file URLs are left alone. */
  resolveImage?: (src: string) => string;
  readBytes?: (urlOrPath: string) => Promise<Uint8Array | null>;
  imageSize?: (bytes: Uint8Array, ext: string) => { w: number; h: number } | null;
}

function pngSize(b: Uint8Array): { w: number; h: number } | null {
  if (b.length < 24 || b[0] !== 0x89) return null;
  return { w: (b[16] << 24) | (b[17] << 16) | (b[18] << 8) | b[19], h: (b[20] << 24) | (b[21] << 16) | (b[22] << 8) | b[23] };
}
function gifSize(b: Uint8Array): { w: number; h: number } | null {
  if (b.length < 10 || b[0] !== 0x47) return null;
  return { w: b[6] | (b[7] << 8), h: b[8] | (b[9] << 8) };
}
function jpgSize(b: Uint8Array): { w: number; h: number } | null {
  if (b.length < 4 || b[0] !== 0xff || b[1] !== 0xd8) return null;
  let i = 2;
  while (i + 8 < b.length) {
    if (b[i] !== 0xff) { i++; continue; }
    const m = b[i + 1];
    if (m === 0xc0 || m === 0xc1 || m === 0xc2) {
      return { h: (b[i + 5] << 8) | b[i + 6], w: (b[i + 7] << 8) | b[i + 8] };
    }
    const len = (b[i + 2] << 8) | b[i + 3];
    if (len < 2) break;
    i += 2 + len;
  }
  return null;
}

export function imagePixelSize(bytes: Uint8Array, ext: string): { w: number; h: number } | null {
  const e = ext.toLowerCase();
  if (e === "png") return pngSize(bytes);
  if (e === "gif") return gifSize(bytes);
  if (e === "jpg" || e === "jpeg") return jpgSize(bytes);
  return null;
}

function emuSize(px: { w: number; h: number }): { cx: number; cy: number } {
  const pxToEmu = 914400 / 96;
  let cx = Math.max(1, Math.round(px.w * pxToEmu));
  let cy = Math.max(1, Math.round(px.h * pxToEmu));
  if (cx > MAX_CX) {
    const s = MAX_CX / cx;
    cx = Math.round(MAX_CX);
    cy = Math.max(1, Math.round(cy * s));
  }
  return { cx, cy };
}

function extOf(src: string, bytes: Uint8Array): string {
  const m = /\.(png|jpe?g|gif)(?:$|\?)/i.exec(src);
  if (m) return m[1].toLowerCase() === "jpeg" ? "jpg" : m[1].toLowerCase();
  if (bytes[0] === 0x89 && bytes[1] === 0x50) return "png";
  if (bytes[0] === 0xff && bytes[1] === 0xd8) return "jpg";
  if (bytes[0] === 0x47 && bytes[1] === 0x49) return "gif";
  return "png";
}

async function loadImage(src: string, opt: DocxOptions, images: Img[]): Promise<Img | null> {
  if (!src || !opt.readBytes) return null;
  const resolved = opt.resolveImage ? opt.resolveImage(src) : src;
  const bytes = await opt.readBytes(resolved);
  if (!bytes || !bytes.length) return null;
  const ext = extOf(src, bytes);
  if (ext !== "png" && ext !== "jpg" && ext !== "gif") return null;
  const px = (opt.imageSize ?? imagePixelSize)(bytes, ext) ?? { w: 400, h: 300 };
  const { cx, cy } = emuSize(px);
  const name = "image" + (images.length + 1) + "." + ext;
  const img: Img = { name, data: bytes, ext, cx, cy, relId: "rIdImg" + (images.length + 1) };
  images.push(img);
  return img;
}

function textOf(node: PMNode): string {
  let s = "";
  node.descendants((n) => { if (n.isText) s += n.text; });
  return s;
}

interface RunStyle {
  bold?: boolean;
  italic?: boolean;
  underline?: boolean;
  strike?: boolean;
  code?: boolean;
  sup?: boolean;
  sub?: boolean;
  highlight?: boolean;
  link?: string | null;
}

function rPr(st: RunStyle): string {
  const bits: string[] = [];
  if (st.bold) bits.push("<w:b/>");
  if (st.italic) bits.push("<w:i/>");
  if (st.underline) bits.push('<w:u w:val="single"/>');
  if (st.strike) bits.push("<w:strike/>");
  if (st.code) bits.push('<w:rFonts w:ascii="Consolas" w:hAnsi="Consolas" w:cs="Consolas"/>');
  if (st.sup) bits.push('<w:vertAlign w:val="superscript"/>');
  if (st.sub) bits.push('<w:vertAlign w:val="subscript"/>');
  if (st.highlight) bits.push('<w:highlight w:val="yellow"/>');
  if (st.code) bits.push('<w:shd w:val="clear" w:color="auto" w:fill="F2F2F2"/>');
  return bits.length ? "<w:rPr>" + bits.join("") + "</w:rPr>" : "";
}

function run(text: string, st: RunStyle = {}): string {
  if (!text) return "";
  const preserved = / |^\s|\s$/.test(text);
  const t = `<w:t${preserved ? ' xml:space="preserve"' : ""}>${xml(text)}</w:t>`;
  return `<w:r>${rPr(st)}${t}</w:r>`;
}

function hyperlinkRun(text: string, relId: string, st: RunStyle): string {
  return `<w:hyperlink r:id="${relId}">${run(text, { ...st, underline: true })}</w:hyperlink>`;
}

function p(inner: string, style?: string, extra = ""): string {
  const pPr = (style ? `<w:pStyle w:val="${style}"/>` : "") + extra;
  return `<w:p>${pPr ? "<w:pPr>" + pPr + "</w:pPr>" : ""}${inner}</w:p>`;
}

function headingStyle(level: number): string {
  const n = Math.min(6, Math.max(1, level));
  return n === 1 ? "Title" : "Heading" + (n - 1);
}

class Writer {
  images: Img[] = [];
  links: LinkRel[] = [];
  footnotes: string[] = [];
  linkN = 0;

  constructor(private opt: DocxOptions) {}

  linkRel(href: string): string {
    this.linkN++;
    const id = "rIdLink" + this.linkN;
    const external = /^(https?:|mailto:)/i.test(href);
    this.links.push({ id, target: href, external });
    return id;
  }

  styleOf(marks: readonly { type: { name: string }; attrs: any }[]): RunStyle {
    const st: RunStyle = {};
    for (const m of marks) {
      if (m.type.name === "strong") st.bold = true;
      else if (m.type.name === "em") st.italic = true;
      else if (m.type.name === "underline") st.underline = true;
      else if (m.type.name === "strike") st.strike = true;
      else if (m.type.name === "code") st.code = true;
      else if (m.type.name === "superscript") st.sup = true;
      else if (m.type.name === "subscript") st.sub = true;
      else if (m.type.name === "highlight") st.highlight = true;
      else if (m.type.name === "link") st.link = m.attrs.href || "";
    }
    return st;
  }

  async inline(node: PMNode, inherited: RunStyle = {}): Promise<string> {
    let out = "";
    for (let i = 0; i < node.childCount; i++) {
      const ch = node.child(i);
      if (ch.isText) {
        const st = { ...inherited, ...this.styleOf(ch.marks) };
        const text = ch.text || "";
        if (st.link) {
          const id = this.linkRel(st.link);
          out += hyperlinkRun(text, id, st);
        } else out += run(text, st);
      } else if (ch.type.name === "hard_break") {
        out += "<w:r><w:br/></w:r>";
      } else if (ch.type.name === "inline_math") {
        out += run(ch.attrs.tex || "", { ...inherited, code: true });
      } else if (ch.type.name === "footnote_ref") {
        const label = String(ch.attrs.label || "");
        out += run("[" + label + "]", { ...inherited, sup: true });
      } else if (ch.type.name === "image") {
        const img = await loadImage(String(ch.attrs.src || ""), this.opt, this.images);
        const alt = String(ch.attrs.alt || "");
        if (img) out += drawing(img, alt);
        else out += run(alt ? "[image: " + alt + "]" : "[image]", inherited);
      } else {
        out += await this.inline(ch, inherited);
      }
    }
    return out;
  }

  async blocks(node: PMNode, list?: { numId: string; ilvl: number }): Promise<string> {
    let out = "";
    for (let i = 0; i < node.childCount; i++) out += await this.block(node.child(i), list);
    return out;
  }

  async block(node: PMNode, list?: { numId: string; ilvl: number }): Promise<string> {
    const name = node.type.name;
    if (name === "heading") {
      const level = +node.attrs.level || 1;
      return p(await this.inline(node), headingStyle(level));
    }
    if (name === "paragraph") {
      const extra = list ? `<w:numPr><w:ilvl w:val="${list.ilvl}"/><w:numId w:val="${list.numId}"/></w:numPr>` : "";
      const style = list ? "ListParagraph" : undefined;
      return p(await this.inline(node), style, extra);
    }
    if (name === "blockquote") {
      let inner = "";
      for (let i = 0; i < node.childCount; i++) {
        const ch = node.child(i);
        if (ch.type.name === "paragraph") inner += p(await this.inline(ch), "Quote");
        else inner += await this.block(ch);
      }
      return inner || p("", "Quote");
    }
    if (name === "code_block") {
      const lines = node.textContent.split("\n");
      return lines.map((line) => p(run(line || " ", { code: true }), "Code")).join("");
    }
    if (name === "math_block") {
      return p(run(node.textContent, { code: true }), "Code");
    }
    if (name === "horizontal_rule") {
      return p("", undefined, '<w:pBdr><w:bottom w:val="single" w:sz="6" w:space="1" w:color="auto"/></w:pBdr>');
    }
    if (name === "bullet_list" || name === "ordered_list") {
      const numId = name === "bullet_list" ? "1" : "2";
      const ilvl = list ? list.ilvl + 1 : 0;
      let out = "";
      for (let i = 0; i < node.childCount; i++) out += await this.listItem(node.child(i), numId, Math.min(8, ilvl));
      return out;
    }
    if (name === "table") return this.table(node);
    if (name === "toc") return this.toc(node);
    if (name === "html_block") return p(run(String(node.attrs.html || ""), { code: true }), "Code");
    if (name === "footnote_def") {
      this.footnotes.push("[" + node.attrs.label + "] " + textOf(node));
      return "";
    }
    if (name === "front_matter" || name === "link_def") return "";
    if (name === "doc") return this.blocks(node);
    return this.blocks(node);
  }

  async listItem(item: PMNode, numId: string, ilvl: number): Promise<string> {
    const checked = item.attrs.checked;
    const box = checked === true ? "☑ " : checked === false ? "☐ " : "";
    let out = "";
    let first = true;
    for (let i = 0; i < item.childCount; i++) {
      const ch = item.child(i);
      if (ch.type.name === "paragraph" && first) {
        const prefix = box ? run(box) : "";
        const extra = `<w:numPr><w:ilvl w:val="${ilvl}"/><w:numId w:val="${numId}"/></w:numPr>`;
        out += p(prefix + await this.inline(ch), "ListParagraph", extra);
        first = false;
      } else if (ch.type.name === "bullet_list" || ch.type.name === "ordered_list") {
        out += await this.block(ch, { numId, ilvl });
      } else {
        out += await this.block(ch);
      }
    }
    return out;
  }

  async table(node: PMNode): Promise<string> {
    const rows: string[] = [];
    let header = true;
    for (let r = 0; r < node.childCount; r++) {
      const row = node.child(r);
      const cells: string[] = [];
      for (let c = 0; c < row.childCount; c++) {
        const cell = row.child(c);
        const align = cell.attrs.align as string | null;
        const jc = align === "center" ? "center" : align === "right" ? "right" : align === "left" ? "left" : "";
        const inner = await this.inline(cell);
        const pPr = (header ? '<w:pStyle w:val="Heading1"/>' : "") + (jc ? `<w:jc w:val="${jc}"/>` : "");
        const body = `<w:p>${pPr ? "<w:pPr>" + pPr + "</w:pPr>" : ""}${inner}</w:p>`;
        const shd = header ? '<w:shd w:val="clear" w:color="auto" w:fill="E7E6E6"/>' : "";
        cells.push(`<w:tc><w:tcPr>${shd}</w:tcPr>${body}</w:tc>`);
      }
      rows.push("<w:tr>" + cells.join("") + "</w:tr>");
      header = false;
    }
    return `<w:tbl><w:tblPr><w:tblW w:w="5000" w:type="pct"/><w:tblBorders>
      <w:top w:val="single" w:sz="4" w:space="0" w:color="auto"/>
      <w:left w:val="single" w:sz="4" w:space="0" w:color="auto"/>
      <w:bottom w:val="single" w:sz="4" w:space="0" w:color="auto"/>
      <w:right w:val="single" w:sz="4" w:space="0" w:color="auto"/>
      <w:insideH w:val="single" w:sz="4" w:space="0" w:color="auto"/>
      <w:insideV w:val="single" w:sz="4" w:space="0" w:color="auto"/>
    </w:tblBorders></w:tblPr>${rows.join("")}</w:tbl>`;
  }

  toc(_root: PMNode): string {
    const list = this.headings;
    if (!list.length) {
      return p(run("Contents"), "Heading1") + p('<w:r><w:fldChar w:fldCharType="begin"/></w:r><w:r><w:instrText xml:space="preserve"> TOC \\o "1-3" \\h </w:instrText></w:r><w:r><w:fldChar w:fldCharType="end"/></w:r>');
    }
    let out = p(run("Contents"), "Heading1");
    for (const h of list) {
      const indent = Math.max(0, h.level - 1) * 360;
      out += p(run(h.text), undefined, `<w:ind w:left="${indent}"/>`);
    }
    return out;
  }

  headings: { level: number; text: string }[] = [];
}

function drawing(img: Img, alt: string): string {
  const id = img.relId.replace(/\D/g, "") || "1";
  return `<w:r><w:drawing><wp:inline distT="0" distB="0" distL="0" distR="0">
    <wp:extent cx="${img.cx}" cy="${img.cy}"/>
    <wp:docPr id="${id}" name="${xml(img.name)}" descr="${xml(alt)}"/>
    <a:graphic xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main">
      <a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture">
        <pic:pic xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture">
          <pic:nvPicPr><pic:cNvPr id="${id}" name="${xml(img.name)}"/><pic:cNvPicPr/></pic:nvPicPr>
          <pic:blipFill><a:blip r:embed="${img.relId}"/><a:stretch><a:fillRect/></a:stretch></pic:blipFill>
          <pic:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="${img.cx}" cy="${img.cy}"/></a:xfrm>
            <a:prstGeom prst="rect"><a:avLst/></a:prstGeom></pic:spPr>
        </pic:pic>
      </a:graphicData>
    </a:graphic>
  </wp:inline></w:drawing></w:r>`;
}

const CONTENT_TYPES = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  <Default Extension="png" ContentType="image/png"/>
  <Default Extension="jpg" ContentType="image/jpeg"/>
  <Default Extension="jpeg" ContentType="image/jpeg"/>
  <Default Extension="gif" ContentType="image/gif"/>
  <Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
  <Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/>
  <Override PartName="/word/numbering.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.numbering+xml"/>
</Types>`;

const RELS = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>
</Relationships>`;

const STYLES = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
  <w:style w:type="paragraph" w:styleId="Normal" w:default="1"><w:name w:val="Normal"/><w:qFormat/></w:style>
  <w:style w:type="paragraph" w:styleId="Title"><w:name w:val="Title"/><w:basedOn w:val="Normal"/>
    <w:pPr><w:outlineLvl w:val="0"/></w:pPr><w:rPr><w:b/><w:sz w:val="36"/></w:rPr></w:style>
  <w:style w:type="paragraph" w:styleId="Heading1"><w:name w:val="heading 1"/><w:basedOn w:val="Normal"/>
    <w:pPr><w:outlineLvl w:val="0"/></w:pPr><w:rPr><w:b/><w:sz w:val="32"/></w:rPr></w:style>
  <w:style w:type="paragraph" w:styleId="Heading2"><w:name w:val="heading 2"/><w:basedOn w:val="Normal"/>
    <w:pPr><w:outlineLvl w:val="1"/></w:pPr><w:rPr><w:b/><w:sz w:val="28"/></w:rPr></w:style>
  <w:style w:type="paragraph" w:styleId="Heading3"><w:name w:val="heading 3"/><w:basedOn w:val="Normal"/>
    <w:pPr><w:outlineLvl w:val="2"/></w:pPr><w:rPr><w:b/><w:sz w:val="26"/></w:rPr></w:style>
  <w:style w:type="paragraph" w:styleId="Heading4"><w:name w:val="heading 4"/><w:basedOn w:val="Normal"/>
    <w:pPr><w:outlineLvl w:val="3"/></w:pPr><w:rPr><w:b/><w:sz w:val="24"/></w:rPr></w:style>
  <w:style w:type="paragraph" w:styleId="Heading5"><w:name w:val="heading 5"/><w:basedOn w:val="Normal"/>
    <w:pPr><w:outlineLvl w:val="4"/></w:pPr><w:rPr><w:b/><w:i/></w:rPr></w:style>
  <w:style w:type="paragraph" w:styleId="Heading6"><w:name w:val="heading 6"/><w:basedOn w:val="Normal"/>
    <w:pPr><w:outlineLvl w:val="5"/></w:pPr><w:rPr><w:i/></w:rPr></w:style>
  <w:style w:type="paragraph" w:styleId="Quote"><w:name w:val="Quote"/><w:basedOn w:val="Normal"/>
    <w:pPr><w:ind w:left="720"/></w:pPr><w:rPr><w:i/></w:rPr></w:style>
  <w:style w:type="paragraph" w:styleId="Code"><w:name w:val="Code"/><w:basedOn w:val="Normal"/>
    <w:pPr><w:shd w:val="clear" w:color="auto" w:fill="F2F2F2"/></w:pPr>
    <w:rPr><w:rFonts w:ascii="Consolas" w:hAnsi="Consolas"/></w:rPr></w:style>
  <w:style w:type="paragraph" w:styleId="ListParagraph"><w:name w:val="List Paragraph"/><w:basedOn w:val="Normal"/>
    <w:pPr><w:ind w:left="720"/></w:pPr></w:style>
</w:styles>`;

const NUMBERING = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:numbering xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
  <w:abstractNum w:abstractNumId="0">
    <w:multiLevelType w:val="hybridMultilevel"/>
    ${[0, 1, 2, 3, 4, 5, 6, 7, 8].map((i) => `<w:lvl w:ilvl="${i}"><w:start w:val="1"/><w:numFmt w:val="bullet"/><w:lvlText w:val="${["•", "○", "■"][i % 3]}"/><w:lvlJc w:val="left"/><w:pPr><w:ind w:left="${720 * (i + 1)}" w:hanging="360"/></w:pPr></w:lvl>`).join("")}
  </w:abstractNum>
  <w:abstractNum w:abstractNumId="1">
    <w:multiLevelType w:val="hybridMultilevel"/>
    ${[0, 1, 2, 3, 4, 5, 6, 7, 8].map((i) => `<w:lvl w:ilvl="${i}"><w:start w:val="1"/><w:numFmt w:val="decimal"/><w:lvlText w:val="%${i + 1}."/><w:lvlJc w:val="left"/><w:pPr><w:ind w:left="${720 * (i + 1)}" w:hanging="360"/></w:pPr></w:lvl>`).join("")}
  </w:abstractNum>
  <w:num w:numId="1"><w:abstractNumId w:val="0"/></w:num>
  <w:num w:numId="2"><w:abstractNumId w:val="1"/></w:num>
</w:numbering>`;

function docRels(w: Writer): string {
  const rels = [
    `<Relationship Id="rIdStyles" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>`,
    `<Relationship Id="rIdNum" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/numbering" Target="numbering.xml"/>`,
  ];
  for (const img of w.images) {
    rels.push(`<Relationship Id="${img.relId}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="media/${img.name}"/>`);
  }
  for (const link of w.links) {
    const mode = link.external ? ' TargetMode="External"' : "";
    rels.push(`<Relationship Id="${link.id}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink" Target="${xml(link.target)}"${mode}/>`);
  }
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  ${rels.join("\n  ")}
</Relationships>`;
}

function collectHeadings(doc: PMNode): { level: number; text: string }[] {
  const heads: { level: number; text: string }[] = [];
  doc.descendants((n) => {
    if (n.type.name === "heading") heads.push({ level: +n.attrs.level || 1, text: textOf(n) });
  });
  return heads;
}

/** Build a .docx (OOXML zip) from a ProseMirror document. */
export async function buildDocx(doc: PMNode, opt: DocxOptions = {}): Promise<Uint8Array> {
  const w = new Writer(opt);
  w.headings = collectHeadings(doc);
  let body = await w.blocks(doc);
  if (w.footnotes.length) {
    body += p(run("Notes"), "Heading1");
    for (const note of w.footnotes) body += p(run(note));
  }
  if (!body) body = p("");
  const documentXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"
  xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"
  xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing"
  xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"
  xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture">
  <w:body>${body}<w:sectPr><w:pgSz w:w="12240" w:h="15840"/><w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440"/></w:sectPr></w:body>
</w:document>`;
  const files: { name: string; data: Uint8Array }[] = [
    { name: "[Content_Types].xml", data: enc.encode(CONTENT_TYPES) },
    { name: "_rels/.rels", data: enc.encode(RELS) },
    { name: "word/document.xml", data: enc.encode(documentXml) },
    { name: "word/styles.xml", data: enc.encode(STYLES) },
    { name: "word/numbering.xml", data: enc.encode(NUMBERING) },
    { name: "word/_rels/document.xml.rels", data: enc.encode(docRels(w)) },
  ];
  for (const img of w.images) files.push({ name: "word/media/" + img.name, data: img.data });
  return zipStore(files);
}

/** Read image bytes through the host. `src` may be a host file URL, an absolute path, or http(s). */
export async function readImageBytes(host: Host, src: string): Promise<Uint8Array | null> {
  try {
    if (/^https?:/i.test(src)) {
      const r = await fetch(src);
      if (!r.ok) return null;
      return new Uint8Array(await r.arrayBuffer());
    }
    if (src.startsWith("data:")) {
      const i = src.indexOf(",");
      if (i < 0) return null;
      const b64 = src.slice(i + 1);
      const bin = atob(b64);
      const out = new Uint8Array(bin.length);
      for (let n = 0; n < bin.length; n++) out[n] = bin.charCodeAt(n);
      return out;
    }
    let path = src;
    if (/^mdfile:|^http:\/\/mdfile/i.test(src) || src.startsWith("/fs/")) {
      path = src.replace(/^https?:\/\/mdfile\.localhost\//i, "").replace(/^mdfile:\/\/localhost\//i, "").replace(/^\/fs/, "");
      try { path = decodeURIComponent(path); } catch { /* keep */ }
    } else if (/^https?:\/\/127\.0\.0\.1|^https?:\/\/localhost/i.test(src) && src.includes("/fs/")) {
      path = src.replace(/^https?:\/\/[^/]+\/fs/, "");
      try { path = decodeURIComponent(path); } catch { /* keep */ }
    }
    const b64 = await host.readFileBytes(path);
    const bin = atob(b64);
    const out = new Uint8Array(bin.length);
    for (let n = 0; n < bin.length; n++) out[n] = bin.charCodeAt(n);
    return out;
  } catch {
    return null;
  }
}
