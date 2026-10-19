// Menu spec shared by the native menu (Tauri `set_app_menu`) and the HTML menubar used by the
// browser host / Playwright. Built from the command registry and live app state.
import type { Command } from "../plugins/api";
import { commandEnabled, parseAccelerator } from "./commands";
import { t } from "../i18n";

export interface MenuNode {
  id?: string;
  label?: string;
  /** "CmdOrCtrl+Shift+K". Omitted when a plugin currently owns the same key. */
  accel?: string;
  checked?: boolean;
  enabled?: boolean;
  /** separator | cut | copy | paste | select_all | undo | redo */
  role?: string;
  submenu?: MenuNode[];
}

export interface MenuState {
  recent: string[];
  themes: string[];
  currentTheme: string;
  sourceMode: boolean;
  sidebar: boolean;
  outline: boolean;
  hasPath: boolean;
  inTable: boolean;
  /** Enabled plugin command ids that own a key, so the core item drops its native accelerator. */
  pluginKeyOwners: Set<string>;
  focusMode?: boolean;
  typewriter?: boolean;
  toolbar?: boolean;
  statusBar?: boolean;
  fullScreen?: boolean;
  alwaysOnTop?: boolean;
  pairBrackets?: boolean;
  pairMarkdown?: boolean;
  smartPunct?: boolean;
  spellcheck?: boolean;
  emoji?: boolean;
  maximized?: boolean;
  readonly?: boolean;
  eol?: "LF" | "CRLF";
  encoding?: string;
  /** Pandoc is installed. When false, pandoc export items stay enabled so a click can show the install modal. */
  pandoc?: boolean;
  inCode?: boolean;
  onLink?: boolean;
  onImage?: boolean;
  /** Open MD Nest windows. The current one is checked. */
  windows?: { label: string; title: string; current?: boolean }[];
}

export function laterPart(_id: string): 2 | 3 | null {
  return null;
}

function item(id: string, label: string, accel?: string, extra?: Partial<MenuNode>): MenuNode {
  return { id, label, ...(accel ? { accel } : {}), enabled: true, ...extra };
}
function sep(): MenuNode { return { role: "separator" }; }

/** Typora menu tree. Labels match the public inventory; shortcuts are the documented Windows/Linux ones. */
export function menuTemplate(mac: boolean): MenuNode[] {
  const file: MenuNode = {
    id: "menu.file", label: "File", submenu: [
      item("file.new", "New", "CmdOrCtrl+N"),
      item("file.newWindow", "New Window", "CmdOrCtrl+Shift+N"),
      item("file.open", "Open…", "CmdOrCtrl+O"),
      item("file.openFolder", "Open Folder…", "CmdOrCtrl+Shift+O"),
      item("file.quickOpen", "Open Quickly…", "CmdOrCtrl+P"),
      { id: "file.openRecent", label: "Open Recent", submenu: [] },
      item("file.reopenClosed", "Reopen Closed File", "CmdOrCtrl+Shift+T"),
      sep(),
      item("file.save", "Save", "CmdOrCtrl+S"),
      item("file.saveAs", "Save As…", "CmdOrCtrl+Shift+S"),
      item("file.moveTo", "Move To…"),
      item("file.rename", "Rename…"),
      item("file.duplicate", "Duplicate"),
      item("file.reload", "Reload from Disk"),
      { id: "file.lineEndings", label: "Line Endings", submenu: [
        item("file.eol.lf", "LF"),
        item("file.eol.crlf", "CRLF"),
      ] },
      { id: "file.encoding", label: "Encoding", submenu: [
        { id: "file.reopenEncoding", label: "Reopen with Encoding", submenu: [
          item("file.reopen.utf8", "UTF-8"),
          item("file.reopen.gb18030", "GB18030"),
          item("file.reopen.gbk", "GBK"),
          item("file.reopen.big5", "Big5"),
          item("file.reopen.shiftjis", "Shift_JIS"),
          item("file.reopen.euckr", "EUC-KR"),
          item("file.reopen.win1252", "windows-1252"),
          item("file.reopen.utf16le", "UTF-16LE"),
        ] },
        { id: "file.saveEncoding", label: "Save with Encoding", submenu: [
          item("file.saveenc.utf8", "UTF-8"),
          item("file.saveenc.utf8bom", "UTF-8 with BOM"),
          item("file.saveenc.gb18030", "GB18030"),
          item("file.saveenc.gbk", "GBK"),
          item("file.saveenc.big5", "Big5"),
          item("file.saveenc.shiftjis", "Shift_JIS"),
          item("file.saveenc.utf16le", "UTF-16LE"),
        ] },
      ] },
      item("file.openLocation", "Open File Location"),
      item("file.revealSidebar", "Reveal in Sidebar"),
      sep(),
      { id: "file.export", label: "Export", submenu: [
        item("file.exportPdf", "PDF"),
        item("file.exportHtml", "HTML"),
        item("file.exportHtmlPlain", "HTML (without styles)"),
        item("file.exportDocx", "Word (.docx)"),
        sep(),
        item("file.exportPandoc.docx", "Word (pandoc)"),
        item("file.exportPandoc.odt", "OpenOffice (.odt)"),
        item("file.exportPandoc.rtf", "RTF"),
        item("file.exportPandoc.epub", "EPUB"),
        item("file.exportPandoc.latex", "LaTeX"),
        item("file.exportPandoc.mediawiki", "MediaWiki"),
        item("file.exportPandoc.rst", "reStructuredText"),
        item("file.exportPandoc.textile", "Textile"),
        item("file.exportPandoc.opml", "OPML"),
        item("file.exportPandoc.org", "Org mode"),
        item("file.exportPandoc.custom", "Custom pandoc format…"),
      ] },
      item("file.print", "Print…", "CmdOrCtrl+Alt+P"),
      sep(),
      item("file.preferences", "Preferences…", "CmdOrCtrl+,"),
      item("file.close", "Close", "CmdOrCtrl+W"),
      ...(mac ? [] : [item("file.quit", "Quit", "CmdOrCtrl+Q")]),
    ],
  };
  const edit: MenuNode = {
    id: "menu.edit", label: "Edit", submenu: [
      // undo/redo are real commands (focus-aware). Predefined items exist only on Windows/macOS
      // and would not emit our id, so every platform uses a normal item.
      item("edit.undo", "Undo", "CmdOrCtrl+Z"),
      item("edit.redo", "Redo", mac ? "Cmd+Shift+Z" : "CmdOrCtrl+Y"),
      sep(),
      { role: "cut", label: "Cut" },
      { role: "copy", label: "Copy" },
      { role: "paste", label: "Paste" },
      item("edit.copyMarkdown", "Copy as Markdown", "CmdOrCtrl+Shift+C"),
      item("edit.copyHtml", "Copy as HTML Code"),
      item("edit.copyPlain", "Copy as Plain Text"),
      item("edit.pastePlain", "Paste as Plain Text", "CmdOrCtrl+Shift+V"),
      item("edit.delete", "Delete"),
      sep(),
      { role: "select_all", label: "Select All", id: "edit.selectAll" },
      item("edit.selectLine", "Select Line/Sentence", "CmdOrCtrl+L"),
      item("edit.selectScope", "Select Styled Scope", "CmdOrCtrl+E"),
      item("edit.selectWord", "Select Word", "CmdOrCtrl+D"),
      item("edit.jumpTop", "Jump to Top", "CmdOrCtrl+Home"),
      item("edit.jumpBottom", "Jump to Bottom", "CmdOrCtrl+End"),
      sep(),
      item("edit.find", "Find…", "CmdOrCtrl+F"),
      item("edit.findNext", "Find Next", "F3"),
      item("edit.findPrevious", "Find Previous", "Shift+F3"),
      item("edit.replace", "Replace…", "CmdOrCtrl+H"),
      sep(),
      { id: "edit.codeTools", label: "Code Tools", submenu: [
        item("edit.copyCode", "Copy Code Content"),
      ] },
      sep(),
      { id: "edit.autoPair", label: "Auto Pair", submenu: [
        item("edit.autoPair.brackets", "Brackets and Quotes"),
        item("edit.autoPair.markdown", "Markdown Syntax"),
      ] },
      item("edit.smartPunct", "Smart Punctuation"),
      item("edit.spellcheck", "Spell Check"),
      item("edit.emoji", "Emoji & Symbols"),
      item("edit.emojiToggle", "Emoji Autocomplete"),
    ],
  };
  const paragraph: MenuNode = {
    id: "menu.paragraph", label: "Paragraph", submenu: [
      item("paragraph.heading.1", "Heading 1", "CmdOrCtrl+1"),
      item("paragraph.heading.2", "Heading 2", "CmdOrCtrl+2"),
      item("paragraph.heading.3", "Heading 3", "CmdOrCtrl+3"),
      item("paragraph.heading.4", "Heading 4", "CmdOrCtrl+4"),
      item("paragraph.heading.5", "Heading 5", "CmdOrCtrl+5"),
      item("paragraph.heading.6", "Heading 6", "CmdOrCtrl+6"),
      item("paragraph.paragraph", "Paragraph", "CmdOrCtrl+0"),
      item("paragraph.increaseHeading", "Increase Heading Level", "CmdOrCtrl+="),
      item("paragraph.decreaseHeading", "Decrease Heading Level", "CmdOrCtrl+-"),
      sep(),
      item("paragraph.tableDialog", "Table…", "CmdOrCtrl+T"),
      { id: "paragraph.table", label: "Table", submenu: [
        item("paragraph.table.addRowAbove", "Add Row Above"),
        item("paragraph.table.addRowBelow", "Add Row Below"),
        item("paragraph.table.addColBefore", "Add Column Before"),
        item("paragraph.table.addColAfter", "Add Column After"),
        item("paragraph.table.deleteRow", "Delete Row"),
        item("paragraph.table.deleteColumn", "Delete Column"),
        item("paragraph.table.moveRowUp", "Move Row Up"),
        item("paragraph.table.moveRowDown", "Move Row Down"),
        item("paragraph.table.moveColLeft", "Move Column Left"),
        item("paragraph.table.moveColRight", "Move Column Right"),
        item("paragraph.table.alignLeft", "Align Left"),
        item("paragraph.table.alignCenter", "Align Center"),
        item("paragraph.table.alignRight", "Align Right"),
        item("paragraph.table.copy", "Copy Table"),
        item("paragraph.table.deleteTable", "Delete Table"),
      ] },
      item("paragraph.codeFence", "Code Fences", "CmdOrCtrl+Shift+K"),
      item("paragraph.mathBlock", "Math Block", "CmdOrCtrl+Shift+M"),
      item("paragraph.quote", "Quote", "CmdOrCtrl+Shift+Q"),
      item("paragraph.orderedList", "Ordered List", "CmdOrCtrl+Shift+["),
      item("paragraph.unorderedList", "Unordered List", "CmdOrCtrl+Shift+]"),
      item("paragraph.taskList", "Task List", "CmdOrCtrl+Shift+X"),
      { id: "paragraph.taskStatus", label: "Task Status", submenu: [
        item("paragraph.taskStatus.toggle", "Toggle Task Status", "CmdOrCtrl+Alt+X"),
        item("paragraph.taskStatus.complete", "Mark as Complete"),
        item("paragraph.taskStatus.incomplete", "Mark as Incomplete"),
      ] },
      item("paragraph.htmlBlock", "HTML Block"),
      item("paragraph.indent", "Indent", "CmdOrCtrl+]"),
      item("paragraph.outdent", "Outdent", "CmdOrCtrl+["),
      sep(),
      item("paragraph.insertBefore", "Insert Paragraph Before"),
      item("paragraph.insertAfter", "Insert Paragraph After"),
      item("paragraph.linkRef", "Link Reference"),
      item("paragraph.footnote", "Footnote"),
      item("paragraph.hr", "Horizontal Line"),
      item("paragraph.toc", "Table of Contents"),
      item("paragraph.frontMatter", "YAML Front Matter"),
      { id: "paragraph.alert", label: "Alert", submenu: [
        item("paragraph.alert.note", "Note"),
        item("paragraph.alert.tip", "Tip"),
        item("paragraph.alert.important", "Important"),
        item("paragraph.alert.warning", "Warning"),
        item("paragraph.alert.caution", "Caution"),
      ] },
      item("paragraph.mermaid", "Mermaid Diagram"),
      item("paragraph.deleteBlock", "Delete Block"),
    ],
  };
  const format: MenuNode = {
    id: "menu.format", label: "Format", submenu: [
      item("format.strong", "Strong", "CmdOrCtrl+B"),
      item("format.emphasis", "Emphasis", "CmdOrCtrl+I"),
      item("format.underline", "Underline", "CmdOrCtrl+U"),
      item("format.code", "Code", "CmdOrCtrl+Shift+`"),
      item("format.strike", "Strike", "Alt+Shift+5"),
      item("format.highlight", "Highlight"),
      item("format.inlineMath", "Inline Math"),
      item("format.superscript", "Superscript"),
      item("format.subscript", "Subscript"),
      item("format.comment", "Comment"),
      item("format.link", "Hyperlink", "CmdOrCtrl+K"),
      { id: "format.imageMenu", label: "Image", submenu: [
        item("format.image", "Insert Local Image…", "CmdOrCtrl+Shift+I"),
        item("format.image.zoom50", "Zoom 50%"),
        item("format.image.zoom100", "Zoom 100%"),
        item("format.image.zoom200", "Zoom 200%"),
        item("format.image.alignLeft", "Align Left"),
        item("format.image.alignCenter", "Align Center"),
        item("format.image.alignRight", "Align Right"),
        item("format.image.alignDefault", "Default"),
      ] },
      { id: "format.linkActions", label: "Hyperlink Actions", submenu: [
        item("format.link.open", "Open Link"),
        item("format.link.copy", "Copy Link Address"),
      ] },
      item("format.clear", "Clear Format", "CmdOrCtrl+\\"),
    ],
  };
  const view: MenuNode = {
    id: "menu.view", label: "View", submenu: [
      item("view.source", "Source Code Mode", "CmdOrCtrl+/"),
      item("view.focus", "Focus Mode", "F8"),
      item("view.typewriter", "Typewriter Mode", "F9"),
      sep(),
      item("view.sidebar", "Toggle Sidebar", "CmdOrCtrl+Shift+L"),
      { id: "view.outlineMenu", label: "Outline", submenu: [
        item("view.outline", "Show Outline", "CmdOrCtrl+Shift+1"),
        item("view.outline.expandAll", "Expand All"),
        item("view.outline.collapseAll", "Collapse All"),
      ] },
      item("view.articles", "Articles", "CmdOrCtrl+Shift+2"),
      item("view.fileTree", "File Tree", "CmdOrCtrl+Shift+3"),
      item("view.searchFolder", "Search in Folder", "CmdOrCtrl+Shift+F"),
      sep(),
      item("view.toolbar", "Formatting Toolbar"),
      item("view.statusBar", "Status Bar"),
      item("view.wordCount", "Word Count"),
      item("view.readonly", "Readonly Mode"),
      sep(),
      item("view.fullScreen", "Full Screen", "F11"),
      // Alias kept so older tests and the command palette still find it. The Window menu owns the item.
      item("view.alwaysOnTop", "Always on Top"),
      item("view.actualSize", "Actual Size", "CmdOrCtrl+Shift+0"),
      item("view.zoomIn", "Zoom In", "CmdOrCtrl+Shift+="),
      item("view.zoomOut", "Zoom Out", "CmdOrCtrl+Shift+-"),
      sep(),
      item("view.palette", "Command Palette", "CmdOrCtrl+Shift+P"),
    ],
  };
  const windowMenu: MenuNode = {
    id: "menu.window", label: "Window", submenu: [
      item("window.minimize", "Minimize", "CmdOrCtrl+M"),
      item("window.maximize", mac ? "Zoom" : "Maximize"),
      item("window.alwaysOnTop", "Always on Top"),
      item("window.fullScreen", "Full Screen", "F11"),
      sep(),
    ],
  };
  const themes: MenuNode = { id: "menu.themes", label: "Themes", submenu: [
    item("themes.openFolder", "Open Theme Folder"),
  ] };
  const help: MenuNode = { id: "menu.help", label: "Help", submenu: [
    item("help.markdown", "Markdown Reference"),
    item("help.shortcuts", "Keyboard Shortcuts"),
    item("help.about", "About MD Nest"),
    item("help.dataFolder", "Open Data Folder"),
  ] };
  return [file, edit, paragraph, format, view, windowMenu, themes, help];
}

const TABLE_IDS = new Set([
  "paragraph.table.addRowAbove", "paragraph.table.addRowBelow",
  "paragraph.table.addColBefore", "paragraph.table.addColAfter",
  "paragraph.table.deleteRow", "paragraph.table.deleteColumn",
  "paragraph.table.moveRowUp", "paragraph.table.moveRowDown",
  "paragraph.table.moveColLeft", "paragraph.table.moveColRight",
  "paragraph.table.alignLeft", "paragraph.table.alignCenter", "paragraph.table.alignRight",
  "paragraph.table.copy", "paragraph.table.deleteTable",
]);
const PATH_IDS = new Set(["file.openLocation", "file.revealSidebar", "file.moveTo", "file.rename", "file.duplicate", "file.reload"]);
/** Commands that change the document. Disabled while Readonly Mode is on. */
const EDITING_IDS = new Set([
  "edit.undo", "edit.redo", "edit.pastePlain", "edit.delete",
  "paragraph.heading.1", "paragraph.heading.2", "paragraph.heading.3", "paragraph.heading.4",
  "paragraph.heading.5", "paragraph.heading.6", "paragraph.paragraph",
  "paragraph.increaseHeading", "paragraph.decreaseHeading",
  "paragraph.tableDialog", "paragraph.codeFence", "paragraph.mathBlock", "paragraph.quote",
  "paragraph.orderedList", "paragraph.unorderedList", "paragraph.taskList",
  "paragraph.taskStatus.toggle", "paragraph.taskStatus.complete", "paragraph.taskStatus.incomplete",
  "paragraph.htmlBlock", "paragraph.indent", "paragraph.outdent",
  ...TABLE_IDS,
  "paragraph.insertBefore", "paragraph.insertAfter", "paragraph.linkRef", "paragraph.footnote",
  "paragraph.hr", "paragraph.toc", "paragraph.frontMatter", "paragraph.mermaid", "paragraph.deleteBlock",
  "paragraph.alert.note", "paragraph.alert.tip", "paragraph.alert.important", "paragraph.alert.warning", "paragraph.alert.caution",
  "format.strong", "format.emphasis", "format.underline", "format.code", "format.strike", "format.highlight",
  "format.inlineMath", "format.superscript", "format.subscript", "format.comment", "format.link",
  "format.image", "format.clear",
]);

function fileName(p: string): string {
  return p.split(/[\\/]/).pop() || p;
}

function applyState(node: MenuNode, state: MenuState, commands: Command[], occupied: Set<string>, mac = MAC): MenuNode {
  if (node.role === "separator") return { role: "separator" };
  if (node.id === "menu.window") {
    const kids = (node.submenu ?? [])
      .filter((c) => c.id !== "window.bringAllToFront")
      .map((c) => applyState(c, state, commands, occupied, mac));
    const wins = (state.windows ?? []).map((w) => item("window.focus." + w.label, w.title || w.label, undefined, { checked: !!w.current }));
    const front = mac ? [item("window.bringAllToFront", "Bring All to Front"), sep()] : [];
    return { ...node, submenu: [...kids, ...front, ...wins] };
  }
  if (node.submenu && !node.id?.startsWith("file.openRecent") && node.id !== "menu.themes") {
    return { ...node, submenu: node.submenu.map((c) => applyState(c, state, commands, occupied, mac)) };
  }
  if (node.id === "file.openRecent") {
    const files = state.recent.slice(0, 12).map((p, i) => item("file.recent." + i, fileName(p)));
    return {
      ...node,
      submenu: [
        ...(files.length ? files : [{ id: "file.recent.empty", label: "No Recent Files", enabled: false }]),
        sep(),
        item("file.clearRecent", "Clear Items", undefined, { enabled: state.recent.length > 0 }),
      ],
    };
  }
  if (node.id === "menu.themes") {
    const radios = state.themes.map((t) => item("theme." + t, displayTheme(t), undefined, { checked: t === state.currentTheme }));
    return { ...node, submenu: [...radios, sep(), item("themes.openFolder", "Open Theme Folder")] };
  }
  const cmd = node.id ? commands.find((c) => c.id === node.id) : undefined;
  let enabled = node.enabled !== false;
  if (cmd) enabled = commandEnabled(cmd);
  if (node.id && TABLE_IDS.has(node.id)) enabled = enabled && state.inTable;
  if (node.id && PATH_IDS.has(node.id)) enabled = enabled && state.hasPath;
  if (node.id === "edit.copyCode") enabled = enabled && !!state.inCode;
  if (node.id === "format.link.open" || node.id === "format.link.copy") enabled = enabled && !!state.onLink;
  if (node.id && node.id.startsWith("format.image.align")) enabled = enabled && !!state.onImage;
  if (node.id && node.id.startsWith("format.image.zoom")) enabled = enabled && !!state.onImage;
  if (state.readonly && EDITING_IDS.has(node.id || "")) enabled = false;
  if (node.id === "view.source") return { ...node, enabled, checked: state.sourceMode, accel: accelFor(node, occupied) };
  if (node.id === "view.sidebar") return { ...node, enabled, checked: state.sidebar, accel: accelFor(node, occupied) };
  if (node.id === "view.outline") return { ...node, enabled, checked: state.outline, accel: accelFor(node, occupied) };
  if (node.id === "view.focus") return { ...node, enabled, checked: !!state.focusMode, accel: accelFor(node, occupied) };
  if (node.id === "view.typewriter") return { ...node, enabled, checked: !!state.typewriter, accel: accelFor(node, occupied) };
  if (node.id === "view.toolbar") return { ...node, enabled, checked: !!state.toolbar, accel: accelFor(node, occupied) };
  if (node.id === "view.statusBar") return { ...node, enabled, checked: state.statusBar !== false, accel: accelFor(node, occupied) };
  if (node.id === "view.fullScreen") return { ...node, enabled, checked: !!state.fullScreen, accel: accelFor(node, occupied) };
  if (node.id === "view.alwaysOnTop" || node.id === "window.alwaysOnTop") return { ...node, enabled, checked: !!state.alwaysOnTop, accel: accelFor(node, occupied) };
  if (node.id === "window.maximize") {
    const label = mac ? "Zoom" : (state.maximized ? "Restore" : "Maximize");
    return { ...node, label, enabled, checked: !!state.maximized, accel: accelFor(node, occupied) };
  }
  if (node.id === "edit.autoPair.brackets") return { ...node, enabled, checked: state.pairBrackets !== false };
  if (node.id === "edit.autoPair.markdown") return { ...node, enabled, checked: !!state.pairMarkdown };
  if (node.id === "edit.smartPunct") return { ...node, enabled, checked: !!state.smartPunct };
  if (node.id === "edit.spellcheck") return { ...node, enabled, checked: !!state.spellcheck };
  if (node.id === "edit.emojiToggle") return { ...node, enabled, checked: state.emoji !== false };
  if (node.id === "view.readonly") return { ...node, enabled, checked: !!state.readonly };
  if (node.id === "file.eol.lf") return { ...node, enabled, checked: state.eol !== "CRLF" };
  if (node.id === "file.eol.crlf") return { ...node, enabled, checked: state.eol === "CRLF" };
  if (node.id === "file.saveenc.utf8") return { ...node, enabled, checked: state.encoding === "UTF-8" };
  if (node.id === "file.saveenc.utf8bom") return { ...node, enabled, checked: state.encoding === "UTF-8-BOM" };
  if (node.id === "file.saveenc.gb18030") return { ...node, enabled, checked: state.encoding === "GB18030" };
  if (node.id === "file.saveenc.gbk") return { ...node, enabled, checked: state.encoding === "GBK" };
  if (node.id === "file.saveenc.big5") return { ...node, enabled, checked: state.encoding === "Big5" };
  if (node.id === "file.saveenc.shiftjis") return { ...node, enabled, checked: state.encoding === "Shift_JIS" };
  if (node.id === "file.saveenc.utf16le") return { ...node, enabled, checked: state.encoding === "UTF-16LE" };
  let accel = node.accel;
  if (node.id && occupied.has(normalizeKey(node.accel))) accel = undefined;
  else accel = accelFor(node, occupied);
  return { ...stripEmpty(node), enabled, ...(accel ? { accel } : {}), ...(node.checked != null ? { checked: node.checked } : {}) };
}

function stripEmpty(node: MenuNode): MenuNode {
  const copy = { ...node };
  if (!copy.accel) delete copy.accel;
  return copy;
}

function normalizeKey(accel: string | undefined): string {
  return parseAccelerator(accel)?.canonical.toLowerCase() ?? "";
}

function accelFor(node: MenuNode, occupied: Set<string>): string | undefined {
  if (!node.accel) return undefined;
  if (occupied.has(normalizeKey(node.accel))) return undefined;
  return node.accel;
}

export const MAC = typeof navigator !== "undefined" && /Mac|iPhone|iPad|iPod/.test(navigator.platform + navigator.userAgent);

export function displayTheme(stem: string): string {
  return stem.split(/[-_ ]/).map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join(" ");
}

/**
 * Keys claimed by an enabled plugin command. A core item drops its accelerator when a plugin
 * owns the same key. Hyperlink always keeps CmdOrCtrl+K; AI Rewrite defaults to CmdOrCtrl+J.
 */
export function occupiedAccels(commands: Command[], coreIds: Set<string>): Set<string> {
  const set = new Set<string>();
  for (const c of commands) {
    if (!c.key || coreIds.has(c.id) || !commandEnabled(c)) continue;
    const a = parseAccelerator(c.key.includes("+") ? c.key : prosemirrorToAccel(c.key));
    if (a) set.add(a.canonical.toLowerCase());
  }
  return set;
}

/** "Mod-k" / "Shift-Mod-`" → "CmdOrCtrl+K". */
export function prosemirrorToAccel(name: string): string {
  const parts = name.split(/-(?!$)/);
  const key = parts[parts.length - 1];
  const mods: string[] = [];
  for (const m of parts.slice(0, -1)) {
    if (/^mod$/i.test(m)) mods.push("CmdOrCtrl");
    else if (/^(c|ctrl|control)$/i.test(m)) mods.push("Ctrl");
    else if (/^(cmd|meta|m)$/i.test(m)) mods.push("Cmd");
    else if (/^s(hift)?$/i.test(m)) mods.push("Shift");
    else if (/^a(lt)?$/i.test(m)) mods.push("Alt");
  }
  const shown = key === "Space" ? "Space" : key.length === 1 ? key.toUpperCase() : key;
  return [...mods, shown].join("+");
}

function collectIds(nodes: MenuNode[], into: Set<string>) {
  for (const n of nodes) {
    if (n.id && !n.submenu) into.add(n.id);
    if (n.submenu) collectIds(n.submenu, into);
  }
}

export function coreCommandIds(mac: boolean): Set<string> {
  const ids = new Set<string>();
  collectIds(menuTemplate(mac), ids);
  return ids;
}

/** Spec rebuilt whenever recent files, the theme, or a check state changes. */
export function buildMenuSpec(commands: Command[], state: MenuState, mac = MAC): MenuNode[] {
  const core = coreCommandIds(mac);
  const occupied = state.pluginKeyOwners.size ? state.pluginKeyOwners : occupiedAccels(commands, core);
  return menuTemplate(mac).map((n) => localize(applyState(n, state, commands, occupied, mac)));
}

/** Translate labels for the active UI language (native and HTML menus share the spec). */
export function localize(n: MenuNode): MenuNode {
  const out: MenuNode = { ...n };
  if (out.label && !/^(file\.recent\.\d|theme\.|window\.focus\.)/.test(out.id || "")) out.label = t(out.label);
  if (out.submenu) out.submenu = out.submenu.map(localize);
  return out;
}

function esc(s: string): string {
  return s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]!));
}

/** Human shortcut, with the platform modifier (⌘ on macOS, Ctrl elsewhere). */
export function accelLabel(accel: string | undefined, mac = MAC): string {
  if (!accel) return "";
  const a = parseAccelerator(accel);
  if (!a) return accel;
  const parts: string[] = [];
  if (mac) {
    if (a.ctrl) parts.push("⌃");
    if (a.alt) parts.push("⌥");
    if (a.shift) parts.push("⇧");
    if (a.meta) parts.push("⌘");
    parts.push(a.key.length === 1 ? a.key.toUpperCase() : a.key);
    return parts.join("");
  }
  if (a.ctrl) parts.push("Ctrl");
  if (a.alt) parts.push("Alt");
  if (a.shift) parts.push("Shift");
  if (a.meta) parts.push("Cmd");
  parts.push(a.key.length === 1 ? a.key.toUpperCase() : a.key);
  return parts.join("+");
}

/**
 * HTML menubar `#mdn-menubar` for the browser host (and `?menubar=html`).
 * Dropdowns use `.dropdown-menu`. Clicking an item calls `run(id)`.
 */
export function renderMenuBar(root: HTMLElement, spec: MenuNode[], run: (id: string) => void, mac = MAC): void {
  root.id = "mdn-menubar";
  root.innerHTML = "";
  const closeAll = () => root.querySelectorAll(".mdn-menu-open").forEach((e) => e.classList.remove("mdn-menu-open"));
  for (const top of spec) {
    const wrap = document.createElement("div");
    wrap.className = "mdn-menu";
    wrap.dataset.menu = (top.label || "").toLowerCase();
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "mdn-menu-label";
    btn.textContent = top.label || "";
    btn.setAttribute("aria-haspopup", "true");
    const drop = document.createElement("div");
    drop.className = "dropdown-menu";
    drop.append(...(top.submenu ?? []).map((n) => renderNode(n, run, closeAll, mac)));
    btn.onclick = (e) => {
      e.stopPropagation();
      const open = wrap.classList.contains("mdn-menu-open");
      closeAll();
      if (!open) wrap.classList.add("mdn-menu-open");
    };
    wrap.append(btn, drop);
    root.appendChild(wrap);
  }
  if (!(root as any)._mdnBound) {
    (root as any)._mdnBound = true;
    document.addEventListener("click", (e) => {
      if (!(e.target as Element | null)?.closest?.("#mdn-menubar")) closeAll();
    });
    document.addEventListener("keydown", (e) => { if (e.key === "Escape") closeAll(); });
  }
}

function renderNode(node: MenuNode, run: (id: string) => void, closeAll: () => void, mac: boolean): HTMLElement {
  if (node.role === "separator") {
    const hr = document.createElement("div");
    hr.className = "mdn-menu-sep";
    hr.setAttribute("role", "separator");
    return hr;
  }
  if (node.submenu) {
    const row = document.createElement("div");
    row.className = "mdn-menu-sub";
    const label = document.createElement("span");
    label.textContent = node.label || "";
    const caret = document.createElement("span");
    caret.className = "mdn-menu-caret";
    caret.textContent = "▸";
    row.append(label, caret);
    const sub = document.createElement("div");
    sub.className = "dropdown-menu mdn-submenu";
    sub.append(...node.submenu.map((n) => renderNode(n, run, closeAll, mac)));
    row.appendChild(sub);
    // The parent dropdown scrolls (max-height), which would clip an absolutely
    // positioned flyout; place it with fixed coordinates beside the row instead.
    const place = () => {
      const r = row.getBoundingClientRect();
      sub.style.position = "fixed";
      sub.style.left = `${Math.round(r.right)}px`;
      sub.style.top = `${Math.round(r.top - 4)}px`;
      sub.style.maxHeight = `${Math.max(120, window.innerHeight - r.top - 8)}px`;
      requestAnimationFrame(() => {
        const s = sub.getBoundingClientRect();
        if (s.right > window.innerWidth) sub.style.left = `${Math.max(0, Math.round(r.left - s.width))}px`;
        if (s.bottom > window.innerHeight) sub.style.top = `${Math.max(0, Math.round(window.innerHeight - s.height - 4))}px`;
      });
    };
    row.addEventListener("mouseenter", place);
    row.addEventListener("focusin", place);
    return row;
  }
  const row = document.createElement("button");
  row.type = "button";
  row.className = "mdn-menu-item" + (node.checked ? " checked" : "");
  if (node.id) row.dataset.id = node.id;
  if (node.role && !node.id) row.dataset.role = node.role;
  row.disabled = node.enabled === false;
  const label = document.createElement("span");
  label.className = "mdn-menu-text";
  label.textContent = (node.checked ? "✓ " : "") + (node.label || node.role || "");
  const accel = document.createElement("span");
  accel.className = "mdn-menu-accel";
  const shown = node.role === "cut" ? "CmdOrCtrl+X" : node.role === "copy" ? "CmdOrCtrl+C"
    : node.role === "paste" ? "CmdOrCtrl+V" : node.role === "select_all" ? "CmdOrCtrl+A" : node.accel;
  accel.textContent = accelLabel(shown, mac);
  row.append(label, accel);
  const id = node.id || (node.role === "select_all" ? "edit.selectAll" : "");
  if (id && node.enabled !== false) {
    row.onclick = (e) => {
      e.stopPropagation();
      closeAll();
      run(id);
    };
  } else if (node.role && node.enabled !== false) {
    row.onclick = (e) => {
      e.stopPropagation();
      closeAll();
      const cmd = node.role === "cut" ? "cut" : node.role === "copy" ? "copy" : node.role === "paste" ? "paste" : "";
      if (cmd) { try { document.execCommand(cmd); } catch { /* ignore */ } }
    };
  }
  return row;
}

export function menuBarVisible(hostKind: string): boolean {
  if (typeof location === "undefined") return hostKind === "browser";
  const q = new URLSearchParams(location.search);
  if (q.get("menubar") === "0") return false;
  if (q.get("menubar") === "html") return true;
  return hostKind === "browser";
}
