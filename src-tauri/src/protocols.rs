use std::fs;
use std::path::{Component, Path, PathBuf};

use percent_encoding::percent_decode_str;
use tauri::{UriSchemeContext, UriSchemeResponder};

use crate::themes_dir;

fn content_type(path: &Path) -> &'static str {
    match path
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("")
        .to_ascii_lowercase()
        .as_str()
    {
        "css" => "text/css; charset=utf-8",
        "woff2" => "font/woff2",
        "woff" => "font/woff",
        "ttf" => "font/ttf",
        "otf" => "font/otf",
        "svg" => "image/svg+xml",
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "gif" => "image/gif",
        "webp" => "image/webp",
        "html" | "htm" => "text/html; charset=utf-8",
        "json" => "application/json",
        "txt" | "md" => "text/plain; charset=utf-8",
        _ => "application/octet-stream",
    }
}

fn respond(responder: UriSchemeResponder, status: u16, body: Vec<u8>, mime: &str) {
    let response = http::Response::builder()
        .status(status)
        .header(http::header::CONTENT_TYPE, mime)
        .header(http::header::ACCESS_CONTROL_ALLOW_ORIGIN, "*")
        .header(http::header::CACHE_CONTROL, "no-cache")
        .body(body)
        .unwrap_or_else(|_| {
            http::Response::builder()
                .status(500)
                .body(Vec::new())
                .expect("fallback response")
        });
    responder.respond(response);
}

/// Percent-decode the URL path and reject `..` traversal. Leading `/` is stripped.
fn decode_url_path(raw: &str) -> Result<String, ()> {
    let trimmed = raw.strip_prefix('/').unwrap_or(raw);
    let decoded = percent_decode_str(trimmed)
        .decode_utf8()
        .map_err(|_| ())?
        .into_owned();
    let path = Path::new(&decoded);
    if path.is_absolute() {
        return Err(());
    }
    for component in path.components() {
        if matches!(component, Component::ParentDir) {
            return Err(());
        }
    }
    if decoded.contains('\0') {
        return Err(());
    }
    Ok(decoded)
}

/// `mdtheme://localhost/<relative>` serves a file from the themes directory.
pub fn handle_mdtheme(
    ctx: UriSchemeContext<'_, tauri::Wry>,
    request: http::Request<Vec<u8>>,
    responder: UriSchemeResponder,
) {
    let raw_path = request.uri().path().to_string();
    let app = ctx.app_handle().clone();
    std::thread::spawn(move || {
        let rel = match decode_url_path(&raw_path) {
            Ok(p) if !p.is_empty() => p,
            _ => {
                respond(responder, 400, b"bad path".to_vec(), "text/plain");
                return;
            }
        };
        let themes = match themes_dir(&app) {
            Ok(d) => d,
            Err(e) => {
                respond(responder, 500, e.into_bytes(), "text/plain");
                return;
            }
        };
        let full = themes.join(&rel);
        // Join can still escape if the decoded path is absolute; already rejected.
        // Also reject if the canonical path is outside the themes dir.
        match fs::canonicalize(&full) {
            Ok(canon) => {
                let themes_canon = match fs::canonicalize(&themes) {
                    Ok(p) => p,
                    Err(e) => {
                        respond(responder, 500, e.to_string().into_bytes(), "text/plain");
                        return;
                    }
                };
                if !canon.starts_with(&themes_canon) {
                    respond(responder, 403, b"forbidden".to_vec(), "text/plain");
                    return;
                }
                match fs::read(&canon) {
                    Ok(bytes) => {
                        let mime = content_type(&canon).to_string();
                        respond(responder, 200, bytes, &mime);
                    }
                    Err(e) => respond(responder, 404, e.to_string().into_bytes(), "text/plain"),
                }
            }
            Err(e) => respond(responder, 404, e.to_string().into_bytes(), "text/plain"),
        }
    });
}

/// `mdfile://localhost/<abs-without-leading-slash>` serves any local file.
/// The frontend strips the leading `/` and we prepend it back.
pub fn handle_mdfile(
    _ctx: UriSchemeContext<'_, tauri::Wry>,
    request: http::Request<Vec<u8>>,
    responder: UriSchemeResponder,
) {
    let raw_path = request.uri().path().to_string();
    std::thread::spawn(move || {
        let decoded = match decode_url_path(&raw_path) {
            Ok(p) if !p.is_empty() => p,
            _ => {
                respond(responder, 400, b"bad path".to_vec(), "text/plain");
                return;
            }
        };
        // decode_url_path rejects `..` components and absolute paths. The frontend
        // encodes an absolute path with the leading slash removed, so restore it.
        if decoded.contains('\0') {
            respond(responder, 400, b"bad path".to_vec(), "text/plain");
            return;
        }
        let full = PathBuf::from("/").join(&decoded);
        match fs::read(&full) {
            Ok(bytes) => {
                let mime = content_type(&full).to_string();
                respond(responder, 200, bytes, &mime);
            }
            Err(e) => respond(responder, 404, e.to_string().into_bytes(), "text/plain"),
        }
    });
}
