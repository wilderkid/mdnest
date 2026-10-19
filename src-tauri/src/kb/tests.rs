use super::*;
use std::fs;

fn ws(name: &str) -> (PathBuf, PathBuf) {
    let base = std::env::temp_dir().join(format!("mdnest-kb-{}-{}", name, std::process::id()));
    let _ = fs::remove_dir_all(&base);
    let root = base.join("ws");
    fs::create_dir_all(root.join("notes")).unwrap();
    fs::create_dir_all(root.join("private")).unwrap();
    fs::write(root.join("cats.md"), "# Cats\n\nCats purr and sleep a lot.\n\n## Food\n\nCats eat fish.\n").unwrap();
    fs::write(root.join("notes/rust.md"), "# Rust\n\nOwnership and borrowing keep memory safe.\n").unwrap();
    fs::write(root.join("notes/中文.md"), "# 笔记\n\n向量数据库可以做语义搜索。\n").unwrap();
    fs::write(root.join("private/secret.md"), "# Secret\n\nThe vault code is 1234.\n").unwrap();
    fs::write(root.join("image.png"), "nope").unwrap();
    (base.join("data"), root)
}

/// toy embedding: bag of 3 topic words → unit vector
fn emb(t: &str) -> Vec<f32> {
    let t = t.to_lowercase();
    let v = vec![t.matches("cat").count() as f32 + 0.01, (t.matches("rust").count() + t.matches("memory").count()) as f32 + 0.01, t.matches("向量").count() as f32 + 0.01];
    let n = v.iter().map(|x| x * x).sum::<f32>().sqrt();
    v.into_iter().map(|x| x / n).collect()
}

fn embed_all(idx: &mut Index, model: &str) -> usize {
    let p = idx.pending(100).unwrap();
    let items: Vec<_> = p.iter().map(|c| (c.id, emb(&c.input))).collect();
    idx.put_vectors(model, &items).unwrap()
}

#[test]
fn fts5_and_vec_available() {
    register_vec();
    let c = Connection::open_in_memory().unwrap();
    c.execute_batch("CREATE VIRTUAL TABLE f USING fts5(x); CREATE VIRTUAL TABLE v USING vec0(e float[2]);").unwrap();
    let ver: String = c.query_row("SELECT vec_version()", [], |r| r.get(0)).unwrap();
    assert!(ver.starts_with('v'));
}

#[test]
fn scan_excludes_and_incremental() {
    let (data, root) = ws("scan");
    let mut idx = Index::open(&root, &db_path_for(&data, &root)).unwrap();
    let r = idx.scan(&["private".into()], None).unwrap();
    assert_eq!((r.files, r.changed_files, r.skipped_excluded), (3, 3, 1), "{r:?}");
    assert_eq!(r.added_chunks, 4);
    assert_eq!(r.pending, 4);
    assert_eq!(embed_all(&mut idx, "toy"), 4);
    // nothing changed → nothing to do
    let r2 = idx.scan(&["private".into()], None).unwrap();
    assert_eq!((r2.changed_files, r2.added_chunks, r2.removed_chunks, r2.pending), (0, 0, 0, 0), "{r2:?}");
    // edit one section: only that chunk is re-embedded, the other keeps its vector
    std::thread::sleep(std::time::Duration::from_millis(20));
    fs::write(root.join("cats.md"), "# Cats\n\nCats purr and sleep a lot.\n\n## Food\n\nCats eat fish and chicken.\n").unwrap();
    let r3 = idx.scan(&["private".into()], None).unwrap();
    assert_eq!((r3.changed_files, r3.added_chunks, r3.removed_chunks, r3.kept_chunks, r3.pending), (1, 1, 1, 1, 1), "{r3:?}");
    // delete a file; exclude is applied to targeted (watch) scans too
    fs::remove_file(root.join("notes/rust.md")).unwrap();
    let r4 = idx.scan(&[], Some(&[root.join("notes/rust.md").to_string_lossy().to_string(), root.join("private/secret.md").to_string_lossy().to_string()])).unwrap();
    assert_eq!(r4.removed_files, 1);
    assert_eq!(r4.skipped_excluded, 0, "no exclude list → secret.md is indexed by a targeted scan");
    let r5 = idx.scan(&["private/".into()], None).unwrap();
    assert_eq!(r5.removed_files, 1, "newly excluded folder is dropped from the index: {r5:?}");
    let s = idx.stats();
    assert_eq!(s.files, 2);
    assert!(idx.search("vault", None, 5, None).unwrap().is_empty(), "excluded content not searchable");
    fs::remove_dir_all(root.parent().unwrap()).ok();
}

#[test]
fn hybrid_search_rrf_lines_and_cjk() {
    let (data, root) = ws("search");
    let mut idx = Index::open(&root, &db_path_for(&data, &root)).unwrap();
    idx.scan(&["private".into()], None).unwrap();
    embed_all(&mut idx, "toy");
    // keyword only
    let h = idx.search("fish", None, 5, None).unwrap();
    assert_eq!(h[0].rel, "cats.md");
    assert_eq!((h[0].heading.as_str(), h[0].line_start, h[0].line_end), ("Cats > Food", 5, 7));
    assert_eq!(h[0].via, vec!["fts"]);
    // vector only (query words absent from text)
    let h = idx.search("zzz", Some(&emb("memory")), 3, None).unwrap();
    assert_eq!(h[0].rel, "notes/rust.md");
    assert_eq!(h[0].via, vec!["vec"]);
    // both → fused, found by both routes ranks first
    let h = idx.search("ownership", Some(&emb("rust memory")), 3, None).unwrap();
    assert_eq!(h[0].rel, "notes/rust.md");
    assert_eq!(h[0].via, vec!["fts", "vec"]);
    // CJK substring
    let h = idx.search("语义", None, 3, None).unwrap();
    assert_eq!(h.len(), 1);
    assert!(h[0].rel.ends_with("中文.md"));
    // path filter + related notes
    assert!(idx.search("cats", Some(&emb("cat")), 5, Some("notes/")).unwrap().iter().all(|x| x.rel.starts_with("notes/")));
    let rel = idx.related(&root.join("cats.md").to_string_lossy(), 3).unwrap();
    assert!(!rel.is_empty() && rel.iter().all(|x| x.rel != "cats.md"));
    // model change → all vectors dropped, everything pending again
    let n = idx.put_vectors("other", &[(h[0].id, vec![1.0, 0.0])]).unwrap();
    assert_eq!(n, 1);
    assert_eq!(idx.stats().dim, Some(2));
    assert_eq!(idx.pending(100).unwrap().len(), 3);
    assert!(idx.pending(1).unwrap()[0].input.contains(" › "), "input carries path/heading context");
    fs::remove_dir_all(root.parent().unwrap()).ok();
}

#[test]
fn dispatch_json_and_queries() {
    let (data, root) = ws("dispatch");
    let r = dispatch(&data, serde_json::json!({"op": "scan", "root": root.to_string_lossy(), "exclude": ["private"]})).unwrap();
    assert_eq!(r["addedChunks"], 4);
    let s = dispatch(&data, serde_json::json!({"op": "search", "root": root.to_string_lossy(), "query": "purr \"sleep\" (x) OR*", "k": 2})).unwrap();
    assert_eq!(s[0]["rel"], "cats.md");
    assert!(dispatch(&data, serde_json::json!({"op": "scan", "root": "relative/path"})).is_err());
    assert_eq!(fts_query("  "), None);
    assert_eq!(fts_query("向量 db").unwrap(), "\"向 量\" OR \"db\"");
    fs::remove_dir_all(root.parent().unwrap()).ok();
}
