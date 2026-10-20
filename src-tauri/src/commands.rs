use std::fs;
use std::io::Write;
use std::path::Path;
use std::sync::atomic::{AtomicU32, Ordering};

use serde::Serialize;
use tauri_plugin_dialog::{DialogExt, FilePath};

use crate::themes_dir;

static WINDOW_SEQ: AtomicU32 = AtomicU32::new(1);

#[derive(Serialize)]
pub struct DirEntry {
    pub name: String,
    pub path: String,
    #[serde(rename = "isDir")]
    pub is_dir: bool,
}

fn path_string(file: FilePath) -> Option<String> {
    match file {
        FilePath::Path(p) => Some(p.to_string_lossy().into_owned()),
        FilePath::Url(u) => Some(u.to_string()),
    }
}

/// Native open dialog filtered to Markdown. `None` if the user cancels.
#[tauri::command]
pub async fn pick_file(app: tauri::AppHandle) -> Option<String> {
    app.dialog()
        .file()
        .add_filter("Markdown", &["md", "markdown", "mdown", "mkd"])
        .blocking_pick_file()
        .and_then(path_string)
}

/// Native folder picker. `None` if the user cancels.
#[tauri::command]
pub async fn pick_folder(app: tauri::AppHandle) -> Option<String> {
    app.dialog()
        .file()
        .blocking_pick_folder()
        .and_then(path_string)
}

/// Native save dialog. `default_name` arrives as camelCase `defaultName` from invoke.
#[tauri::command]
pub async fn pick_save_path(
    app: tauri::AppHandle,
    default_name: String,
    ext: Option<String>,
) -> Option<String> {
    let ext_owned = ext.clone().unwrap_or_default();
    let (label, filter_exts): (&str, Vec<&str>) = match ext.as_deref() {
        Some("html") => ("HTML", vec!["html", "htm"]),
        Some("pdf") => ("PDF", vec!["pdf"]),
        Some("docx") => ("Word", vec!["docx"]),
        Some("odt") => ("OpenOffice", vec!["odt"]),
        Some("rtf") => ("RTF", vec!["rtf"]),
        Some("epub") => ("EPUB", vec!["epub"]),
        Some("tex") | Some("latex") => ("LaTeX", vec!["tex"]),
        Some("wiki") | Some("mediawiki") => ("MediaWiki", vec!["wiki"]),
        Some("rst") => ("reStructuredText", vec!["rst"]),
        Some("textile") => ("Textile", vec!["textile"]),
        Some("opml") => ("OPML", vec!["opml"]),
        Some("org") => ("Org", vec!["org"]),
        Some(other)
            if !other.is_empty()
                && other.len() <= 16
                && other.chars().all(|c| c.is_ascii_alphanumeric() || c == '_') =>
        {
            ("Export", vec![ext_owned.as_str()])
        }
        _ => ("Markdown", vec!["md", "markdown"]),
    };
    app.dialog()
        .file()
        .add_filter(label, &filter_exts)
        .set_file_name(&default_name)
        .blocking_save_file()
        .and_then(path_string)
}

#[tauri::command]
pub async fn read_text_file(path: String) -> Result<String, String> {
    fs::read_to_string(&path).map_err(|e| e.to_string())
}

/// Raw file bytes as standard base64. The WebView decodes legacy encodings.
#[tauri::command]
pub async fn read_file_bytes(path: String) -> Result<String, String> {
    use base64::Engine;
    let bytes = fs::read(&path).map_err(|e| e.to_string())?;
    Ok(base64::engine::general_purpose::STANDARD.encode(bytes))
}

/// Atomic write of standard-base64 bytes (sibling temp file, then rename).
#[tauri::command]
pub async fn write_file_bytes(path: String, data: String) -> Result<(), String> {
    use base64::Engine;
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(data.as_bytes())
        .map_err(|e| e.to_string())?;
    write_bytes_atomic(&path, &bytes)
}

fn write_bytes_atomic(path: &str, bytes: &[u8]) -> Result<(), String> {
    let dest = Path::new(path);
    if let Some(parent) = dest.parent() {
        if !parent.as_os_str().is_empty() {
            fs::create_dir_all(parent).map_err(|e| e.to_string())?;
        }
    }
    let mut tmp = path.to_string();
    tmp.push_str(".tmp");
    {
        let mut file = fs::File::create(&tmp).map_err(|e| e.to_string())?;
        file.write_all(bytes).map_err(|e| e.to_string())?;
        file.sync_all().map_err(|e| e.to_string())?;
    }
    fs::rename(&tmp, dest).map_err(|e| {
        let _ = fs::remove_file(&tmp);
        e.to_string()
    })
}

/// Write via a sibling temp file, then rename over the destination.
#[tauri::command]
pub async fn write_text_file(path: String, text: String) -> Result<(), String> {
    let dest = Path::new(&path);
    if let Some(parent) = dest.parent() {
        if !parent.as_os_str().is_empty() {
            fs::create_dir_all(parent).map_err(|e| e.to_string())?;
        }
    }
    let mut tmp = path.clone();
    tmp.push_str(".tmp");
    {
        let mut file = fs::File::create(&tmp).map_err(|e| e.to_string())?;
        file.write_all(text.as_bytes()).map_err(|e| e.to_string())?;
        file.sync_all().map_err(|e| e.to_string())?;
    }
    fs::rename(&tmp, dest).map_err(|e| {
        let _ = fs::remove_file(&tmp);
        e.to_string()
    })
}

/// Non-recursive listing. Skips dotfiles and `node_modules`. Directories first,
/// then case-insensitive name order.
#[tauri::command]
pub async fn list_dir(path: String) -> Result<Vec<DirEntry>, String> {
    let mut entries = Vec::new();
    let read = fs::read_dir(&path).map_err(|e| e.to_string())?;
    for item in read {
        let item = item.map_err(|e| e.to_string())?;
        let name = item.file_name().to_string_lossy().into_owned();
        if name.starts_with('.') || name == "node_modules" {
            continue;
        }
        let file_type = item.file_type().map_err(|e| e.to_string())?;
        let is_dir = file_type.is_dir();
        entries.push(DirEntry {
            name,
            path: item.path().to_string_lossy().into_owned(),
            is_dir,
        });
    }
    entries.sort_by(|a, b| {
        b.is_dir
            .cmp(&a.is_dir)
            .then_with(|| a.name.to_lowercase().cmp(&b.name.to_lowercase()))
    });
    Ok(entries)
}

/// `*.css` in the themes dir, excluding `base.user.css` and any `*.user.css`, sorted.
#[tauri::command]
pub async fn list_themes(app: tauri::AppHandle) -> Result<Vec<String>, String> {
    let dir = themes_dir(&app)?;
    if !dir.is_dir() {
        return Ok(Vec::new());
    }
    let mut names = Vec::new();
    let read = fs::read_dir(&dir).map_err(|e| e.to_string())?;
    for item in read {
        let item = item.map_err(|e| e.to_string())?;
        let name = item.file_name().to_string_lossy().into_owned();
        let lower = name.to_lowercase();
        if !lower.ends_with(".css") {
            continue;
        }
        // *.user.css files are listed too; the frontend applies them as overrides.
        if item.file_type().map(|t| t.is_file()).unwrap_or(false) {
            names.push(name);
        }
    }
    names.sort_by(|a, b| a.to_lowercase().cmp(&b.to_lowercase()));
    Ok(names)
}

/// User's Documents directory if it exists, otherwise the home directory.
#[tauri::command]
pub async fn default_workspace() -> Option<String> {
    if let Some(docs) = dirs::document_dir() {
        if docs.is_dir() {
            return Some(docs.to_string_lossy().into_owned());
        }
    }
    dirs::home_dir().map(|p| p.to_string_lossy().into_owned())
}

/// First non-flag CLI argument, resolved to an absolute path ("open with" / `mdnest file.md`).
#[tauri::command]
pub async fn cli_file() -> Option<String> {
    // skip flags and the values of flags that take one
    const WITH_VALUE: [&str; 4] = ["--theme", "--export-html", "--export-pdf", "--debug-log"];
    let args: Vec<String> = std::env::args().skip(1).collect();
    let mut arg = None;
    let mut i = 0;
    while i < args.len() {
        if WITH_VALUE.contains(&args[i].as_str()) {
            i += 2;
            continue;
        }
        if !args[i].starts_with('-') {
            arg = Some(args[i].clone());
            break;
        }
        i += 1;
    }
    let arg = arg?;
    let p = std::path::PathBuf::from(arg);
    let abs = if p.is_absolute() {
        p
    } else {
        std::env::current_dir().ok()?.join(p)
    };
    abs.is_file().then(|| abs.to_string_lossy().into_owned())
}

/// Write base64 data (pasted/dropped images). With `unique`, picks "name-1.ext", "name-2.ext"…
/// instead of overwriting. Returns the final absolute path.
#[tauri::command]
pub async fn write_binary_file(path: String, data: String, unique: bool) -> Result<String, String> {
    use base64::Engine;
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(data.as_bytes())
        .map_err(|e| e.to_string())?;
    let mut dest = std::path::PathBuf::from(&path);
    if let Some(parent) = dest.parent() {
        fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    if unique && dest.exists() {
        let stem = dest
            .file_stem()
            .map(|s| s.to_string_lossy().into_owned())
            .unwrap_or_default();
        let ext = dest
            .extension()
            .map(|s| format!(".{}", s.to_string_lossy()))
            .unwrap_or_default();
        let parent = dest.parent().map(|p| p.to_path_buf()).unwrap_or_default();
        let mut i = 1;
        loop {
            let cand = parent.join(format!("{stem}-{i}{ext}"));
            if !cand.exists() {
                dest = cand;
                break;
            }
            i += 1;
        }
    }
    fs::write(&dest, bytes).map_err(|e| e.to_string())?;
    Ok(dest.to_string_lossy().into_owned())
}

/// Copy a local file (e.g. an image dropped from a file manager) to `dest`, creating parent folders.
/// With `unique`, an existing destination gets a "-1", "-2", … suffix. Returns the final path.
#[tauri::command]
pub async fn copy_file(src: String, dest: String, unique: bool) -> Result<String, String> {
    let meta = fs::metadata(&src).map_err(|e| format!("{src}: {e}"))?;
    if !meta.is_file() {
        return Err(format!("{src}: not a file"));
    }
    let mut dest = std::path::PathBuf::from(&dest);
    if let Some(parent) = dest.parent() {
        fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    if fs::canonicalize(&src).ok() == fs::canonicalize(&dest).ok() {
        return Ok(dest.to_string_lossy().into_owned());
    }
    if unique && dest.exists() {
        let stem = dest
            .file_stem()
            .map(|s| s.to_string_lossy().into_owned())
            .unwrap_or_default();
        let ext = dest
            .extension()
            .map(|s| format!(".{}", s.to_string_lossy()))
            .unwrap_or_default();
        let parent = dest.parent().map(|p| p.to_path_buf()).unwrap_or_default();
        let mut i = 1;
        loop {
            let cand = parent.join(format!("{stem}-{i}{ext}"));
            if !cand.exists() {
                dest = cand;
                break;
            }
            i += 1;
        }
    }
    fs::copy(&src, &dest).map_err(|e| e.to_string())?;
    Ok(dest.to_string_lossy().into_owned())
}

/// Modification time in ms since the epoch (used by the frontend's file watcher), or None.
#[tauri::command]
pub async fn file_mtime(path: String) -> Option<u64> {
    let m = fs::metadata(&path).ok()?.modified().ok()?;
    Some(m.duration_since(std::time::UNIX_EPOCH).ok()?.as_millis() as u64)
}

#[tauri::command]
pub async fn cli_args() -> Vec<String> {
    std::env::args().skip(1).collect()
}

#[tauri::command]
pub async fn quit_app(app: tauri::AppHandle, code: i32) {
    app.exit(code);
}

/// Render `html` to a PDF at `out`.
/// Linux: loads the HTML into a hidden WebKitGTK webview and prints it to file with
/// webkit_print_operation (no dialog). Other platforms: not implemented here — the frontend
/// falls back to the system print dialog (window.print), see README "PDF export".
#[tauri::command]
pub async fn export_pdf(app: tauri::AppHandle, html: String, out: String) -> Result<(), String> {
    #[cfg(any(target_os = "linux", target_os = "macos", windows))]
    {
        crate::pdf::export_pdf(app, html, out).await
    }
    #[cfg(not(any(target_os = "linux", target_os = "macos", windows)))]
    {
        let _ = (app, html, out);
        Err("unsupported".into())
    }
}

/// Store a secret. The value never comes back across IPC.
#[tauri::command]
pub async fn secret_set(app: tauri::AppHandle, id: String, value: String) -> Result<(), String> {
    let app = app.clone();
    tauri::async_runtime::spawn_blocking(move || crate::secrets::set(Some(&app), &id, &value))
        .await
        .map_err(|e| e.to_string())?
}

/// Whether a secret id is stored. Does not return the value.
#[tauri::command]
pub async fn secret_has(app: tauri::AppHandle, id: String) -> Result<bool, String> {
    let app = app.clone();
    tauri::async_runtime::spawn_blocking(move || crate::secrets::has(Some(&app), &id))
        .await
        .map_err(|e| e.to_string())?
}

/// Remove a stored secret. Missing ids are not an error.
#[tauri::command]
pub async fn secret_delete(app: tauri::AppHandle, id: String) -> Result<(), String> {
    let app = app.clone();
    tauri::async_runtime::spawn_blocking(move || crate::secrets::delete(Some(&app), &id))
        .await
        .map_err(|e| e.to_string())?
}

/// `"keyring"` when the OS store answered, otherwise `"file"`.
#[tauri::command]
pub async fn secret_backend(app: tauri::AppHandle) -> Result<String, String> {
    let app = app.clone();
    tauri::async_runtime::spawn_blocking(move || crate::secrets::backend_name(Some(&app)))
        .await
        .map_err(|e| e.to_string())?
}

/// Start a streaming HTTP request. Events arrive on `on_event`. Cancel with `net_cancel`.
#[tauri::command]
pub async fn net_stream(
    app: tauri::AppHandle,
    id: String,
    req: crate::net::StreamRequest,
    on_event: tauri::ipc::Channel<crate::net::StreamEvent>,
) -> Result<(), String> {
    crate::net::start(app, id, req, on_event)
}

/// Abort an in-flight `net_stream`. Returns whether a stream with that id was running.
#[tauri::command]
pub async fn net_cancel(id: String) -> bool {
    crate::net::cancel(&id)
}

// ---------- workspace index ("library" core service) ----------

#[cfg(feature = "library")]
fn kb_data_dir(app: &tauri::AppHandle) -> Result<std::path::PathBuf, String> {
    use tauri::Manager;
    app.path().app_data_dir().map_err(|e| e.to_string())
}

/// One index request (`{op, root, ...}`, see kb::dispatch). Runs on a blocking worker thread.
#[tauri::command]
pub async fn kb_call(
    app: tauri::AppHandle,
    req: serde_json::Value,
) -> Result<serde_json::Value, String> {
    #[cfg(feature = "library")]
    {
        let dir = kb_data_dir(&app)?;
        tauri::async_runtime::spawn_blocking(move || crate::kb::dispatch(&dir, req))
            .await
            .map_err(|e| e.to_string())?
    }
    #[cfg(not(feature = "library"))]
    {
        let _ = (app, req);
        Err("library support not built".into())
    }
}

/// Watch a folder for any non-hidden path change. Debounced batches arrive on `on_change`.
/// Without the library feature this returns an error and the frontend refreshes on focus.
#[tauri::command]
pub async fn fs_watch(
    id: String,
    root: String,
    on_change: tauri::ipc::Channel<Vec<String>>,
) -> Result<(), String> {
    #[cfg(feature = "library")]
    {
        crate::kb::watch::start_fs(
            &id,
            std::path::Path::new(&root),
            std::time::Duration::from_millis(400),
            move |b| {
                let _ = on_change.send(b);
            },
        )
    }
    #[cfg(not(feature = "library"))]
    {
        let _ = (id, root, on_change);
        Err("library support not built".into())
    }
}

/// Stop a watch started by `fs_watch` or `kb_watch`.
#[tauri::command]
pub async fn fs_unwatch(id: String) -> bool {
    #[cfg(feature = "library")]
    {
        crate::kb::watch::stop(&id)
    }
    #[cfg(not(feature = "library"))]
    {
        let _ = id;
        false
    }
}

/// Watch a workspace folder; debounced batches of changed Markdown paths arrive on `on_change`.
#[tauri::command]
pub async fn kb_watch(
    id: String,
    root: String,
    on_change: tauri::ipc::Channel<Vec<String>>,
) -> Result<(), String> {
    #[cfg(feature = "library")]
    {
        crate::kb::watch::start(
            &id,
            std::path::Path::new(&root),
            std::time::Duration::from_millis(1500),
            move |b| {
                let _ = on_change.send(b);
            },
        )
    }
    #[cfg(not(feature = "library"))]
    {
        let _ = (id, root, on_change);
        Err("library support not built".into())
    }
}

// ---------- file tree (plan section 5) ----------

#[tauri::command]
pub async fn create_file(path: String) -> Result<(), String> {
    let path = path.clone();
    tauri::async_runtime::spawn_blocking(move || crate::files::create_file(Path::new(&path)))
        .await
        .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn create_dir(path: String) -> Result<(), String> {
    let path = path.clone();
    tauri::async_runtime::spawn_blocking(move || crate::files::create_dir(Path::new(&path)))
        .await
        .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn rename_path(from: String, to: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        crate::files::rename_path(Path::new(&from), Path::new(&to))
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn duplicate_path(path: String) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || crate::files::duplicate_path(Path::new(&path)))
        .await
        .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn trash_path(path: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || crate::files::trash_path(Path::new(&path), None))
        .await
        .map_err(|e| e.to_string())?
}

/// Enable or disable the platform spell checker.
/// Linux: WebKitGTK WebContext (enchant/hunspell). Languages come from $LANG, else en_US.
/// Windows and macOS: the WebView's own checker follows the `spellcheck` attribute, so this is a no-op.
#[tauri::command]
pub fn set_spellcheck(window: tauri::WebviewWindow, enabled: bool) -> Result<(), String> {
    crate::set_spellcheck(&window, enabled);
    Ok(())
}

#[derive(Serialize)]
pub struct PandocInfo {
    pub found: bool,
    pub version: String,
    pub path: String,
}

/// Look for pandoc on PATH, plus the usual Windows and macOS install locations.
pub fn find_pandoc() -> Option<std::path::PathBuf> {
    if let Some(p) = which_on_path("pandoc") {
        return Some(p);
    }
    #[cfg(windows)]
    {
        let mut extra = Vec::new();
        if let Ok(local) = std::env::var("LOCALAPPDATA") {
            extra.push(
                std::path::PathBuf::from(local)
                    .join("Pandoc")
                    .join("pandoc.exe"),
            );
        }
        extra.push(std::path::PathBuf::from(
            r"C:\Program Files\Pandoc\pandoc.exe",
        ));
        extra.push(std::path::PathBuf::from(
            r"C:\Program Files (x86)\Pandoc\pandoc.exe",
        ));
        for p in extra {
            if p.is_file() {
                return Some(p);
            }
        }
    }
    #[cfg(target_os = "macos")]
    {
        for p in ["/opt/homebrew/bin/pandoc", "/usr/local/bin/pandoc"] {
            let pb = std::path::PathBuf::from(p);
            if pb.is_file() {
                return Some(pb);
            }
        }
    }
    None
}

fn which_on_path(name: &str) -> Option<std::path::PathBuf> {
    let path = std::env::var_os("PATH")?;
    for dir in std::env::split_paths(&path) {
        let cand = dir.join(name);
        if cand.is_file() {
            return Some(cand);
        }
        #[cfg(windows)]
        {
            let exe = dir.join(format!("{name}.exe"));
            if exe.is_file() {
                return Some(exe);
            }
        }
    }
    None
}

fn pandoc_version_line(bin: &std::path::Path) -> String {
    let mut cmd = std::process::Command::new(bin);
    cmd.arg("--version");
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x08000000;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }
    let Ok(out) = cmd.output() else {
        return String::new();
    };
    let text = String::from_utf8_lossy(&out.stdout);
    text.lines().next().unwrap_or("").trim().to_string()
}

#[tauri::command]
pub async fn pandoc_info() -> PandocInfo {
    tauri::async_runtime::spawn_blocking(|| match find_pandoc() {
        Some(p) => PandocInfo {
            found: true,
            version: pandoc_version_line(&p),
            path: p.to_string_lossy().into_owned(),
        },
        None => PandocInfo {
            found: false,
            version: String::new(),
            path: String::new(),
        },
    })
    .await
    .unwrap_or(PandocInfo {
        found: false,
        version: String::new(),
        path: String::new(),
    })
}

/// Run pandoc with Markdown on stdin. `cwd` is the document folder so relative images resolve.
/// Returns stderr (and a non-zero status) as Err. Times out after 120 seconds.
#[tauri::command]
pub async fn pandoc_export(
    markdown: String,
    to: String,
    out: String,
    cwd: Option<String>,
) -> Result<(), String> {
    let to = to.trim().to_string();
    if to.is_empty()
        || to.len() > 64
        || to
            .chars()
            .any(|c| !(c.is_ascii_alphanumeric() || c == '_' || c == '-' || c == '+'))
    {
        return Err("invalid pandoc writer".into());
    }
    tauri::async_runtime::spawn_blocking(move || {
        let bin = find_pandoc().ok_or_else(|| "pandoc not found".to_string())?;
        let mut cmd = std::process::Command::new(&bin);
        cmd.arg("-f")
            .arg("markdown+tex_math_dollars+tex_math_single_backslash+raw_html+footnotes+pipe_tables+strikeout+task_lists+yaml_metadata_block")
            .arg("-t")
            .arg(&to)
            .arg("-o")
            .arg(&out)
            .stdin(std::process::Stdio::piped())
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::piped());
        if let Some(dir) = cwd.as_ref().filter(|d| !d.is_empty()) {
            cmd.current_dir(dir);
        }
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            const CREATE_NO_WINDOW: u32 = 0x08000000;
            cmd.creation_flags(CREATE_NO_WINDOW);
        }
        let mut child = cmd.spawn().map_err(|e| e.to_string())?;
        if let Some(mut stdin) = child.stdin.take() {
            use std::io::Write;
            stdin.write_all(markdown.as_bytes()).map_err(|e| e.to_string())?;
        }
        let start = std::time::Instant::now();
        loop {
            match child.try_wait() {
                Ok(Some(status)) => {
                    let output = child.wait_with_output().map_err(|e| e.to_string())?;
                    if status.success() {
                        return Ok(());
                    }
                    let err = String::from_utf8_lossy(&output.stderr);
                    let msg = err.trim();
                    return Err(if msg.is_empty() { format!("pandoc exited {}", status) } else { msg.to_string() });
                }
                Ok(None) => {
                    if start.elapsed() > std::time::Duration::from_secs(120) {
                        let _ = child.kill();
                        let _ = child.wait();
                        return Err("pandoc timed out after 120s".into());
                    }
                    std::thread::sleep(std::time::Duration::from_millis(50));
                }
                Err(e) => return Err(e.to_string()),
            }
        }
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn open_external(url: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || crate::files::open_external(&url))
        .await
        .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn reveal_path(path: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || crate::files::reveal_path(Path::new(&path)))
        .await
        .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn list_files(
    root: String,
    max: Option<usize>,
) -> Result<Vec<crate::files::ListedFile>, String> {
    let max = max.unwrap_or(5000);
    tauri::async_runtime::spawn_blocking(move || crate::files::list_files(Path::new(&root), max))
        .await
        .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn file_excerpt(path: String) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || crate::files::file_excerpt(Path::new(&path)))
        .await
        .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn recent_previews(paths: Vec<String>) -> Result<Vec<crate::files::Preview>, String> {
    tauri::async_runtime::spawn_blocking(move || crate::files::recent_previews(&paths))
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn path_kind(path: String) -> String {
    let path = path.clone();
    tauri::async_runtime::spawn_blocking(move || {
        crate::files::path_kind(Path::new(&path)).to_string()
    })
    .await
    .unwrap_or_else(|_| "missing".into())
}

#[tauri::command]
pub async fn search_files(
    root: String,
    query: String,
    max: Option<usize>,
) -> Result<Vec<crate::files::SearchHit>, String> {
    let max = max.unwrap_or(80);
    tauri::async_runtime::spawn_blocking(move || {
        crate::files::search_files(Path::new(&root), &query, max)
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Label of the webview that invoked the command (`main`, `w-1`, …).
#[tauri::command]
pub async fn window_label(window: tauri::WebviewWindow) -> String {
    window.label().to_string()
}

/// Close the calling window. The frontend asks first when the document is dirty.
#[tauri::command]
pub async fn close_window(window: tauri::WebviewWindow) -> Result<(), String> {
    window.destroy().map_err(|e| e.to_string())
}

/// Open another editor window (`w-<n>`). Optional `file` is passed as a query so that window opens it.
#[tauri::command]
pub async fn open_window(app: tauri::AppHandle, file: Option<String>) -> Result<String, String> {
    let n = WINDOW_SEQ.fetch_add(1, Ordering::Relaxed);
    let label = format!("w-{n}");
    let mut url = "index.html".to_string();
    let mut query = vec!["restore=0".to_string()];
    if let Some(f) = file {
        if !f.is_empty() {
            query.push(format!("file={}", urlencoding_min(&f)));
            let dir = Path::new(&f)
                .parent()
                .map(|p| p.to_string_lossy().into_owned())
                .unwrap_or_default();
            if !dir.is_empty() {
                query.push(format!("folder={}", urlencoding_min(&dir)));
            }
        }
    }
    url.push('?');
    url.push_str(&query.join("&"));
    let label2 = label.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let win =
            tauri::WebviewWindowBuilder::new(&app, &label2, tauri::WebviewUrl::App(url.into()))
                .title("MD Nest")
                .inner_size(1200.0, 800.0)
                .resizable(true)
                .build()
                .map_err(|e| e.to_string())?;
        crate::disable_webview_chrome(&win);
        Ok::<(), String>(())
    })
    .await
    .map_err(|e| e.to_string())??;
    Ok(label)
}

fn urlencoding_min(s: &str) -> String {
    let mut out = String::new();
    for b in s.bytes() {
        match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' | b'/' => {
                out.push(b as char)
            }
            b'\\' => out.push('/'),
            _ => out.push_str(&format!("%{b:02X}")),
        }
    }
    out
}

#[tauri::command]
pub async fn kb_unwatch(id: String) -> bool {
    #[cfg(feature = "library")]
    {
        crate::kb::watch::stop(&id)
    }
    #[cfg(not(feature = "library"))]
    {
        let _ = id;
        false
    }
}
