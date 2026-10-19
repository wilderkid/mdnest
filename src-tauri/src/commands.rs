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
pub async fn pick_save_path(app: tauri::AppHandle, default_name: String) -> Option<String> {
    app.dialog()
        .file()
        .add_filter("Markdown", &["md", "markdown"])
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
        if lower == "base.user.css" || lower.ends_with(".user.css") {
            continue;
        }
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
    let arg = std::env::args().skip(1).find(|a| !a.starts_with('-'))?;
    let p = std::path::PathBuf::from(arg);
    let abs = if p.is_absolute() { p } else { std::env::current_dir().ok()?.join(p) };
    abs.is_file().then(|| abs.to_string_lossy().into_owned())
}
