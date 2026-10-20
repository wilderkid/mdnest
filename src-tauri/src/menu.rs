//! Native menu built from the frontend spec (`set_app_menu`).
//! Activating an item emits `"mdn-menu"` with the item id. macOS also gets an app menu.
use serde::Deserialize;
use tauri::menu::{CheckMenuItem, Menu, MenuItem, PredefinedMenuItem, Submenu};
use tauri::{AppHandle, Emitter, Runtime};

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MenuNode {
    pub id: Option<String>,
    pub label: Option<String>,
    pub accel: Option<String>,
    pub checked: Option<bool>,
    pub enabled: Option<bool>,
    /// `separator` | `cut` | `copy` | `paste` | `select_all` | `undo` | `redo`
    pub role: Option<String>,
    pub submenu: Option<Vec<MenuNode>>,
}

fn accel_of(node: &MenuNode) -> Option<String> {
    let raw = node.accel.as_deref()?.trim();
    if raw.is_empty() {
        None
    } else {
        Some(raw.to_string())
    }
}

fn leaf_id(node: &MenuNode) -> String {
    node.id
        .clone()
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| node.label.clone().unwrap_or_default())
}

fn fill_submenu<R: Runtime>(
    app: &AppHandle<R>,
    sub: &Submenu<R>,
    nodes: &[MenuNode],
) -> Result<(), String> {
    for node in nodes {
        if let Some(children) = &node.submenu {
            let text = node.label.clone().unwrap_or_else(|| "Menu".into());
            let id = node.id.clone().unwrap_or_else(|| format!("sub-{text}"));
            let child = Submenu::with_id(app, &id, text, node.enabled.unwrap_or(true))
                .map_err(|e| e.to_string())?;
            fill_submenu(app, &child, children)?;
            sub.append(&child).map_err(|e| e.to_string())?;
            continue;
        }
        push_leaf(app, sub, node)?;
    }
    Ok(())
}

fn push_leaf<R: Runtime>(
    app: &AppHandle<R>,
    sub: &Submenu<R>,
    node: &MenuNode,
) -> Result<(), String> {
    let role = node.role.as_deref().unwrap_or("");
    if role == "separator" {
        let item = PredefinedMenuItem::separator(app).map_err(|e| e.to_string())?;
        sub.append(&item).map_err(|e| e.to_string())?;
        return Ok(());
    }
    // Predefined undo/redo are unsupported on Linux and would not emit our command id.
    // Honour the role only on Windows and macOS.
    let predefined_history =
        cfg!(any(windows, target_os = "macos")) && (role == "undo" || role == "redo");
    if matches!(role, "cut" | "copy" | "paste" | "select_all") || predefined_history {
        let text = node.label.as_deref();
        let item = match role {
            "cut" => PredefinedMenuItem::cut(app, text),
            "copy" => PredefinedMenuItem::copy(app, text),
            "paste" => PredefinedMenuItem::paste(app, text),
            "select_all" => PredefinedMenuItem::select_all(app, text),
            "undo" => PredefinedMenuItem::undo(app, text),
            "redo" => PredefinedMenuItem::redo(app, text),
            _ => unreachable!(),
        }
        .map_err(|e| e.to_string())?;
        sub.append(&item).map_err(|e| e.to_string())?;
        return Ok(());
    }
    let text = node.label.clone().unwrap_or_default();
    let id = leaf_id(node);
    if id.is_empty() {
        return Ok(());
    }
    let enabled = node.enabled.unwrap_or(true);
    let accel = accel_of(node);
    if node.checked.is_some() {
        let item = CheckMenuItem::with_id(
            app,
            &id,
            text,
            enabled,
            node.checked.unwrap_or(false),
            accel.as_deref(),
        )
        .map_err(|e| e.to_string())?;
        sub.append(&item).map_err(|e| e.to_string())?;
    } else {
        let item = MenuItem::with_id(app, &id, text, enabled, accel.as_deref())
            .map_err(|e| e.to_string())?;
        sub.append(&item).map_err(|e| e.to_string())?;
    }
    Ok(())
}

/// macOS application menu: About, Preferences, Quit. Other platforms omit it (Quit lives in File).
fn macos_app_menu(app: &AppHandle) -> Result<Submenu<tauri::Wry>, String> {
    let sub = Submenu::with_id(app, "menu.app", "MD Nest", true).map_err(|e| e.to_string())?;
    let about = MenuItem::with_id(app, "help.about", "About MD Nest", true, None::<&str>)
        .map_err(|e| e.to_string())?;
    let prefs = MenuItem::with_id(
        app,
        "file.preferences",
        "Preferences…",
        true,
        Some("CmdOrCtrl+,"),
    )
    .map_err(|e| e.to_string())?;
    let sep = PredefinedMenuItem::separator(app).map_err(|e| e.to_string())?;
    let quit = PredefinedMenuItem::quit(app, Some("Quit MD Nest")).map_err(|e| e.to_string())?;
    sub.append(&about).map_err(|e| e.to_string())?;
    sub.append(&prefs).map_err(|e| e.to_string())?;
    sub.append(&sep).map_err(|e| e.to_string())?;
    sub.append(&quit).map_err(|e| e.to_string())?;
    Ok(sub)
}

fn build_menu(app: &AppHandle, spec: &[MenuNode]) -> Result<Menu<tauri::Wry>, String> {
    let menu = Menu::new(app).map_err(|e| e.to_string())?;
    if cfg!(target_os = "macos") {
        menu.append(&macos_app_menu(app)?)
            .map_err(|e| e.to_string())?;
    }
    for node in spec {
        let Some(children) = &node.submenu else {
            continue;
        };
        let text = node.label.clone().unwrap_or_else(|| "Menu".into());
        let id = node.id.clone().unwrap_or_else(|| format!("sub-{text}"));
        let sub = Submenu::with_id(app, &id, text, true).map_err(|e| e.to_string())?;
        fill_submenu(app, &sub, children)?;
        menu.append(&sub).map_err(|e| e.to_string())?;
    }
    Ok(menu)
}

/// Replace the menu on the calling window. macOS also sets the application menu.
/// Extra windows created later call this themselves, so each window keeps its own menu.
#[tauri::command]
pub fn set_app_menu(
    app: AppHandle,
    window: tauri::WebviewWindow,
    spec: Vec<MenuNode>,
) -> Result<(), String> {
    let menu = build_menu(&app, &spec)?;
    if cfg!(target_os = "macos") {
        let _ = app.set_menu(menu.clone());
    }
    window.set_menu(menu).map_err(|e| e.to_string())?;
    // Deliver activations of this window's menu to this window only.
    let label = window.label().to_string();
    let handle = app.clone();
    window.on_menu_event(move |_win, event| {
        emit_menu_event(&handle, &label, &event.id().0);
    });
    Ok(())
}

/// Emit `"mdn-menu"` to one window so a click in window A does not run in window B.
pub fn emit_menu_event(app: &AppHandle, label: &str, id: &str) {
    if id.is_empty() {
        return;
    }
    let _ = app.emit_to(label, "mdn-menu", id);
}
