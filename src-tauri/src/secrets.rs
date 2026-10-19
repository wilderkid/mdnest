//! Secret storage for plugins.
//!
//! Preferred backend is the OS keyring (`keyring` crate: Keychain, Credential Manager,
//! Secret Service). When Secret Service is unavailable (no D-Bus session), values fall
//! back to `<app_config_dir>/secrets.json` with mode 0600.
//!
//! There is no command that returns a secret value. Callers that need the plaintext
//! (the streaming HTTP client) read it in-process via [`lookup`].

use std::collections::BTreeMap;
use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use serde::{Deserialize, Serialize};
use tauri::Manager;

const SERVICE: &str = "app.mdnest.editor";
const ID_MAX: usize = 64;

/// `^[a-z0-9._-]{1,64}$`
pub fn valid_id(id: &str) -> bool {
    let b = id.as_bytes();
    !b.is_empty()
        && b.len() <= ID_MAX
        && b.iter().all(|c| {
            c.is_ascii_lowercase() || c.is_ascii_digit() || matches!(c, b'.' | b'_' | b'-')
        })
}

fn check_id(id: &str) -> Result<(), String> {
    if valid_id(id) {
        Ok(())
    } else {
        Err("invalid secret id".into())
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Backend {
    Keyring,
    File,
}

impl Backend {
    pub fn name(self) -> &'static str {
        match self {
            Backend::Keyring => "keyring",
            Backend::File => "file",
        }
    }
}

#[derive(Default, Serialize, Deserialize)]
struct FileStore {
    secrets: BTreeMap<String, String>,
}

struct State {
    backend: Backend,
    /// Set once the keyring probe fails, so later calls do not retry D-Bus.
    file_dir: Option<PathBuf>,
}

static STATE: Mutex<Option<State>> = Mutex::new(None);

fn lock() -> std::sync::MutexGuard<'static, Option<State>> {
    STATE.lock().unwrap_or_else(|e| e.into_inner())
}

/// Resolve the app config directory. Tests can point this at a temp dir via
/// `MDNEST_CONFIG_DIR` so they never touch the real profile.
fn config_dir(app: Option<&tauri::AppHandle>) -> Result<PathBuf, String> {
    if let Ok(over) = std::env::var("MDNEST_CONFIG_DIR") {
        if !over.is_empty() {
            let p = PathBuf::from(over);
            fs::create_dir_all(&p).map_err(|e| e.to_string())?;
            return Ok(p);
        }
    }
    if let Some(app) = app {
        let dir = app.path().app_config_dir().map_err(|e| e.to_string())?;
        fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
        return Ok(dir);
    }
    Err("no app config dir".into())
}

fn secrets_path(dir: &Path) -> PathBuf {
    dir.join("secrets.json")
}

/// Restrict the file to the owner. No-op on Windows (ACLs are a different model;
/// Credential Manager is the primary store there).
fn restrict_file(path: &Path) {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = fs::set_permissions(path, fs::Permissions::from_mode(0o600));
    }
    #[cfg(not(unix))]
    {
        let _ = path;
    }
}

fn read_file_store(path: &Path) -> Result<FileStore, String> {
    if !path.exists() {
        return Ok(FileStore::default());
    }
    let text = fs::read_to_string(path).map_err(|e| e.to_string())?;
    if text.trim().is_empty() {
        return Ok(FileStore::default());
    }
    serde_json::from_str(&text).map_err(|e| e.to_string())
}

fn write_file_store(path: &Path, store: &FileStore) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    let tmp = path.with_extension("json.tmp");
    {
        let mut f = fs::File::create(&tmp).map_err(|e| e.to_string())?;
        restrict_file(&tmp);
        let body = serde_json::to_vec_pretty(store).map_err(|e| e.to_string())?;
        f.write_all(&body).map_err(|e| e.to_string())?;
        f.write_all(b"\n").map_err(|e| e.to_string())?;
        f.sync_all().map_err(|e| e.to_string())?;
    }
    fs::rename(&tmp, path).map_err(|e| {
        let _ = fs::remove_file(&tmp);
        e.to_string()
    })?;
    restrict_file(path);
    Ok(())
}

fn probe_keyring() -> bool {
    // A round-trip of a throwaway entry. Failure (no Secret Service, no D-Bus)
    // means we stay on the file backend for the life of the process.
    let probe_user = format!("mdnest-probe-{}", std::process::id());
    let Ok(entry) = keyring::Entry::new(SERVICE, &probe_user) else {
        return false;
    };
    if entry.set_password("probe").is_err() {
        return false;
    }
    let ok = entry.get_password().ok().as_deref() == Some("probe");
    let _ = entry.delete_credential();
    ok
}

fn ensure(app: Option<&tauri::AppHandle>) -> Result<(), String> {
    {
        let guard = lock();
        if guard.is_some() {
            return Ok(());
        }
    }
    let dir = config_dir(app)?;
    let backend = if probe_keyring() {
        Backend::Keyring
    } else {
        Backend::File
    };
    let mut guard = lock();
    if guard.is_none() {
        *guard = Some(State {
            backend,
            file_dir: Some(dir),
        });
    }
    Ok(())
}

pub fn backend_name(app: Option<&tauri::AppHandle>) -> Result<String, String> {
    ensure(app)?;
    let guard = lock();
    let state = guard.as_ref().ok_or("secrets not initialised")?;
    Ok(state.backend.name().to_string())
}

fn file_dir_of(state: &State) -> Result<&Path, String> {
    state.file_dir.as_deref().ok_or_else(|| "no secrets dir".into())
}

pub fn set(app: Option<&tauri::AppHandle>, id: &str, value: &str) -> Result<(), String> {
    check_id(id)?;
    if value.is_empty() {
        return Err("empty secret".into());
    }
    ensure(app)?;
    let guard = lock();
    let state = guard.as_ref().ok_or("secrets not initialised")?;
    match state.backend {
        Backend::Keyring => {
            let entry = keyring::Entry::new(SERVICE, id).map_err(|e| e.to_string())?;
            entry.set_password(value).map_err(|e| e.to_string())
        }
        Backend::File => {
            let path = secrets_path(file_dir_of(state)?);
            let mut store = read_file_store(&path)?;
            store.secrets.insert(id.to_string(), value.to_string());
            write_file_store(&path, &store)
        }
    }
}

pub fn has(app: Option<&tauri::AppHandle>, id: &str) -> Result<bool, String> {
    check_id(id)?;
    ensure(app)?;
    let guard = lock();
    let state = guard.as_ref().ok_or("secrets not initialised")?;
    match state.backend {
        Backend::Keyring => {
            let entry = keyring::Entry::new(SERVICE, id).map_err(|e| e.to_string())?;
            match entry.get_password() {
                Ok(_) => Ok(true),
                Err(keyring::Error::NoEntry) => Ok(false),
                Err(e) => Err(e.to_string()),
            }
        }
        Backend::File => {
            let path = secrets_path(file_dir_of(state)?);
            let store = read_file_store(&path)?;
            Ok(store.secrets.contains_key(id))
        }
    }
}

pub fn delete(app: Option<&tauri::AppHandle>, id: &str) -> Result<(), String> {
    check_id(id)?;
    ensure(app)?;
    let guard = lock();
    let state = guard.as_ref().ok_or("secrets not initialised")?;
    match state.backend {
        Backend::Keyring => {
            let entry = keyring::Entry::new(SERVICE, id).map_err(|e| e.to_string())?;
            match entry.delete_credential() {
                Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
                Err(e) => Err(e.to_string()),
            }
        }
        Backend::File => {
            let path = secrets_path(file_dir_of(state)?);
            let mut store = read_file_store(&path)?;
            store.secrets.remove(id);
            write_file_store(&path, &store)
        }
    }
}

/// In-process lookup. Not exposed as a Tauri command.
pub fn lookup(app: Option<&tauri::AppHandle>, id: &str) -> Result<Option<String>, String> {
    check_id(id)?;
    ensure(app)?;
    let guard = lock();
    let state = guard.as_ref().ok_or("secrets not initialised")?;
    match state.backend {
        Backend::Keyring => {
            let entry = keyring::Entry::new(SERVICE, id).map_err(|e| e.to_string())?;
            match entry.get_password() {
                Ok(v) => Ok(Some(v)),
                Err(keyring::Error::NoEntry) => Ok(None),
                Err(e) => Err(e.to_string()),
            }
        }
        Backend::File => {
            let path = secrets_path(file_dir_of(state)?);
            let store = read_file_store(&path)?;
            Ok(store.secrets.get(id).cloned())
        }
    }
}

/// Remove every occurrence of `secret` from `text`. Used before an error body
/// is sent to the frontend.
pub fn scrub(text: &str, secret: &str) -> String {
    if secret.is_empty() {
        return text.to_string();
    }
    text.replace(secret, "[redacted]")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn id_pattern() {
        assert!(valid_id("openai"));
        assert!(valid_id("a"));
        assert!(valid_id("provider.openai"));
        assert!(valid_id("k_1-2.3"));
        assert!(!valid_id(""));
        assert!(!valid_id("HasUpper"));
        assert!(!valid_id("has space"));
        assert!(!valid_id("slash/no"));
        assert!(!valid_id(&"a".repeat(65)));
        assert!(valid_id(&"a".repeat(64)));
    }

    #[test]
    fn scrub_removes_secret() {
        assert_eq!(scrub("bearer sk-live-abc failed", "sk-live-abc"), "bearer [redacted] failed");
        assert_eq!(scrub("nothing", ""), "nothing");
        assert_eq!(scrub("aa aa", "aa"), "[redacted] [redacted]");
    }

    /// This environment has no D-Bus session, so the store must fall back to a
    /// 0600 file and report backend "file". The probe never prints the value.
    #[test]
    fn file_fallback_round_trip_without_secret_service() {
        let dir = std::env::temp_dir().join(format!("mdnest-secrets-test-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        std::env::set_var("MDNEST_CONFIG_DIR", &dir);
        // Reset process state so this test probes for itself.
        *lock() = None;

        let name = backend_name(None).expect("backend");
        assert_eq!(name, "file", "expected file fallback, got {name}");

        set(None, "openai.primary", "not-a-real-token").unwrap();
        assert!(has(None, "openai.primary").unwrap());
        assert!(!has(None, "missing.key").unwrap());
        let got = lookup(None, "openai.primary").unwrap();
        assert_eq!(got.as_deref(), Some("not-a-real-token"));
        delete(None, "openai.primary").unwrap();
        assert!(!has(None, "openai.primary").unwrap());
        assert!(lookup(None, "openai.primary").unwrap().is_none());
        // Deleting a missing id is not an error.
        delete(None, "missing.key").unwrap();
        assert!(set(None, "Bad", "x").is_err());

        let path = dir.join("secrets.json");
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mode = fs::metadata(&path).unwrap().permissions().mode() & 0o777;
            assert_eq!(mode, 0o600, "secrets.json mode was {mode:o}");
        }
        let _ = fs::remove_dir_all(&dir);
        std::env::remove_var("MDNEST_CONFIG_DIR");
        *lock() = None;
    }
}
