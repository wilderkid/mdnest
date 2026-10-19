// Line endings and legacy encodings.
// The editor works in LF. On save we restore the document's ending and encode with TextDecoder's
// inverse: a lazily built reverse map of every lead/trail pair (and GB18030's 4-byte BMP range).
// No encoding_rs.

export const ENCODINGS = ["UTF-8", "GB18030", "GBK", "Big5", "Shift_JIS", "EUC-KR", "windows-1252"] as const;
export type EncodingName = (typeof ENCODINGS)[number] | "UTF-16LE" | "UTF-16BE";

export const SAVE_ENCODINGS = ["UTF-8", "UTF-8-BOM", "GB18030", "GBK", "Big5", "Shift_JIS", "UTF-16LE"] as const;
export type SaveEncoding = (typeof SAVE_ENCODINGS)[number];

export const EOL_KEY = "mdnest.lineEnding";
export const FALLBACK_KEY = "mdnest.fallbackEncoding";

export interface OpenedFile {
  text: string;
  encoding: SaveEncoding;
  eol: "LF" | "CRLF";
  bom: boolean;
}

const decoderLabel: Record<string, string> = {
  "UTF-8": "utf-8",
  "UTF-8-BOM": "utf-8",
  GB18030: "gb18030",
  GBK: "gbk",
  Big5: "big5",
  Shift_JIS: "shift_jis",
  "EUC-KR": "euc-kr",
  "windows-1252": "windows-1252",
  "UTF-16LE": "utf-16le",
  "UTF-16BE": "utf-16be",
};

export function defaultEol(): "LF" | "CRLF" {
  const stored = typeof localStorage !== "undefined" ? localStorage.getItem(EOL_KEY) : null;
  if (stored === "LF" || stored === "CRLF") return stored;
  const ua = typeof navigator !== "undefined" ? navigator.userAgent : "";
  return /Windows/.test(ua) ? "CRLF" : "LF";
}

export function fallbackEncoding(): EncodingName {
  const stored = typeof localStorage !== "undefined" ? localStorage.getItem(FALLBACK_KEY) : null;
  if (stored && (ENCODINGS as readonly string[]).includes(stored)) return stored as EncodingName;
  return "GB18030";
}

export function detectEol(bytes: Uint8Array): "LF" | "CRLF" {
  let crlf = 0, lf = 0;
  for (let i = 0; i < bytes.length; i++) {
    if (bytes[i] === 0x0a) {
      if (i > 0 && bytes[i - 1] === 0x0d) crlf++;
      else lf++;
    }
  }
  return crlf > lf ? "CRLF" : "LF";
}

export function applyEol(text: string, eol: "LF" | "CRLF"): string {
  const lf = text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  return eol === "CRLF" ? lf.replace(/\n/g, "\r\n") : lf;
}

export function toLf(text: string): string {
  return text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
}

function hasUtf8Bom(b: Uint8Array): boolean {
  return b.length >= 3 && b[0] === 0xef && b[1] === 0xbb && b[2] === 0xbf;
}
function hasUtf16LeBom(b: Uint8Array): boolean {
  return b.length >= 2 && b[0] === 0xff && b[1] === 0xfe;
}
function hasUtf16BeBom(b: Uint8Array): boolean {
  return b.length >= 2 && b[0] === 0xfe && b[1] === 0xff;
}

export function isStrictUtf8(bytes: Uint8Array): boolean {
  try {
    const dec = new TextDecoder("utf-8", { fatal: true });
    dec.decode(bytes);
    return true;
  } catch {
    return false;
  }
}

function decodeLabel(bytes: Uint8Array, label: string): string {
  return new TextDecoder(label, { fatal: true }).decode(bytes);
}

const decoderAliases: Record<string, string> = {
  "UTF-8": "utf-8", "UTF-8-BOM": "utf-8", GB18030: "gb18030", GBK: "gbk", Big5: "big5",
  Shift_JIS: "shift_jis", "EUC-KR": "euc-kr", "windows-1252": "windows-1252",
  "UTF-16LE": "utf-16le", "UTF-16BE": "utf-16be",
};

/** Decode with a named encoding, ignoring a leading BOM of that family. */
export function decodeAs(bytes: Uint8Array, encoding: string): string {
  const label = decoderAliases[encoding] || encoding;
  let body = bytes;
  if ((encoding === "UTF-8" || encoding === "UTF-8-BOM") && hasUtf8Bom(bytes)) body = bytes.subarray(3);
  else if (encoding === "UTF-16LE" && hasUtf16LeBom(bytes)) body = bytes.subarray(2);
  else if (encoding === "UTF-16BE" && hasUtf16BeBom(bytes)) body = bytes.subarray(2);
  let text: string;
  try { text = new TextDecoder(label, { fatal: false }).decode(body); }
  catch { text = new TextDecoder("utf-8").decode(body); }
  return toLf(text);
}

/** Detect BOM, else strict UTF-8, else the fallback encoding. Line ending is majority CRLF, else LF. */
export function openBytes(bytes: Uint8Array, fallback: EncodingName = "GB18030"): OpenedFile {
  const eol = detectEol(bytes);
  if (hasUtf8Bom(bytes)) {
    const text = toLf(new TextDecoder("utf-8").decode(bytes.subarray(3)));
    return { text, encoding: "UTF-8-BOM", eol, bom: true };
  }
  if (hasUtf16LeBom(bytes)) {
    const text = toLf(new TextDecoder("utf-16le").decode(bytes.subarray(2)));
    return { text, encoding: "UTF-16LE", eol, bom: true };
  }
  if (hasUtf16BeBom(bytes)) {
    const text = toLf(new TextDecoder("utf-16be").decode(bytes.subarray(2)));
    return { text, encoding: "UTF-16LE", eol, bom: true };
  }
  if (isStrictUtf8(bytes)) {
    return { text: toLf(new TextDecoder("utf-8").decode(bytes)), encoding: "UTF-8", eol, bom: false };
  }
  const label = decoderLabel[fallback] || "gb18030";
  let text: string;
  try { text = decodeLabel(bytes, label); }
  catch {
    text = new TextDecoder(label).decode(bytes);
  }
  const enc = (ENCODINGS as readonly string[]).includes(fallback) ? fallback : "GB18030";
  const saveEnc: SaveEncoding = enc === "UTF-8" ? "UTF-8" : (SAVE_ENCODINGS as readonly string[]).includes(enc) ? enc as SaveEncoding : "GB18030";
  return { text: toLf(text), encoding: saveEnc, eol, bom: false };
}

export function b64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export function bytesToB64(bytes: Uint8Array): string {
  let bin = "";
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}

interface EncMap {
  /** code point → bytes. Missing means unmappable. */
  map: Map<number, Uint8Array>;
}

const maps = new Map<string, EncMap>();

function put(map: Map<number, Uint8Array>, cp: number, bytes: number[]) {
  if (cp < 0 || cp > 0x10ffff) return;
  if (!map.has(cp)) map.set(cp, Uint8Array.from(bytes));
}

/**
 * Build a reverse map by decoding every lead/trail pair with TextDecoder.
 * GB18030 also covers its 4-byte BMP range (0x81308130–0x8439FE39, skipping 0x7F and 0xFF).
 */
export function buildReverseMap(encoding: string): EncMap {
  const key = encoding.toLowerCase();
  const hit = maps.get(key);
  if (hit) return hit;
  const label = decoderLabel[encoding] || decoderLabel[encoding.toUpperCase()] || key;
  const dec = new TextDecoder(label);
  const map = new Map<number, Uint8Array>();
  // ASCII stays identity. Multi-byte sequences overwrite if a charset uses them.
  for (let i = 0; i < 128; i++) put(map, i, [i]);
  const single = new Uint8Array(1);
  for (let b = 0x80; b <= 0xff; b++) {
    single[0] = b;
    const s = dec.decode(single);
    if (s && s.length === 1 && s !== "\uFFFD") put(map, s.codePointAt(0)!, [b]);
  }
  const pair = new Uint8Array(2);
  for (let lead = 0x81; lead <= 0xfe; lead++) {
    for (let trail = 0x40; trail <= 0xfe; trail++) {
      if (trail === 0x7f) continue;
      pair[0] = lead; pair[1] = trail;
      const s = dec.decode(pair);
      if (!s || s.includes("\uFFFD") || s.length !== 1) continue;
      put(map, s.codePointAt(0)!, [lead, trail]);
    }
  }
  if (label === "gb18030") fillGb18030Quad(dec, map);
  const built = { map };
  maps.set(key, built);
  maps.set(label, built);
  return built;
}

/** GB18030 4-byte BMP sequences. Second and fourth bytes are 0x30–0x39. */
function fillGb18030Quad(dec: TextDecoder, map: Map<number, Uint8Array>) {
  const seq = new Uint8Array(4);
  for (let b1 = 0x81; b1 <= 0x84; b1++) {
    const b2max = b1 === 0x84 ? 0x39 : 0xfe;
    for (let b2 = 0x30; b2 <= b2max; b2++) {
      if (b2 === 0x7f || b2 === 0xff) continue;
      // The BMP range uses 0x30–0x39 in the second byte. Skip the 2-byte area.
      if (b2 > 0x39) continue;
      for (let b3 = 0x81; b3 <= 0xfe; b3++) {
        for (let b4 = 0x30; b4 <= 0x39; b4++) {
          seq[0] = b1; seq[1] = b2; seq[2] = b3; seq[3] = b4;
          const s = dec.decode(seq);
          if (!s || s.includes("\uFFFD")) continue;
          const cp = s.codePointAt(0)!;
          if (s.length !== (cp > 0xffff ? 2 : 1)) continue;
          // Do not let a 4-byte sequence overwrite a shorter encoding of the same character.
          if (map.has(cp) && map.get(cp)!.length <= 2) continue;
          put(map, cp, [b1, b2, b3, b4]);
        }
      }
    }
  }
}

export interface EncodeResult {
  bytes: Uint8Array;
  unmapped: string[];
}

export function encodeText(text: string, encoding: SaveEncoding): EncodeResult {
  if (encoding === "UTF-8" || encoding === "UTF-8-BOM") {
    const body = new TextEncoder().encode(text);
    if (encoding === "UTF-8") return { bytes: body, unmapped: [] };
    const out = new Uint8Array(3 + body.length);
    out.set([0xef, 0xbb, 0xbf]);
    out.set(body, 3);
    return { bytes: out, unmapped: [] };
  }
  if (encoding === "UTF-16LE") {
    const chars = text.length;
    const out = new Uint8Array(2 + chars * 2);
    out[0] = 0xff; out[1] = 0xfe;
    for (let i = 0; i < chars; i++) {
      const c = text.charCodeAt(i);
      out[2 + i * 2] = c & 0xff;
      out[3 + i * 2] = c >> 8;
    }
    return { bytes: out, unmapped: [] };
  }
  const built = buildReverseMap(encoding);
  const chunks: number[] = [];
  const unmapped: string[] = [];
  for (const ch of text) {
    const cp = ch.codePointAt(0)!;
    const bytes = built.map.get(cp);
    if (!bytes) {
      if (unmapped.length < 12 && !unmapped.includes(ch)) unmapped.push(ch);
      chunks.push(0x3f);
      continue;
    }
    for (const b of bytes) chunks.push(b);
  }
  return { bytes: Uint8Array.from(chunks), unmapped };
}

export function encodingLabel(enc: SaveEncoding, eol: "LF" | "CRLF"): string {
  const name = enc === "UTF-8-BOM" ? "UTF-8 BOM" : enc;
  return `${name} · ${eol}`;
}
