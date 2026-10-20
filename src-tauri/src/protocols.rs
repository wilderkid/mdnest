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

/// Percent-decode a URL path and reject `..` and NUL. Leading `/` is stripped.
/// Absolute paths are rejected: `mdtheme` is relative, and `mdfile` restores the root itself.
fn decode_url_path(raw: &str) -> Result<String, ()> {
    let trimmed = raw.strip_prefix('/').unwrap_or(raw);
    let decoded = percent_decode_str(trimmed)
        .decode_utf8()
        .map_err(|_| ())?
        .into_owned();
    if decoded.contains('\0') {
        return Err(());
    }
    let path = Path::new(&decoded);
    if path.is_absolute() {
        return Err(());
    }
    for component in path.components() {
        if matches!(component, Component::ParentDir) {
            return Err(());
        }
    }
    Ok(decoded)
}

/// Turn an `mdfile` URL path into a filesystem path.
///
/// The frontend always sends forward slashes and strips one leading `/`:
/// - Unix `/home/a.png` → URL path `/home/a.png` → `/home/a.png`
/// - Windows `C:/Users/x/a.png` → URL path `/C:/Users/x/a.png` → `C:/Users/x/a.png`
///
/// `..` and NUL are rejected. The helper is platform-independent so both forms are unit-tested
/// on Linux.
pub fn decode_mdfile_path(raw: &str) -> Result<PathBuf, ()> {
    decode_mdfile_path_for(raw, cfg!(windows)).map(PathBuf::from)
}

/// Platform-parameterised core of [`decode_mdfile_path`], so the Windows rules are unit-tested on Linux.
///
/// 0.2.0 ran every URL through `decode_url_path`, which rejects absolute paths — and on Windows
/// `C:/Users/x/a.png` IS absolute, so every local image answered 400 there (pasted and inserted
/// images never displayed). Windows forms accepted here:
/// - `/C:/dir/a.png` → `C:\dir\a.png`
/// - `/UNC/server/share/a.png` → `\\server\share\a.png` (network shares, see `fileUrl` in host/tauri.ts)
pub fn decode_mdfile_path_for(raw: &str, windows: bool) -> Result<String, ()> {
    let trimmed = raw.strip_prefix('/').unwrap_or(raw);
    let decoded = percent_decode_str(trimmed)
        .decode_utf8()
        .map_err(|_| ())?
        .into_owned();
    if decoded.is_empty() || decoded.contains('\0') {
        return Err(());
    }
    if decoded.split(['/', '\\']).any(|c| c == "..") {
        return Err(());
    }
    if is_windows_drive_path(&decoded) {
        return Ok(if windows { decoded.replace('/', "\\") } else { decoded.replace('\\', "/") });
    }
    if windows {
        if let Some(rest) = decoded.strip_prefix("UNC/") {
            if rest.split('/').filter(|s| !s.is_empty()).count() < 2 {
                return Err(());
            }
            return Ok(format!("\\\\{}", rest.replace('/', "\\")));
        }
        // anything else is not a Windows file path
        return Err(());
    }
    Ok(format!("/{}", decoded.trim_start_matches('/')))
}

fn is_windows_drive_path(s: &str) -> bool {
    let b = s.as_bytes();
    b.len() >= 2
        && b[0].is_ascii_alphabetic()
        && b[1] == b':'
        && (b.len() == 2 || b[2] == b'/' || b[2] == b'\\')
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
        let full = match decode_mdfile_path(&raw_path) {
            Ok(p) => p,
            Err(()) => {
                respond(responder, 400, b"bad path".to_vec(), "text/plain");
                return;
            }
        };
        match fs::read(&full) {
            Ok(bytes) => {
                let mime = content_type(&full).to_string();
                respond(responder, 200, bytes, &mime);
            }
            Err(e) => respond(responder, 404, e.to_string().into_bytes(), "text/plain"),
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn unix_absolute_path_is_restored() {
        let p = decode_mdfile_path("/home/a/b.png").unwrap();
        assert_eq!(p, PathBuf::from("/home/a/b.png"));
    }

    #[test]
    fn windows_drive_letter_is_kept() {
        let p = decode_mdfile_path("/C:/Users/x/a.png").unwrap();
        assert_eq!(p, PathBuf::from("C:/Users/x/a.png"));
        let q = decode_mdfile_path("/c:/Users/x/a.png").unwrap();
        assert_eq!(q, PathBuf::from("c:/Users/x/a.png"));
    }

    #[test]
    fn windows_rules() {
        assert_eq!(decode_mdfile_path_for("/C:/Users/x/a.png", true).unwrap(), "C:\\Users\\x\\a.png");
        assert_eq!(
            decode_mdfile_path_for("/C:/Users/%E5%BC%A0%E4%B8%89/OneDrive/%E6%96%87%E6%A1%A3/assets/image-1.png", true).unwrap(),
            "C:\\Users\\张三\\OneDrive\\文档\\assets\\image-1.png"
        );
        assert_eq!(decode_mdfile_path_for("/UNC/nas/share/a%23b.png", true).unwrap(), "\\\\nas\\share\\a#b.png");
        assert!(decode_mdfile_path_for("/UNC/nas", true).is_err());
        assert!(decode_mdfile_path_for("/home/a.png", true).is_err());
        assert!(decode_mdfile_path_for("/C:/a/../b.png", true).is_err());
        assert!(decode_mdfile_path_for("/C:/a/..%5Cb.png", true).is_err());
        // Linux keeps its absolute form
        assert_eq!(decode_mdfile_path_for("/home/a/b.png", false).unwrap(), "/home/a/b.png");
    }

    #[test]
    fn percent_encoded_and_rejected() {
        let p = decode_mdfile_path("/C:/Users/x/my%20file.png").unwrap();
        assert_eq!(p, PathBuf::from("C:/Users/x/my file.png"));
        assert!(decode_mdfile_path("/home/a/../../etc/passwd").is_err());
        assert!(decode_mdfile_path("/C:/Users/../Windows/a.png").is_err());
        assert!(decode_mdfile_path("/home/a/%00.png").is_err());
        assert!(decode_mdfile_path("/").is_err());
    }
}
