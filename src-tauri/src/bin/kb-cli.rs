//! Dev/test bridge to the workspace index: one JSON request on stdin → one JSON response on stdout
//! ({"ok": value} or {"err": message}). Used by the Vite dev host so browser tests exercise the same
//! Rust index as the desktop app. `kb-cli <data_dir>`.
use std::io::Read;

fn main() {
    let data = std::env::args().nth(1).unwrap_or_else(|| ".".into());
    let mut buf = String::new();
    let _ = std::io::stdin().read_to_string(&mut buf);
    let out = match serde_json::from_str::<serde_json::Value>(&buf).map_err(|e| e.to_string()).and_then(|req| mdnest_lib::kb::dispatch(std::path::Path::new(&data), req)) {
        Ok(v) => serde_json::json!({ "ok": v }),
        Err(e) => serde_json::json!({ "err": e }),
    };
    println!("{out}");
}
