//! File-tree commands shared by the sidebar and the File menu.
//! `unique_copy_name` is pure and unit-tested. Trash uses the platform recycle bin.
use std::fs;
use std::io::Read;
use std::path::Path;
use std::time::{SystemTime, UNIX_EPOCH};

use serde::Serialize;

/// Extensions the file tree, list walk and search treat as documents.
pub const DOC_EXTS: &[&str] = &["md", "markdown", "mdown", "mkd", "mdx", "txt", "text"];

pub fn is_doc_name(name: &str) -> bool {
    let lower = name.to_lowercase();
    DOC_EXTS.iter().any(|e| lower.ends_with(&format!(".{e}")))
}

fn stem_ext(name: &str) -> (String, String) {
    match name.rsplit_once('.') {
        Some((stem, ext)) if !stem.is_empty() && !ext.is_empty() && !ext.contains(' ') => {
            (stem.to_string(), format!(".{ext}"))
        }
        _ => (name.to_string(), String::new()),
    }
}

/// Next free `"name copy.ext"`, then `"name copy 2.ext"`, … `exists` is called with the candidate file name.
pub fn unique_copy_name(name: &str, exists: impl Fn(&str) -> bool) -> String {
    let (stem, ext) = stem_ext(name);
    let first = format!("{stem} copy{ext}");
    if !exists(&first) {
        return first;
    }
    let mut n = 2u32;
    loop {
        let cand = format!("{stem} copy {n}{ext}");
        if !exists(&cand) {
            return cand;
        }
        n += 1;
        if n > 10_000 {
            return format!("{stem} copy {n}{ext}");
        }
    }
}

fn millis(t: SystemTime) -> Option<u64> {
    t.duration_since(UNIX_EPOCH).ok().map(|d| d.as_millis() as u64)
}

fn skip_dir(name: &str) -> bool {
    name.starts_with('.') || name == "node_modules"
}

#[derive(Debug, Serialize, Clone)]
pub struct ListedFile {
    pub path: String,
    pub name: String,
    pub mtime: u64,
    pub ctime: u64,
    pub size: u64,
}

/// Recursive document walk. Skips dot directories and `node_modules`. Capped at `max` (hard cap 5000).
pub fn list_files(root: &Path, max: usize) -> Result<Vec<ListedFile>, String> {
    let cap = max.clamp(1, 5000);
    let mut out = Vec::new();
    walk_docs(root, cap, &mut out)?;
    Ok(out)
}

fn walk_docs(dir: &Path, cap: usize, out: &mut Vec<ListedFile>) -> Result<(), String> {
    if out.len() >= cap {
        return Ok(());
    }
    let read = match fs::read_dir(dir) {
        Ok(r) => r,
        Err(e) => return Err(e.to_string()),
    };
    let mut entries: Vec<_> = read.filter_map(|e| e.ok()).collect();
    entries.sort_by_key(|e| e.file_name().to_string_lossy().to_lowercase());
    for item in entries {
        if out.len() >= cap {
            break;
        }
        let name = item.file_name().to_string_lossy().into_owned();
        if skip_dir(&name) {
            continue;
        }
        let path = item.path();
        let ft = match item.file_type() {
            Ok(t) => t,
            Err(_) => continue,
        };
        if ft.is_dir() {
            let _ = walk_docs(&path, cap, out);
        } else if ft.is_file() && is_doc_name(&name) {
            let meta = match fs::metadata(&path) {
                Ok(m) => m,
                Err(_) => continue,
            };
            out.push(ListedFile {
                path: path.to_string_lossy().into_owned(),
                name,
                mtime: meta.modified().ok().and_then(millis).unwrap_or(0),
                ctime: meta.created().ok().and_then(millis).unwrap_or(0),
                size: meta.len(),
            });
        }
    }
    Ok(())
}

/// First ~240 characters of text, skipping a leading YAML front-matter block.
pub fn excerpt_of(text: &str) -> String {
    let body = strip_front_matter(text);
    let flat: String = body.chars().map(|c| if c == '\n' || c == '\r' || c == '\t' { ' ' } else { c }).collect();
    let trimmed = flat.split_whitespace().collect::<Vec<_>>().join(" ");
    let mut out = String::new();
    for ch in trimmed.chars() {
        if out.chars().count() >= 240 {
            break;
        }
        out.push(ch);
    }
    out
}

pub fn strip_front_matter(text: &str) -> &str {
    let rest = text.strip_prefix("---");
    let Some(rest) = rest else { return text };
    // Front matter only counts when `---` is the first line.
    if !text.starts_with("---\n") && !text.starts_with("---\r\n") && text != "---" {
        return text;
    }
    let after = if text.starts_with("---\r\n") { &text[5..] } else { &text[4..] };
    if let Some(idx) = after.find("\n---") {
        let tail = &after[idx + 4..];
        return tail.trim_start_matches(['\r', '\n']);
    }
    let _ = rest;
    text
}

#[derive(Debug, Serialize, Clone)]
pub struct SearchHit {
    pub path: String,
    pub line: u32,
    pub snippet: String,
}

/// Case-insensitive substring search over documents under `root`. Capped at `max` (hard cap 200).
pub fn search_files(root: &Path, query: &str, max: usize) -> Result<Vec<SearchHit>, String> {
    let q = query.trim().to_lowercase();
    if q.is_empty() {
        return Ok(Vec::new());
    }
    let cap = max.clamp(1, 200);
    let files = list_files(root, 5000)?;
    let mut hits = Vec::new();
    for f in files {
        if hits.len() >= cap {
            break;
        }
        let text = match fs::read_to_string(&f.path) {
            Ok(t) => t,
            Err(_) => continue,
        };
        for (i, line) in text.lines().enumerate() {
            if hits.len() >= cap {
                break;
            }
            if line.to_lowercase().contains(&q) {
                hits.push(SearchHit {
                    path: f.path.clone(),
                    line: (i as u32) + 1,
                    snippet: snippet_around(line, &q),
                });
            }
        }
    }
    Ok(hits)
}

fn snippet_around(line: &str, q_lower: &str) -> String {
    let lower = line.to_lowercase();
    let at = lower.find(q_lower).unwrap_or(0);
    let start = at.saturating_sub(40);
    let end = (at + q_lower.len() + 80).min(line.len());
    // Snap to char boundaries.
    let start = floor_char(line, start);
    let end = ceil_char(line, end);
    let mut s = line[start..end].replace(['\r', '\n'], " ");
    if s.chars().count() > 160 {
        s = s.chars().take(160).collect();
    }
    s
}

fn floor_char(s: &str, i: usize) -> usize {
    if i >= s.len() {
        return s.len();
    }
    let mut n = i;
    while n > 0 && !s.is_char_boundary(n) {
        n -= 1;
    }
    n
}

fn ceil_char(s: &str, i: usize) -> usize {
    if i >= s.len() {
        return s.len();
    }
    let mut n = i;
    while n < s.len() && !s.is_char_boundary(n) {
        n += 1;
    }
    n
}

pub fn path_kind(path: &Path) -> &'static str {
    match fs::metadata(path) {
        Ok(m) if m.is_dir() => "dir",
        Ok(m) if m.is_file() => "file",
        Ok(_) => "other",
        Err(_) => "missing",
    }
}

pub fn create_file(path: &Path) -> Result<(), String> {
    if path.exists() {
        return Err("already exists".into());
    }
    if let Some(parent) = path.parent() {
        if !parent.as_os_str().is_empty() {
            fs::create_dir_all(parent).map_err(|e| e.to_string())?;
        }
    }
    fs::File::create(path).map_err(|e| e.to_string())?;
    Ok(())
}

pub fn create_dir(path: &Path) -> Result<(), String> {
    if path.exists() {
        return Err("already exists".into());
    }
    fs::create_dir_all(path).map_err(|e| e.to_string())
}

pub fn rename_path(from: &Path, to: &Path) -> Result<(), String> {
    if to.exists() {
        return Err("target exists".into());
    }
    if let Some(parent) = to.parent() {
        if !parent.as_os_str().is_empty() {
            fs::create_dir_all(parent).map_err(|e| e.to_string())?;
        }
    }
    fs::rename(from, to).map_err(|e| e.to_string())
}

/// Copy a file or directory to `"name copy.ext"` beside the original. Returns the new path.
pub fn duplicate_path(path: &Path) -> Result<String, String> {
    let parent = path.parent().unwrap_or_else(|| Path::new(""));
    let name = path.file_name().map(|s| s.to_string_lossy().into_owned()).ok_or("no name")?;
    let new_name = unique_copy_name(&name, |n| parent.join(n).exists());
    let dest = parent.join(&new_name);
    copy_recursive(path, &dest)?;
    Ok(dest.to_string_lossy().into_owned())
}

fn copy_recursive(src: &Path, dest: &Path) -> Result<(), String> {
    let meta = fs::metadata(src).map_err(|e| e.to_string())?;
    if meta.is_dir() {
        fs::create_dir(dest).map_err(|e| e.to_string())?;
        for item in fs::read_dir(src).map_err(|e| e.to_string())? {
            let item = item.map_err(|e| e.to_string())?;
            copy_recursive(&item.path(), &dest.join(item.file_name()))?;
        }
        Ok(())
    } else {
        if let Some(parent) = dest.parent() {
            if !parent.as_os_str().is_empty() {
                fs::create_dir_all(parent).map_err(|e| e.to_string())?;
            }
        }
        fs::copy(src, dest).map(|_| ()).map_err(|e| e.to_string())
    }
}

pub fn file_excerpt(path: &Path) -> Result<String, String> {
    let mut file = fs::File::open(path).map_err(|e| e.to_string())?;
    let mut buf = vec![0u8; 8192];
    let n = file.read(&mut buf).map_err(|e| e.to_string())?;
    let text = String::from_utf8_lossy(&buf[..n]);
    Ok(excerpt_of(&text))
}

/// Move `path` to the platform trash. `fallback_dir`, when set, receives a rename (browser host).
pub fn trash_path(path: &Path, fallback_dir: Option<&Path>) -> Result<(), String> {
    if !path.exists() {
        return Err("missing".into());
    }
    if let Some(dir) = fallback_dir {
        fs::create_dir_all(dir).map_err(|e| e.to_string())?;
        let name = path.file_name().map(|s| s.to_string_lossy().into_owned()).unwrap_or_else(|| "item".into());
        let dest_name = unique_copy_name(&name, |n| dir.join(n).exists());
        // unique_copy_name always inserts " copy"; a plain move is fine if the name is free.
        let dest = if !dir.join(&name).exists() { dir.join(&name) } else { dir.join(dest_name) };
        return fs::rename(path, dest).map_err(|e| e.to_string());
    }
    platform_trash(path)
}

#[cfg(target_os = "linux")]
fn platform_trash(path: &Path) -> Result<(), String> {
    use gtk::gio::prelude::FileExt;
    let file = gtk::gio::File::for_path(path);
    file.trash(gtk::gio::Cancellable::NONE).map_err(|e| e.to_string())
}

#[cfg(windows)]
fn platform_trash(path: &Path) -> Result<(), String> {
    use std::os::windows::ffi::OsStrExt;
    use windows::Win32::UI::Shell::{SHFileOperationW, FOF_ALLOWUNDO, FOF_NOCONFIRMATION, FOF_SILENT, FO_DELETE, SHFILEOPSTRUCTW};
    let abs = fs::canonicalize(path).unwrap_or_else(|_| path.to_path_buf());
    // Double-NUL terminated wide path, as SHFileOperation requires.
    let mut wide: Vec<u16> = abs.as_os_str().encode_wide().collect();
    wide.push(0);
    wide.push(0);
    let mut op = SHFILEOPSTRUCTW {
        hwnd: windows::Win32::Foundation::HWND::default(),
        wFunc: FO_DELETE,
        pFrom: windows::core::PCWSTR(wide.as_ptr()),
        pTo: windows::core::PCWSTR::null(),
        fFlags: (FOF_ALLOWUNDO.0 | FOF_NOCONFIRMATION.0 | FOF_SILENT.0) as u16,
        fAnyOperationsAborted: windows::core::BOOL(0),
        hNameMappings: std::ptr::null_mut(),
        lpszProgressTitle: windows::core::PCWSTR::null(),
    };
    let code = unsafe { SHFileOperationW(&mut op) };
    if code != 0 {
        return Err(format!("SHFileOperationW {code}"));
    }
    Ok(())
}

#[cfg(target_os = "macos")]
fn platform_trash(path: &Path) -> Result<(), String> {
    use objc2_foundation::{NSFileManager, NSString, NSURL};
    let s = path.to_string_lossy();
    unsafe {
        let url = NSURL::fileURLWithPath(&NSString::from_str(&s));
        let fm = NSFileManager::defaultManager();
        fm.trashItemAtURL_resultingItemURL_error(&url, None).map_err(|e| e.to_string())
    }
}

#[cfg(not(any(target_os = "linux", windows, target_os = "macos")))]
fn platform_trash(path: &Path) -> Result<(), String> {
    let _ = path;
    Err("trash unsupported".into())
}

/// Open a URL or a local file in the system handler. Spawned and not waited on.
/// Allows http(s), mailto, and local files only.
pub fn open_external(url: &str) -> Result<(), String> {
    let url = url.trim();
    if url.is_empty() || url.len() > 8192 {
        return Err("empty or oversized url".into());
    }
    let lower = url.to_ascii_lowercase();
    let file = if lower.starts_with("file://") {
        Some(file_url_path(url)?)
    } else if !lower.contains("://") && !lower.starts_with("mailto:") {
        Some(std::path::PathBuf::from(url))
    } else {
        None
    };
    if let Some(path) = file {
        return spawn_open_path(&path);
    }
    if lower.starts_with("http://") || lower.starts_with("https://") || lower.starts_with("mailto:") {
        if url.chars().any(|c| c.is_control() || c == '"' || c == '\'') {
            return Err("url contains a disallowed character".into());
        }
        return spawn_open_url(url);
    }
    Err("only http(s), mailto, and local files can be opened".into())
}

fn file_url_path(url: &str) -> Result<std::path::PathBuf, String> {
    let rest = url.split_once("://").map(|(_, r)| r).unwrap_or(url);
    let path = rest.split(['?', '#']).next().unwrap_or(rest);
    let decoded = percent_encoding::percent_decode_str(path).decode_utf8_lossy();
    #[cfg(windows)]
    {
        let s = decoded.trim_start_matches('/');
        if s.len() >= 3 && s.as_bytes()[1] == b':' {
            return Ok(std::path::PathBuf::from(s.replace('/', "\\")));
        }
        return Ok(std::path::PathBuf::from(decoded.as_ref()));
    }
    #[cfg(not(windows))]
    {
        Ok(std::path::PathBuf::from(decoded.as_ref()))
    }
}

fn spawn_open_path(path: &std::path::Path) -> Result<(), String> {
    #[cfg(windows)]
    {
        return spawn_shell_execute(&path.to_string_lossy());
    }
    #[cfg(target_os = "macos")]
    {
        std::process::Command::new("open").arg(path).spawn().map_err(|e| e.to_string())?;
        return Ok(());
    }
    #[cfg(target_os = "linux")]
    {
        std::process::Command::new("xdg-open").arg(path).spawn().map_err(|e| e.to_string())?;
        return Ok(());
    }
    #[cfg(not(any(windows, target_os = "macos", target_os = "linux")))]
    {
        let _ = path;
        Err("open unsupported".into())
    }
}

fn spawn_open_url(url: &str) -> Result<(), String> {
    #[cfg(windows)]
    {
        return spawn_shell_execute(url);
    }
    #[cfg(target_os = "macos")]
    {
        std::process::Command::new("open").arg(url).spawn().map_err(|e| e.to_string())?;
        return Ok(());
    }
    #[cfg(target_os = "linux")]
    {
        std::process::Command::new("xdg-open").arg(url).spawn().map_err(|e| e.to_string())?;
        return Ok(());
    }
    #[cfg(not(any(windows, target_os = "macos", target_os = "linux")))]
    {
        let _ = url;
        Err("open unsupported".into())
    }
}

#[cfg(windows)]
fn spawn_shell_execute(target: &str) -> Result<(), String> {
    use std::os::windows::ffi::OsStrExt;
    use windows::core::PCWSTR;
    use windows::Win32::UI::Shell::ShellExecuteW;
    use windows::Win32::UI::WindowsAndMessaging::SW_SHOWNORMAL;
    let wide: Vec<u16> = std::ffi::OsStr::new(target).encode_wide().chain(std::iter::once(0)).collect();
    let op: Vec<u16> = std::ffi::OsStr::new("open").encode_wide().chain(std::iter::once(0)).collect();
    let rc = unsafe { ShellExecuteW(None, PCWSTR(op.as_ptr()), PCWSTR(wide.as_ptr()), None, None, SW_SHOWNORMAL) };
    if (rc.0 as isize) <= 32 {
        return Err(format!("ShellExecuteW failed ({})", rc.0 as isize));
    }
    Ok(())
}

/// Reveal in the file manager. Linux tries FileManager1.ShowItems, then `xdg-open` of the parent.
pub fn reveal_path(path: &Path) -> Result<(), String> {
    let target = if path.exists() { path.to_path_buf() } else { path.to_path_buf() };
    #[cfg(windows)]
    {
        let arg = format!("/select,{}", target.display());
        std::process::Command::new("explorer").arg(arg).spawn().map_err(|e| e.to_string())?;
        return Ok(());
    }
    #[cfg(target_os = "macos")]
    {
        std::process::Command::new("open").arg("-R").arg(&target).spawn().map_err(|e| e.to_string())?;
        return Ok(());
    }
    #[cfg(target_os = "linux")]
    {
        if show_items_dbus(&target).is_ok() {
            return Ok(());
        }
        let parent = target.parent().unwrap_or(Path::new("."));
        std::process::Command::new("xdg-open").arg(parent).spawn().map_err(|e| e.to_string())?;
        return Ok(());
    }
    #[cfg(not(any(windows, target_os = "macos", target_os = "linux")))]
    {
        let _ = target;
        Err("reveal unsupported".into())
    }
}

#[cfg(target_os = "linux")]
fn show_items_dbus(path: &Path) -> Result<(), String> {
    use gtk::gio::prelude::{DBusProxyExt, FileExt};
    use gtk::gio::{BusType, Cancellable, DBusProxy, DBusProxyFlags};
    let abs = fs::canonicalize(path).unwrap_or_else(|_| path.to_path_buf());
    let uri = gtk::gio::File::for_path(&abs).uri().to_string();
    let proxy = DBusProxy::for_bus_sync(
        BusType::Session,
        DBusProxyFlags::NONE,
        None,
        "org.freedesktop.FileManager1",
        "/org/freedesktop/FileManager1",
        "org.freedesktop.FileManager1",
        Cancellable::NONE,
    )
    .map_err(|e| e.to_string())?;
    let uris = gtk::glib::Variant::from(vec![uri.as_str()]);
    let startup = gtk::glib::Variant::from("");
    let params = gtk::glib::Variant::tuple_from_iter([uris, startup].into_iter());
    proxy
        .call_sync("ShowItems", Some(&params), gtk::gio::DBusCallFlags::NONE, 1500, Cancellable::NONE)
        .map(|_| ())
        .map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn unique_copy_first_is_copy() {
        assert_eq!(unique_copy_name("note.md", |_| false), "note copy.md");
        assert_eq!(unique_copy_name("README", |_| false), "README copy");
    }

    #[test]
    fn unique_copy_increments() {
        let taken = |n: &str| n == "note copy.md" || n == "note copy 2.md";
        assert_eq!(unique_copy_name("note.md", taken), "note copy 3.md");
    }

    #[test]
    fn unique_copy_keeps_multi_dot() {
        assert_eq!(unique_copy_name("a.b.md", |_| false), "a.b copy.md");
    }

    #[test]
    fn excerpt_skips_front_matter() {
        let t = "---\ntitle: Hi\n---\n\nHello world from the body.\n";
        assert_eq!(excerpt_of(t), "Hello world from the body.");
        assert_eq!(excerpt_of("# Title\n\nBody text."), "# Title Body text.");
    }

    #[test]
    fn excerpt_caps_at_240_chars() {
        let long = "word ".repeat(80);
        assert!(excerpt_of(&long).chars().count() <= 240);
    }

    #[test]
    fn doc_extensions() {
        assert!(is_doc_name("a.MD"));
        assert!(is_doc_name("a.mdx"));
        assert!(is_doc_name("a.text"));
        assert!(!is_doc_name("a.png"));
        assert!(!is_doc_name("notes"));
    }

    #[test]
    fn snippet_is_bounded() {
        let line = format!("{}NEEDLE{}", "a".repeat(100), "b".repeat(200));
        let s = snippet_around(&line, "needle");
        assert!(s.to_lowercase().contains("needle"));
        assert!(s.chars().count() <= 160);
    }
}
