use std::fs;
use std::io::Write;
use std::path::Path;

use serde::Serialize;
use tauri_plugin_dialog::{DialogExt, FilePath};

use crate::themes_dir;

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
pub async fn pick_save_path(app: tauri::AppHandle, default_name: String, ext: Option<String>) -> Option<String> {
    let (label, exts): (&str, Vec<&str>) = match ext.as_deref() {
        Some("html") => ("HTML", vec!["html", "htm"]),
        Some("pdf") => ("PDF", vec!["pdf"]),
        _ => ("Markdown", vec!["md", "markdown"]),
    };
    app.dialog()
        .file()
        .add_filter(label, &exts)
        .set_file_name(&default_name)
        .blocking_save_file()
        .and_then(path_string)
}

#[tauri::command]
pub async fn read_text_file(path: String) -> Result<String, String> {
    fs::read_to_string(&path).map_err(|e| e.to_string())
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
    let mut arg = None; let mut i = 0;
    while i < args.len() {
        if WITH_VALUE.contains(&args[i].as_str()) { i += 2; continue; }
        if !args[i].starts_with('-') { arg = Some(args[i].clone()); break; }
        i += 1;
    }
    let arg = arg?;
    let p = std::path::PathBuf::from(arg);
    let abs = if p.is_absolute() { p } else { std::env::current_dir().ok()?.join(p) };
    abs.is_file().then(|| abs.to_string_lossy().into_owned())
}


/// Write base64 data (pasted/dropped images). With `unique`, picks "name-1.ext", "name-2.ext"…
/// instead of overwriting. Returns the final absolute path.
#[tauri::command]
pub async fn write_binary_file(path: String, data: String, unique: bool) -> Result<String, String> {
    use base64::Engine;
    let bytes = base64::engine::general_purpose::STANDARD.decode(data.as_bytes()).map_err(|e| e.to_string())?;
    let mut dest = std::path::PathBuf::from(&path);
    if let Some(parent) = dest.parent() { fs::create_dir_all(parent).map_err(|e| e.to_string())?; }
    if unique && dest.exists() {
        let stem = dest.file_stem().map(|s| s.to_string_lossy().into_owned()).unwrap_or_default();
        let ext = dest.extension().map(|s| format!(".{}", s.to_string_lossy())).unwrap_or_default();
        let parent = dest.parent().map(|p| p.to_path_buf()).unwrap_or_default();
        let mut i = 1;
        loop { let cand = parent.join(format!("{stem}-{i}{ext}")); if !cand.exists() { dest = cand; break; } i += 1; }
    }
    fs::write(&dest, bytes).map_err(|e| e.to_string())?;
    Ok(dest.to_string_lossy().into_owned())
}

/// Copy a local file (e.g. an image dropped from a file manager) to `dest`, creating parent folders.
/// With `unique`, an existing destination gets a "-1", "-2", … suffix. Returns the final path.
#[tauri::command]
pub async fn copy_file(src: String, dest: String, unique: bool) -> Result<String, String> {
    let meta = fs::metadata(&src).map_err(|e| format!("{src}: {e}"))?;
    if !meta.is_file() { return Err(format!("{src}: not a file")); }
    let mut dest = std::path::PathBuf::from(&dest);
    if let Some(parent) = dest.parent() { fs::create_dir_all(parent).map_err(|e| e.to_string())?; }
    if fs::canonicalize(&src).ok() == fs::canonicalize(&dest).ok() { return Ok(dest.to_string_lossy().into_owned()); }
    if unique && dest.exists() {
        let stem = dest.file_stem().map(|s| s.to_string_lossy().into_owned()).unwrap_or_default();
        let ext = dest.extension().map(|s| format!(".{}", s.to_string_lossy())).unwrap_or_default();
        let parent = dest.parent().map(|p| p.to_path_buf()).unwrap_or_default();
        let mut i = 1;
        loop { let cand = parent.join(format!("{stem}-{i}{ext}")); if !cand.exists() { dest = cand; break; } i += 1; }
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
pub async fn cli_args() -> Vec<String> { std::env::args().skip(1).collect() }

#[tauri::command]
pub async fn quit_app(app: tauri::AppHandle, code: i32) { app.exit(code); }

/// Render `html` to a PDF at `out`.
/// Linux: loads the HTML into a hidden WebKitGTK webview and prints it to file with
/// webkit_print_operation (no dialog). Other platforms: not implemented here — the frontend
/// falls back to the system print dialog (window.print), see README "PDF export".
#[tauri::command]
pub async fn export_pdf(app: tauri::AppHandle, html: String, out: String) -> Result<(), String> {
    #[cfg(any(target_os = "linux", target_os = "macos", windows))]
    { crate::pdf::export_pdf(app, html, out).await }
    #[cfg(not(any(target_os = "linux", target_os = "macos", windows)))]
    { let _ = (app, html, out); Err("unsupported".into()) }
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
pub async fn kb_call(app: tauri::AppHandle, req: serde_json::Value) -> Result<serde_json::Value, String> {
    #[cfg(feature = "library")]
    {
        let dir = kb_data_dir(&app)?;
        tauri::async_runtime::spawn_blocking(move || crate::kb::dispatch(&dir, req)).await.map_err(|e| e.to_string())?
    }
    #[cfg(not(feature = "library"))]
    { let _ = (app, req); Err("library support not built".into()) }
}

/// Watch a workspace folder; debounced batches of changed Markdown paths arrive on `on_change`.
#[tauri::command]
pub async fn kb_watch(id: String, root: String, on_change: tauri::ipc::Channel<Vec<String>>) -> Result<(), String> {
    #[cfg(feature = "library")]
    { crate::kb::watch::start(&id, std::path::Path::new(&root), std::time::Duration::from_millis(1500), move |b| { let _ = on_change.send(b); }) }
    #[cfg(not(feature = "library"))]
    { let _ = (id, root, on_change); Err("library support not built".into()) }
}

#[tauri::command]
pub async fn kb_unwatch(id: String) -> bool {
    #[cfg(feature = "library")]
    { crate::kb::watch::stop(&id) }
    #[cfg(not(feature = "library"))]
    { let _ = id; false }
}
