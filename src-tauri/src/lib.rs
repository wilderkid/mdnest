mod commands;
mod files;
#[cfg(feature = "library")]
pub mod kb;
mod menu;
mod net;
#[cfg(any(target_os = "linux", target_os = "macos", windows))]
mod pdf;
mod protocols;
mod secrets;
mod sse;

use std::fs;
use std::path::{Path, PathBuf};

use tauri::Manager;

/// App config dir + `/themes`. Created on startup if missing.
pub fn themes_dir(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_config_dir()
        .map_err(|e| e.to_string())?
        .join("themes");
    Ok(dir)
}

/// Copy files from `src` into `dst` only when the destination file does not exist yet.
fn seed_missing(src: &Path, dst: &Path) -> std::io::Result<()> {
    if !src.exists() {
        return Ok(());
    }
    fs::create_dir_all(dst)?;
    for entry in fs::read_dir(src)? {
        let entry = entry?;
        let from = entry.path();
        let name = entry.file_name();
        let to = dst.join(&name);
        let file_type = entry.file_type()?;
        if file_type.is_dir() {
            seed_missing(&from, &to)?;
        } else if file_type.is_file() && !to.exists() {
            if let Some(parent) = to.parent() {
                fs::create_dir_all(parent)?;
            }
            fs::copy(&from, &to)?;
        }
    }
    Ok(())
}

fn bundled_themes_dir(app: &tauri::AppHandle) -> Option<PathBuf> {
    // Map form {"resources/themes/": "themes/"} lands at $RESOURCE/themes.
    let from_resolver = app
        .path()
        .resolve("themes", tauri::path::BaseDirectory::Resource)
        .ok()
        .filter(|p| p.is_dir());
    if from_resolver.is_some() {
        return from_resolver;
    }
    app.path()
        .resource_dir()
        .ok()
        .map(|d| d.join("themes"))
        .filter(|p| p.is_dir())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .register_asynchronous_uri_scheme_protocol("mdtheme", protocols::handle_mdtheme)
        .register_asynchronous_uri_scheme_protocol("mdfile", protocols::handle_mdfile)
        .setup(|app| {
            let themes = themes_dir(app.handle())?;
            fs::create_dir_all(&themes).map_err(|e| e.to_string())?;
            if let Some(bundled) = bundled_themes_dir(app.handle()) {
                seed_missing(&bundled, &themes).map_err(|e| e.to_string())?;
            }
            let handle = app.handle().clone();
            // App-menu activations (macOS) go to the focused window, else main.
            app.on_menu_event(move |app, event| {
                let label = app
                    .webview_windows()
                    .into_iter()
                    .find(|(_, w)| w.is_focused().unwrap_or(false))
                    .map(|(l, _)| l)
                    .unwrap_or_else(|| "main".into());
                menu::emit_menu_event(app, &label, &event.id().0);
            });
            if let Some(win) = handle.get_webview_window("main") {
                let h2 = handle.clone();
                win.on_menu_event(move |win, event| {
                    menu::emit_menu_event(&h2, win.label(), &event.id().0);
                });
                disable_webview_chrome(&win);
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::pick_file,
            commands::pick_folder,
            commands::pick_save_path,
            commands::read_text_file,
            commands::write_text_file,
            commands::list_dir,
            commands::list_themes,
            commands::default_workspace,
            commands::cli_file,
            commands::write_binary_file, commands::copy_file,
            commands::file_mtime,
            commands::cli_args,
            commands::quit_app,
            commands::export_pdf,
            commands::secret_set,
            commands::secret_has,
            commands::secret_delete,
            commands::secret_backend,
            commands::net_stream,
            commands::net_cancel,
            commands::kb_call,
            commands::kb_watch,
            commands::kb_unwatch,
            commands::fs_watch,
            commands::fs_unwatch,
            menu::set_app_menu,
            commands::create_file,
            commands::create_dir,
            commands::rename_path,
            commands::duplicate_path,
            commands::trash_path,
            commands::reveal_path,
            commands::open_external,
            commands::list_files,
            commands::file_excerpt,
            commands::path_kind,
            commands::search_files,
            commands::open_window,
            commands::window_label,
            commands::close_window,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

/// WebView2 still ships browser accelerators (Ctrl+R, F5, Ctrl+P, page zoom) and Edge's
/// default context menu. Turn both off. The frontend also swallows those keys.
#[cfg(windows)]
pub fn disable_webview_chrome(win: &tauri::WebviewWindow) {
    let _ = win.with_webview(|webview| {
        use webview2_com::Microsoft::Web::WebView2::Win32::ICoreWebView2Settings3;
        use windows::core::Interface;
        unsafe {
            let Ok(core) = webview.controller().CoreWebView2() else { return };
            let Ok(settings) = core.Settings() else { return };
            let _ = settings.SetAreDefaultContextMenusEnabled(false);
            if let Ok(settings3) = settings.cast::<ICoreWebView2Settings3>() {
                let _ = settings3.SetAreBrowserAcceleratorKeysEnabled(false);
            }
        }
    });
}

#[cfg(not(windows))]
pub fn disable_webview_chrome(_win: &tauri::WebviewWindow) {}
