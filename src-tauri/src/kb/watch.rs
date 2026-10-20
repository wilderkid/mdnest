//! Recursive file watching (notify; inotify/FSEvents/ReadDirectoryChangesW).
//! The library index watches Markdown only. The file tree watches every non-hidden path.
//! Events are debounced and delivered as one batch of changed paths.

use notify::{RecursiveMode, Watcher};
use std::collections::{BTreeSet, HashMap};
use std::path::{Path, PathBuf};
use std::sync::{mpsc, Mutex, OnceLock};
use std::time::{Duration, Instant};

struct Handle {
    _w: notify::RecommendedWatcher,
    stop: mpsc::Sender<()>,
}

fn watchers() -> &'static Mutex<HashMap<String, Handle>> {
    static M: OnceLock<Mutex<HashMap<String, Handle>>> = OnceLock::new();
    M.get_or_init(Default::default)
}

fn hidden(p: &Path) -> bool {
    p.components()
        .any(|c| c.as_os_str().to_string_lossy().starts_with('.'))
}

fn interesting(p: &Path) -> bool {
    !hidden(p)
        && p.extension()
            .map(|x| super::EXTS.contains(&x.to_string_lossy().to_lowercase().as_str()))
            .unwrap_or(false)
}

/// Every non-hidden path. Directories have no extension, so they still pass.
fn any_visible(p: &Path) -> bool {
    !hidden(p)
}

fn spawn_watch(
    id: &str,
    root: &Path,
    debounce: Duration,
    keep: impl Fn(&Path) -> bool + Send + 'static,
    emit: impl Fn(Vec<String>) + Send + 'static,
) -> Result<(), String> {
    stop(id);
    let (tx, rx) = mpsc::channel::<PathBuf>();
    let mut w = notify::recommended_watcher(move |res: notify::Result<notify::Event>| {
        if let Ok(ev) = res {
            if matches!(ev.kind, notify::EventKind::Access(_)) {
                return;
            }
            for p in ev.paths {
                if keep(&p) {
                    let _ = tx.send(p);
                }
            }
        }
    })
    .map_err(|e| e.to_string())?;
    w.watch(root, RecursiveMode::Recursive)
        .map_err(|e| e.to_string())?;
    let (stop_tx, stop_rx) = mpsc::channel::<()>();
    std::thread::spawn(move || {
        let mut batch: BTreeSet<String> = BTreeSet::new();
        let mut last = Instant::now();
        loop {
            if stop_rx.try_recv().is_ok() {
                return;
            }
            match rx.recv_timeout(Duration::from_millis(200)) {
                Ok(p) => {
                    batch.insert(p.to_string_lossy().to_string());
                    last = Instant::now();
                }
                Err(mpsc::RecvTimeoutError::Disconnected) => return,
                Err(mpsc::RecvTimeoutError::Timeout) => {}
            }
            if !batch.is_empty() && last.elapsed() >= debounce {
                emit(std::mem::take(&mut batch).into_iter().collect());
            }
        }
    });
    watchers().lock().unwrap().insert(
        id.to_string(),
        Handle {
            _w: w,
            stop: stop_tx,
        },
    );
    Ok(())
}

/// Start watching `root` for Markdown changes (replacing an earlier watch with the same id).
pub fn start(
    id: &str,
    root: &Path,
    debounce: Duration,
    emit: impl Fn(Vec<String>) + Send + 'static,
) -> Result<(), String> {
    spawn_watch(id, root, debounce, interesting, emit)
}

/// Watch every non-hidden file and directory under `root`. Used by the file tree.
pub fn start_fs(
    id: &str,
    root: &Path,
    debounce: Duration,
    emit: impl Fn(Vec<String>) + Send + 'static,
) -> Result<(), String> {
    spawn_watch(id, root, debounce, any_visible, emit)
}

pub fn stop(id: &str) -> bool {
    if let Some(h) = watchers().lock().unwrap().remove(id) {
        let _ = h.stop.send(());
        true
    } else {
        false
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn debounced_batch_of_markdown_changes() {
        let dir = std::env::temp_dir().join(format!("mdnest-watch-{}", std::process::id()));
        std::fs::create_dir_all(dir.join("sub")).unwrap();
        let (tx, rx) = mpsc::channel();
        start("t", &dir, Duration::from_millis(300), move |b| {
            let _ = tx.send(b);
        })
        .unwrap();
        std::thread::sleep(Duration::from_millis(150));
        std::fs::write(dir.join("a.md"), "x").unwrap();
        std::fs::write(dir.join("sub/b.md"), "y").unwrap();
        std::fs::write(dir.join("ignore.png"), "z").unwrap();
        std::fs::write(dir.join("a.md"), "x2").unwrap();
        let batch = rx.recv_timeout(Duration::from_secs(5)).expect("batch");
        assert!(
            batch.iter().any(|p| p.ends_with("a.md")) && batch.iter().any(|p| p.ends_with("b.md")),
            "{batch:?}"
        );
        assert!(!batch.iter().any(|p| p.ends_with(".png")));
        assert!(stop("t"));
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn fs_watch_includes_non_markdown() {
        let dir = std::env::temp_dir().join(format!("mdnest-fswatch-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let (tx, rx) = mpsc::channel();
        start_fs("fs", &dir, Duration::from_millis(200), move |b| {
            let _ = tx.send(b);
        })
        .unwrap();
        std::thread::sleep(Duration::from_millis(120));
        std::fs::write(dir.join("note.txt"), "hi").unwrap();
        std::fs::write(dir.join("pic.png"), "z").unwrap();
        let batch = rx.recv_timeout(Duration::from_secs(5)).expect("batch");
        assert!(batch.iter().any(|p| p.ends_with("note.txt")), "{batch:?}");
        assert!(batch.iter().any(|p| p.ends_with("pic.png")), "{batch:?}");
        assert!(stop("fs"));
        std::fs::remove_dir_all(&dir).ok();
    }
}
