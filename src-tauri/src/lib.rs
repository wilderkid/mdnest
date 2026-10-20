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

/// The desktop language from the POSIX locale variables ("zh_CN.UTF-8" → "zh-CN"). WebKitGTK only
/// reports it as navigator.language when that locale is installed, so the UI language would fall
/// back to English on some systems. Windows/macOS webviews report the OS language themselves.
pub fn env_lang(get: impl Fn(&str) -> Option<String>) -> Option<String> {
    for var in ["LANGUAGE", "LC_ALL", "LC_MESSAGES", "LANG"] {
        let Some(v) = get(var) else { continue };
        let first = v
            .split(':')
            .next()
            .unwrap_or("")
            .split(['.', '@'])
            .next()
            .unwrap_or("")
            .trim()
            .to_string();
        if first.is_empty() || first == "C" || first == "POSIX" {
            continue;
        }
        let tag: String = first
            .replace('_', "-")
            .chars()
            .filter(|c| c.is_ascii_alphanumeric() || *c == '-')
            .collect();
        if !tag.is_empty() {
            return Some(tag);
        }
    }
    None
}

/// Exposes the system language to every webview before page scripts run (read by src/i18n).
fn locale_plugin<R: tauri::Runtime>() -> tauri::plugin::TauriPlugin<R> {
    let lang = if cfg!(any(target_os = "windows", target_os = "macos")) {
        None
    } else {
        env_lang(|k| std::env::var(k).ok())
    };
    let script = match lang {
        Some(l) => format!("window.__MDNEST_SYS_LANG__ = {:?};", l),
        None => String::new(),
    };
    tauri::plugin::Builder::new("mdnest-locale")
        .js_init_script(script)
        .build()
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(locale_plugin())
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
            commands::read_file_bytes,
            commands::write_file_bytes,
            commands::list_dir,
            commands::list_themes,
            commands::default_workspace,
            commands::cli_file,
            commands::write_binary_file,
            commands::copy_file,
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
            commands::set_spellcheck,
            commands::open_external,
            commands::pandoc_info,
            commands::pandoc_export,
            commands::list_files,
            commands::file_excerpt,
            commands::recent_previews,
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
            let Ok(core) = webview.controller().CoreWebView2() else {
                return;
            };
            let Ok(settings) = core.Settings() else {
                return;
            };
            let _ = settings.SetAreDefaultContextMenusEnabled(false);
            if let Ok(settings3) = settings.cast::<ICoreWebView2Settings3>() {
                let _ = settings3.SetAreBrowserAcceleratorKeysEnabled(false);
            }
        }
    });
}

#[cfg(not(windows))]
pub fn disable_webview_chrome(_win: &tauri::WebviewWindow) {}

/// Turn the platform spell checker on or off.
/// Linux uses enchant/hunspell through WebKitGTK. If no dictionary is installed, the
/// attribute still toggles and no words are marked. Windows WebView2 and macOS WKWebView
/// follow the DOM `spellcheck` attribute, so there is nothing extra to set.
#[cfg(target_os = "linux")]
pub fn set_spellcheck(win: &tauri::WebviewWindow, enabled: bool) {
    let _ = win.with_webview(move |webview| {
        use webkit2gtk::{WebContextExt, WebViewExt};
        let view: webkit2gtk::WebView = webview.inner();
        let Some(ctx) = view.context() else { return };
        ctx.set_spell_checking_enabled(enabled);
        if enabled {
            let lang = std::env::var("LANG").unwrap_or_default();
            let code = lang.split(['.', '@']).next().unwrap_or("").trim();
            let code = if code.is_empty() || code == "C" || code == "POSIX" {
                "en_US"
            } else {
                code
            };
            ctx.set_spell_checking_languages(&[code]);
        }
    });
}

#[cfg(not(target_os = "linux"))]
pub fn set_spellcheck(_win: &tauri::WebviewWindow, _enabled: bool) {}

#[cfg(test)]
mod locale_tests {
    use super::env_lang;
    fn with<'a>(pairs: &'a [(&'a str, &'a str)]) -> impl Fn(&str) -> Option<String> + 'a {
        move |k| {
            pairs
                .iter()
                .find(|(n, _)| *n == k)
                .map(|(_, v)| v.to_string())
        }
    }
    #[test]
    fn env_lang_reads_posix_locale() {
        assert_eq!(
            env_lang(with(&[("LANG", "zh_CN.UTF-8")])).as_deref(),
            Some("zh-CN")
        );
        assert_eq!(
            env_lang(with(&[("LANGUAGE", "zh_TW:zh"), ("LANG", "en_US.UTF-8")])).as_deref(),
            Some("zh-TW")
        );
        assert_eq!(
            env_lang(with(&[("LC_ALL", "C"), ("LANG", "de_DE@euro")])).as_deref(),
            Some("de-DE")
        );
        assert_eq!(env_lang(with(&[("LANG", "C.UTF-8")])), None);
        assert_eq!(env_lang(with(&[])), None);
    }
}
