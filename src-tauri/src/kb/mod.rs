//! Workspace index ("library" core service): SQLite + FTS5 (BM25) + sqlite-vec (kNN), one database
//! per workspace root under the app data dir. Chunking/hashing happen here; embeddings are computed by
//! the plugin through its provider and written back with `put_vectors`. Rust only ever stores them.

pub mod chunk;
pub mod watch;

use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::{Mutex, Once, OnceLock};
use std::time::UNIX_EPOCH;

pub const EXTS: &[&str] = &["md", "markdown", "mdown", "txt"];
const MAX_FILE: u64 = 4 * 1024 * 1024;

#[derive(Debug, Serialize, Deserialize, Default, Clone)]
#[serde(rename_all = "camelCase")]
pub struct ScanReport { pub files: usize, pub changed_files: usize, pub removed_files: usize, pub added_chunks: usize, pub removed_chunks: usize, pub kept_chunks: usize, pub pending: usize, pub skipped_excluded: usize }

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct PendingChunk { pub id: i64, pub input: String }

#[derive(Debug, Serialize, Deserialize, Clone, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Hit {
    pub id: i64, pub path: String, pub rel: String, pub heading: String, pub anchor: String,
    pub line_start: i64, pub line_end: i64, pub text: String, pub score: f64,
    /// "fts", "vec" or both
    pub via: Vec<String>,
}

#[derive(Debug, Serialize, Deserialize, Default, Clone)]
#[serde(rename_all = "camelCase")]
pub struct Stats { pub root: String, pub files: i64, pub chunks: i64, pub embedded: i64, pub model: Option<String>, pub dim: Option<i64>, pub db_bytes: u64 }

static VEC_INIT: Once = Once::new();
fn register_vec() {
    VEC_INIT.call_once(|| unsafe {
        #[allow(clippy::missing_transmute_annotations)]
        rusqlite::ffi::sqlite3_auto_extension(Some(std::mem::transmute(sqlite_vec::sqlite3_vec_init as *const ())));
    });
}

/// Separate CJK characters with spaces so FTS5's unicode61 tokenizer indexes them one by one;
/// a phrase query over the same transform then matches CJK substrings.
pub fn fts_prep(s: &str) -> String {
    let mut out = String::with_capacity(s.len() + 16);
    for c in s.chars() {
        let cjk = matches!(c as u32, 0x3040..=0x30ff | 0x3400..=0x4dbf | 0x4e00..=0x9fff | 0xac00..=0xd7af | 0xf900..=0xfaff);
        if cjk { out.push(' '); out.push(c); out.push(' '); } else { out.push(c); }
    }
    out
}

/// Turn free text into a safe FTS5 query: quoted terms OR-ed (CJK runs become phrases).
pub fn fts_query(q: &str) -> Option<String> {
    let mut terms = Vec::new();
    for raw in q.split(|c: char| c.is_whitespace() || ",.;:!?()[]{}\"'`*#".contains(c)) {
        let t = raw.trim();
        if t.is_empty() { continue; }
        let p = fts_prep(t);
        let p = p.split_whitespace().collect::<Vec<_>>().join(" ");
        terms.push(format!("\"{}\"", p.replace('"', "")));
    }
    if terms.is_empty() { None } else { Some(terms.join(" OR ")) }
}

fn rel_of(root: &Path, p: &Path) -> String {
    p.strip_prefix(root).unwrap_or(p).to_string_lossy().replace('\\', "/")
}

pub struct Index { conn: Connection, pub root: PathBuf, db_path: PathBuf }

fn vec_bytes(v: &[f32]) -> Vec<u8> { v.iter().flat_map(|f| f.to_le_bytes()).collect() }

fn excluded(rel: &str, abs: &str, excludes: &[String]) -> bool {
    excludes.iter().map(|e| e.trim().trim_end_matches(['/', '\\']).replace('\\', "/")).filter(|e| !e.is_empty()).any(|e| {
        let e = e.trim_start_matches("./");
        let hit = |p: &str| p == e || p.starts_with(&format!("{e}/"));
        hit(rel) || hit(&abs.replace('\\', "/"))
    })
}

impl Index {
    pub fn open(root: &Path, db_path: &Path) -> Result<Index, String> {
        register_vec();
        if let Some(d) = db_path.parent() { std::fs::create_dir_all(d).map_err(|e| e.to_string())?; }
        let conn = Connection::open(db_path).map_err(|e| e.to_string())?;
        conn.execute_batch(
            "PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL; PRAGMA foreign_keys=ON;
             CREATE TABLE IF NOT EXISTS meta(k TEXT PRIMARY KEY, v TEXT);
             CREATE TABLE IF NOT EXISTS files(path TEXT PRIMARY KEY, mtime INTEGER, size INTEGER, hash TEXT, title TEXT);
             CREATE TABLE IF NOT EXISTS chunks(id INTEGER PRIMARY KEY, path TEXT NOT NULL REFERENCES files(path) ON DELETE CASCADE,
               heading TEXT, anchor TEXT, line_start INTEGER, line_end INTEGER, hash TEXT, text TEXT, embedded INTEGER DEFAULT 0);
             CREATE INDEX IF NOT EXISTS chunks_path ON chunks(path);
             CREATE INDEX IF NOT EXISTS chunks_pending ON chunks(embedded);
             CREATE VIRTUAL TABLE IF NOT EXISTS chunks_fts USING fts5(body, tokenize='unicode61 remove_diacritics 2');",
        ).map_err(|e| e.to_string())?;
        Ok(Index { conn, root: root.to_path_buf(), db_path: db_path.to_path_buf() })
    }

    fn meta(&self, k: &str) -> Option<String> {
        self.conn.query_row("SELECT v FROM meta WHERE k=?", [k], |r| r.get(0)).optional().ok().flatten()
    }
    fn set_meta(&self, k: &str, v: &str) -> rusqlite::Result<usize> {
        self.conn.execute("INSERT INTO meta(k,v) VALUES(?,?) ON CONFLICT(k) DO UPDATE SET v=excluded.v", [k, v])
    }

    fn rel(&self, p: &Path) -> String { rel_of(&self.root, p) }

    fn walk(&self, dir: &Path, excludes: &[String], out: &mut Vec<PathBuf>, skipped: &mut usize) {
        let Ok(rd) = std::fs::read_dir(dir) else { return };
        for e in rd.flatten() {
            let p = e.path();
            let name = e.file_name().to_string_lossy().to_string();
            if name.starts_with('.') || name == "node_modules" || name.ends_with(".assets") { continue; }
            let rel = self.rel(&p);
            if excluded(&rel, &p.to_string_lossy(), excludes) { *skipped += 1; continue; }
            let Ok(ft) = e.file_type() else { continue };
            if ft.is_dir() { self.walk(&p, excludes, out, skipped); }
            else if ft.is_file() && p.extension().map(|x| EXTS.contains(&x.to_string_lossy().to_lowercase().as_str())).unwrap_or(false) { out.push(p); }
        }
    }

    /// Incremental scan. `only`: restrict to these paths (watch events); files under excluded
    /// prefixes are dropped from the index. Unchanged chunks (same hash) keep their vectors.
    pub fn scan(&mut self, excludes: &[String], only: Option<&[String]>) -> Result<ScanReport, String> {
        let mut rep = ScanReport::default();
        let mut files = Vec::new();
        match only {
            None => self.walk(&self.root.clone(), excludes, &mut files, &mut rep.skipped_excluded),
            Some(list) => for p in list {
                let pb = PathBuf::from(p);
                if !pb.starts_with(&self.root) { continue; }
                if excluded(&rel_of(&self.root, &pb), p, excludes) { rep.skipped_excluded += 1; continue; }
                files.push(pb);
            },
        }
        let root = self.root.clone();
        let tx = self.conn.transaction().map_err(|e| e.to_string())?;
        let known: HashMap<String, (i64, i64, String)> = {
            let mut st = tx.prepare("SELECT path, mtime, size, hash FROM files").map_err(|e| e.to_string())?;
            let rows = st.query_map([], |r| Ok((r.get::<_, String>(0)?, (r.get(1)?, r.get(2)?, r.get(3)?)))).map_err(|e| e.to_string())?;
            rows.flatten().collect()
        };
        let mut seen = HashSet::new();
        for f in &files {
            let key = f.to_string_lossy().to_string();
            let Ok(md) = std::fs::metadata(f) else {
                // deleted (watch event) → drop below
                continue;
            };
            if !md.is_file() || md.len() > MAX_FILE { continue; }
            seen.insert(key.clone());
            rep.files += 1;
            let mtime = md.modified().ok().and_then(|t| t.duration_since(UNIX_EPOCH).ok()).map(|d| d.as_millis() as i64).unwrap_or(0);
            let size = md.len() as i64;
            if let Some((m, s, _)) = known.get(&key) { if *m == mtime && *s == size { continue; } }
            let Ok(src) = std::fs::read_to_string(f) else { continue };
            let fhash = chunk::hash_hex(&src);
            if let Some((_, _, h)) = known.get(&key) {
                if *h == fhash { tx.execute("UPDATE files SET mtime=?, size=? WHERE path=?", params![mtime, size, key]).map_err(|e| e.to_string())?; continue; }
            }
            rep.changed_files += 1;
            let doc = chunk::chunk_markdown(&src);
            tx.execute("INSERT INTO files(path,mtime,size,hash,title) VALUES(?,?,?,?,?) ON CONFLICT(path) DO UPDATE SET mtime=excluded.mtime,size=excluded.size,hash=excluded.hash,title=excluded.title",
                params![key, mtime, size, fhash, doc.title]).map_err(|e| e.to_string())?;
            // chunk-level diff by hash
            let mut old: HashMap<String, Vec<i64>> = HashMap::new();
            {
                let mut st = tx.prepare("SELECT id, hash FROM chunks WHERE path=?").map_err(|e| e.to_string())?;
                for r in st.query_map([&key], |r| Ok((r.get::<_, i64>(0)?, r.get::<_, String>(1)?))).map_err(|e| e.to_string())?.flatten() {
                    old.entry(r.1).or_default().push(r.0);
                }
            }
            for c in &doc.chunks {
                if let Some(id) = old.get_mut(&c.hash).and_then(|v| v.pop()) {
                    tx.execute("UPDATE chunks SET line_start=?, line_end=?, anchor=? WHERE id=?", params![c.line_start as i64, c.line_end as i64, c.anchor, id]).map_err(|e| e.to_string())?;
                    rep.kept_chunks += 1;
                    continue;
                }
                tx.execute("INSERT INTO chunks(path,heading,anchor,line_start,line_end,hash,text,embedded) VALUES(?,?,?,?,?,?,?,0)",
                    params![key, c.heading, c.anchor, c.line_start as i64, c.line_end as i64, c.hash, c.text]).map_err(|e| e.to_string())?;
                let id = tx.last_insert_rowid();
                let title = doc.title.clone().unwrap_or_default();
                tx.execute("INSERT INTO chunks_fts(rowid, body) VALUES(?, ?)", params![id, fts_prep(&format!("{}\n{}\n{}\n{}", rel_of(&root, f), title, c.heading, c.text))]).map_err(|e| e.to_string())?;
                rep.added_chunks += 1;
            }
            for ids in old.values() { for id in ids { Self::delete_chunk(&tx, *id)?; rep.removed_chunks += 1; } }
        }
        // removed files (full scan: everything not seen; targeted: listed paths that vanished or are excluded)
        let gone: Vec<String> = match only {
            None => known.keys().filter(|k| !seen.contains(*k)).cloned().collect(),
            Some(list) => list.iter().filter(|p| known.contains_key(*p) && !seen.contains(*p)).cloned().collect(),
        };
        for p in gone {
            let ids: Vec<i64> = { let mut st = tx.prepare("SELECT id FROM chunks WHERE path=?").map_err(|e| e.to_string())?; let v = st.query_map([&p], |r| r.get(0)).map_err(|e| e.to_string())?.flatten().collect(); v };
            for id in ids { Self::delete_chunk(&tx, id)?; rep.removed_chunks += 1; }
            tx.execute("DELETE FROM files WHERE path=?", [&p]).map_err(|e| e.to_string())?;
            rep.removed_files += 1;
        }
        tx.commit().map_err(|e| e.to_string())?;
        rep.pending = self.conn.query_row("SELECT count(*) FROM chunks WHERE embedded=0", [], |r| r.get::<_, i64>(0)).unwrap_or(0) as usize;
        Ok(rep)
    }

    fn delete_chunk(tx: &rusqlite::Transaction, id: i64) -> Result<(), String> {
        tx.execute("DELETE FROM chunks_fts WHERE rowid=?", [id]).map_err(|e| e.to_string())?;
        if tx.query_row("SELECT 1 FROM sqlite_master WHERE name='chunks_vec'", [], |_| Ok(())).optional().ok().flatten().is_some() {
            tx.execute("DELETE FROM chunks_vec WHERE rowid=?", [id]).map_err(|e| e.to_string())?;
        }
        tx.execute("DELETE FROM chunks WHERE id=?", [id]).map_err(|e| e.to_string())?;
        Ok(())
    }

    /// Chunks without a vector, with the text to embed ("path › heading" prefix + text).
    pub fn pending(&self, limit: usize) -> Result<Vec<PendingChunk>, String> {
        let mut st = self.conn.prepare("SELECT c.id, c.path, c.heading, c.text, f.title FROM chunks c JOIN files f ON f.path=c.path WHERE c.embedded=0 ORDER BY c.id LIMIT ?").map_err(|e| e.to_string())?;
        let rows = st.query_map([limit as i64], |r| Ok((r.get::<_, i64>(0)?, r.get::<_, String>(1)?, r.get::<_, String>(2)?, r.get::<_, String>(3)?, r.get::<_, Option<String>>(4)?))).map_err(|e| e.to_string())?;
        Ok(rows.flatten().map(|(id, path, heading, text, title)| {
            let rel = self.rel(Path::new(&path));
            let ctx = [Some(rel), title, Some(heading)].into_iter().flatten().filter(|s| !s.is_empty()).collect::<Vec<_>>().join(" › ");
            PendingChunk { id, input: format!("{ctx}\n\n{text}") }
        }).collect())
    }

    /// Store vectors. A different model or dimension than the index has drops all vectors first
    /// (full re-embed), so one index never mixes embedding spaces.
    pub fn put_vectors(&mut self, model: &str, items: &[(i64, Vec<f32>)]) -> Result<usize, String> {
        let Some(dim) = items.first().map(|(_, v)| v.len()) else { return Ok(0) };
        if dim == 0 || items.iter().any(|(_, v)| v.len() != dim) { return Err("inconsistent vector dimensions".into()); }
        let cur = (self.meta("model"), self.meta("dim").and_then(|d| d.parse::<usize>().ok()));
        if cur.0.as_deref() != Some(model) || cur.1 != Some(dim) {
            self.conn.execute_batch("DROP TABLE IF EXISTS chunks_vec; UPDATE chunks SET embedded=0;").map_err(|e| e.to_string())?;
            self.conn.execute_batch(&format!("CREATE VIRTUAL TABLE chunks_vec USING vec0(embedding float[{dim}] distance_metric=cosine)")).map_err(|e| e.to_string())?;
            self.set_meta("model", model).map_err(|e| e.to_string())?;
            self.set_meta("dim", &dim.to_string()).map_err(|e| e.to_string())?;
        }
        let tx = self.conn.transaction().map_err(|e| e.to_string())?;
        let mut n = 0;
        for (id, v) in items {
            let exists: bool = tx.query_row("SELECT 1 FROM chunks WHERE id=?", [id], |_| Ok(())).optional().map_err(|e| e.to_string())?.is_some();
            if !exists { continue; }
            tx.execute("DELETE FROM chunks_vec WHERE rowid=?", [id]).map_err(|e| e.to_string())?;
            tx.execute("INSERT INTO chunks_vec(rowid, embedding) VALUES(?, ?)", params![id, vec_bytes(v)]).map_err(|e| e.to_string())?;
            tx.execute("UPDATE chunks SET embedded=1 WHERE id=?", [id]).map_err(|e| e.to_string())?;
            n += 1;
        }
        tx.commit().map_err(|e| e.to_string())?;
        Ok(n)
    }

    pub fn model(&self) -> Option<String> { self.meta("model") }

    fn hit(&self, id: i64) -> Option<Hit> {
        self.conn.query_row("SELECT path, heading, anchor, line_start, line_end, text FROM chunks WHERE id=?", [id], |r| {
            let path: String = r.get(0)?;
            Ok(Hit { id, rel: self.rel(Path::new(&path)), path, heading: r.get(1)?, anchor: r.get(2)?, line_start: r.get(3)?, line_end: r.get(4)?, text: r.get(5)?, score: 0.0, via: vec![] })
        }).optional().ok().flatten()
    }

    fn knn(&self, v: &[f32], k: usize) -> Vec<(i64, f64)> {
        let Some(dim) = self.meta("dim").and_then(|d| d.parse::<usize>().ok()) else { return vec![] };
        if dim != v.len() { return vec![]; }
        let Ok(mut st) = self.conn.prepare("SELECT rowid, distance FROM chunks_vec WHERE embedding MATCH ? AND k = ? ORDER BY distance") else { return vec![] };
        st.query_map(params![vec_bytes(v), k as i64], |r| Ok((r.get(0)?, r.get(1)?))).map(|it| it.flatten().collect()).unwrap_or_default()
    }

    /// Hybrid search: FTS5 BM25 and vector kNN, fused with reciprocal rank fusion (k = 60).
    pub fn search(&self, query: &str, vector: Option<&[f32]>, k: usize, path_prefix: Option<&str>) -> Result<Vec<Hit>, String> {
        self.search_opts(query, vector, k, path_prefix, 0.8)
    }

    /// `max_distance`: cosine distance cut-off for vector hits (kNN always returns neighbours,
    /// even unrelated ones); keyword hits are not affected.
    pub fn search_opts(&self, query: &str, vector: Option<&[f32]>, k: usize, path_prefix: Option<&str>, max_distance: f64) -> Result<Vec<Hit>, String> {
        let depth = (k * 4).max(20);
        let mut fused: HashMap<i64, (f64, Vec<String>)> = HashMap::new();
        if let Some(q) = fts_query(query) {
            let mut st = self.conn.prepare("SELECT rowid FROM chunks_fts WHERE chunks_fts MATCH ? ORDER BY bm25(chunks_fts) LIMIT ?").map_err(|e| e.to_string())?;
            let ids: Vec<i64> = st.query_map(params![q, depth as i64], |r| r.get(0)).map_err(|e| e.to_string())?.flatten().collect();
            for (rank, id) in ids.into_iter().enumerate() {
                let e = fused.entry(id).or_insert((0.0, vec![]));
                e.0 += 1.0 / (60.0 + rank as f64 + 1.0);
                e.1.push("fts".into());
            }
        }
        if let Some(v) = vector {
            for (rank, (id, _dist)) in self.knn(v, depth).into_iter().filter(|(_, d)| *d <= max_distance).enumerate() {
                let e = fused.entry(id).or_insert((0.0, vec![]));
                e.0 += 1.0 / (60.0 + rank as f64 + 1.0);
                e.1.push("vec".into());
            }
        }
        let mut list: Vec<(i64, f64, Vec<String>)> = fused.into_iter().map(|(id, (s, via))| (id, s, via)).collect();
        list.sort_by(|a, b| b.1.partial_cmp(&a.1).unwrap_or(std::cmp::Ordering::Equal).then(a.0.cmp(&b.0)));
        let mut out = Vec::new();
        for (id, score, via) in list {
            if let Some(mut h) = self.hit(id) {
                if let Some(pre) = path_prefix { if !h.path.starts_with(pre) && !h.rel.starts_with(pre) { continue; } }
                h.score = score; h.via = via;
                out.push(h);
                if out.len() >= k { break; }
            }
        }
        Ok(out)
    }

    /// Notes related to `path`: kNN on the mean of its chunk vectors, other files only, best chunk per file.
    pub fn related(&self, path: &str, k: usize) -> Result<Vec<Hit>, String> {
        let Ok(mut st) = self.conn.prepare("SELECT v.embedding FROM chunks_vec v JOIN chunks c ON c.id=v.rowid WHERE c.path=?") else { return Ok(vec![]) };
        let vecs: Vec<Vec<u8>> = st.query_map([path], |r| r.get(0)).map_err(|e| e.to_string())?.flatten().collect();
        if vecs.is_empty() { return Ok(vec![]); }
        let dim = vecs[0].len() / 4;
        let mut mean = vec![0f32; dim];
        for b in &vecs { for (i, c) in b.chunks_exact(4).enumerate() { mean[i] += f32::from_le_bytes([c[0], c[1], c[2], c[3]]); } }
        let mut seen = HashSet::new();
        let mut out = Vec::new();
        for (id, dist) in self.knn(&mean, (k * 6).max(30)) {
            if let Some(mut h) = self.hit(id) {
                if h.path == path || !seen.insert(h.path.clone()) { continue; }
                h.score = 1.0 - dist; h.via = vec!["vec".into()];
                out.push(h);
                if out.len() >= k { break; }
            }
        }
        Ok(out)
    }

    pub fn stats(&self) -> Stats {
        let q = |sql: &str| self.conn.query_row(sql, [], |r| r.get::<_, i64>(0)).unwrap_or(0);
        let wal = PathBuf::from(format!("{}-wal", self.db_path.display()));
        Stats {
            root: self.root.to_string_lossy().to_string(), files: q("SELECT count(*) FROM files"), chunks: q("SELECT count(*) FROM chunks"),
            embedded: q("SELECT count(*) FROM chunks WHERE embedded=1"), model: self.meta("model"), dim: self.meta("dim").and_then(|d| d.parse().ok()),
            db_bytes: std::fs::metadata(&self.db_path).map(|m| m.len()).unwrap_or(0) + std::fs::metadata(wal).map(|m| m.len()).unwrap_or(0),
        }
    }

    pub fn clear(&mut self) -> Result<(), String> {
        self.conn.execute_batch("DELETE FROM chunks_fts; DROP TABLE IF EXISTS chunks_vec; DELETE FROM chunks; DELETE FROM files; DELETE FROM meta;").map_err(|e| e.to_string())
    }
}

// ---------- open indexes, keyed by workspace root ----------

fn indexes() -> &'static Mutex<HashMap<PathBuf, std::sync::Arc<Mutex<Index>>>> {
    static M: OnceLock<Mutex<HashMap<PathBuf, std::sync::Arc<Mutex<Index>>>>> = OnceLock::new();
    M.get_or_init(Default::default)
}

pub fn db_path_for(data_dir: &Path, root: &Path) -> PathBuf {
    data_dir.join("library").join(format!("{}.sqlite", chunk::hash_hex(&root.to_string_lossy())))
}

pub fn get(data_dir: &Path, root: &str) -> Result<std::sync::Arc<Mutex<Index>>, String> {
    let root = PathBuf::from(root);
    if !root.is_absolute() || !root.is_dir() { return Err("workspace root must be an existing absolute folder".into()); }
    let root = root.canonicalize().unwrap_or(root);
    let mut m = indexes().lock().unwrap();
    if let Some(i) = m.get(&root) { return Ok(i.clone()); }
    let idx = std::sync::Arc::new(Mutex::new(Index::open(&root, &db_path_for(data_dir, &root))?));
    m.insert(root, idx.clone());
    Ok(idx)
}

/// One JSON request → JSON response. Shared by the Tauri commands and the dev/test CLI (`kb-cli`).
pub fn dispatch(data_dir: &Path, req: serde_json::Value) -> Result<serde_json::Value, String> {
    let op = req.get("op").and_then(|v| v.as_str()).ok_or("missing op")?;
    let root = req.get("root").and_then(|v| v.as_str()).ok_or("missing root")?;
    let idx = get(data_dir, root)?;
    let mut idx = idx.lock().map_err(|_| "index lock poisoned")?;
    let strs = |k: &str| -> Vec<String> { req.get(k).and_then(|v| v.as_array()).map(|a| a.iter().filter_map(|x| x.as_str().map(String::from)).collect()).unwrap_or_default() };
    fn to_json<T: Serialize>(v: &T) -> Result<serde_json::Value, String> { serde_json::to_value(v).map_err(|e| e.to_string()) }
    match op {
        "scan" => {
            let only = req.get("paths").and_then(|v| v.as_array()).map(|_| strs("paths"));
            to_json(&idx.scan(&strs("exclude"), only.as_deref())?)
        }
        "pending" => to_json(&idx.pending(req.get("limit").and_then(|v| v.as_u64()).unwrap_or(32).min(512) as usize)?),
        "putVectors" => {
            let model = req.get("model").and_then(|v| v.as_str()).ok_or("missing model")?;
            let items: Vec<(i64, Vec<f32>)> = serde_json::from_value(req.get("items").cloned().unwrap_or_default()).map_err(|e| e.to_string())?;
            Ok(serde_json::json!(idx.put_vectors(model, &items)?))
        }
        "search" => {
            let vector: Option<Vec<f32>> = req.get("vector").and_then(|v| serde_json::from_value(v.clone()).ok());
            let k = req.get("k").and_then(|v| v.as_u64()).unwrap_or(8).min(50) as usize;
            let maxd = req.get("maxDistance").and_then(|v| v.as_f64()).unwrap_or(0.8);
            to_json(&idx.search_opts(req.get("query").and_then(|v| v.as_str()).unwrap_or(""), vector.as_deref(), k, req.get("pathPrefix").and_then(|v| v.as_str()), maxd)?)
        }
        "related" => to_json(&idx.related(req.get("path").and_then(|v| v.as_str()).ok_or("missing path")?, req.get("k").and_then(|v| v.as_u64()).unwrap_or(5).min(20) as usize)?),
        "stats" => to_json(&idx.stats()),
        "model" => Ok(serde_json::json!(idx.model())),
        "clear" => { idx.clear()?; Ok(serde_json::Value::Null) }
        _ => Err(format!("unknown op {op}")),
    }
}

#[cfg(test)]
mod tests;
