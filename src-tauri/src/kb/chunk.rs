//! Heading-aware Markdown chunking. Line based (no full parse): headings split sections, each chunk
//! carries its heading path ("A > B > C"), 1-based start/end lines and a content hash. Fenced code,
//! $$ math blocks and tables are never cut in the middle (an oversized one is split by lines only
//! when it alone exceeds the hard limit). Front matter is skipped; its `title:` becomes metadata.

use std::hash::Hasher;

/// Target and hard upper size of a chunk, in characters (~4 chars per token → ~400 / ~900 tokens).
pub const TARGET: usize = 1600;
pub const HARD: usize = 3600;

#[derive(Debug, Clone, PartialEq)]
pub struct Chunk {
    pub heading: String,
    pub anchor: String,
    pub line_start: usize,
    pub line_end: usize,
    pub text: String,
    pub hash: String,
}

#[derive(Debug, Default)]
pub struct Doc {
    pub title: Option<String>,
    pub chunks: Vec<Chunk>,
}

/// FNV-1a 64 → 16 hex chars. Stable across runs and platforms (unlike DefaultHasher).
pub fn hash_hex(s: &str) -> String {
    struct Fnv(u64);
    impl Hasher for Fnv {
        fn finish(&self) -> u64 { self.0 }
        fn write(&mut self, bytes: &[u8]) {
            for b in bytes { self.0 ^= *b as u64; self.0 = self.0.wrapping_mul(0x100000001b3); }
        }
    }
    let mut h = Fnv(0xcbf29ce484222325);
    h.write(s.as_bytes());
    format!("{:016x}", h.finish())
}

pub fn slug(s: &str) -> String {
    let mut out = String::new();
    for c in s.trim().chars() {
        if c.is_alphanumeric() { out.extend(c.to_lowercase()); }
        else if (c == ' ' || c == '-' || c == '_') && !out.ends_with('-') { out.push('-'); }
    }
    out.trim_matches('-').to_string()
}

fn atx_heading(line: &str) -> Option<(usize, String)> {
    let t = line.trim_start_matches(' ');
    if line.len() - t.len() > 3 { return None; }
    let level = t.bytes().take_while(|b| *b == b'#').count();
    if level == 0 || level > 6 { return None; }
    let rest = &t[level..];
    if !rest.is_empty() && !rest.starts_with(' ') && !rest.starts_with('\t') { return None; }
    let mut text = rest.trim();
    // closing #s
    let stripped = text.trim_end_matches('#');
    if stripped.len() != text.len() && (stripped.is_empty() || stripped.ends_with(' ')) { text = stripped.trim_end(); }
    Some((level, text.to_string()))
}

fn fence_open(line: &str) -> Option<(char, usize)> {
    let t = line.trim_start();
    if line.len() - t.len() > 3 { return None; }
    let c = t.chars().next()?;
    if c != '`' && c != '~' { return None; }
    let n = t.chars().take_while(|x| *x == c).count();
    if n >= 3 { Some((c, n)) } else { None }
}

/// A block of consecutive lines that must stay together (paragraph, list run, fence, table, math).
struct Block { start: usize, end: usize, text: String, heading: Option<(usize, String)> }

fn blocks(lines: &[&str], first: usize) -> Vec<Block> {
    let mut out = Vec::new();
    let mut i = 0;
    while i < lines.len() {
        let line = lines[i];
        if line.trim().is_empty() { i += 1; continue; }
        if let Some(h) = atx_heading(line) {
            out.push(Block { start: first + i, end: first + i, text: line.to_string(), heading: Some(h) });
            i += 1;
            continue;
        }
        let start = i;
        if let Some((c, n)) = fence_open(line) {
            i += 1;
            while i < lines.len() {
                let t = lines[i].trim_start();
                if t.starts_with(&c.to_string().repeat(n)) && t.trim_start_matches(c).trim().is_empty() { i += 1; break; }
                i += 1;
            }
        } else if line.trim_start().starts_with("$$") {
            let single = line.trim().len() > 2 && line.trim().ends_with("$$") && line.trim() != "$$";
            i += 1;
            if !single {
                while i < lines.len() { let done = lines[i].trim_end().ends_with("$$"); i += 1; if done { break; } }
            }
        } else {
            // paragraph / list / table / quote: until a blank line, a heading or a fence
            i += 1;
            while i < lines.len() && !lines[i].trim().is_empty() && atx_heading(lines[i]).is_none() && fence_open(lines[i]).is_none() {
                // setext underline turns the paragraph into a heading
                i += 1;
            }
            // setext heading: one-line paragraph followed by === / ---
            let para = &lines[start..i];
            if para.len() == 2 {
                let u = para[1].trim();
                if !u.is_empty() && (u.chars().all(|c| c == '=') || (u.chars().all(|c| c == '-') && u.len() >= 2)) {
                    let level = if u.starts_with('=') { 1 } else { 2 };
                    out.push(Block { start: first + start, end: first + i - 1, text: para.join("\n"), heading: Some((level, para[0].trim().to_string())) });
                    continue;
                }
            }
        }
        out.push(Block { start: first + start, end: first + i - 1, text: lines[start..i].join("\n"), heading: None });
    }
    out
}

pub fn chunk_markdown(src: &str) -> Doc {
    let src = src.replace("\r\n", "\n");
    let lines: Vec<&str> = src.split('\n').collect();
    let mut doc = Doc::default();
    let mut first = 0;
    if lines.first().map(|l| l.trim_end() == "---").unwrap_or(false) {
        if let Some(end) = lines.iter().skip(1).position(|l| l.trim_end() == "---" || l.trim_end() == "...") {
            for l in &lines[1..end + 1] {
                if let Some(v) = l.strip_prefix("title:") { doc.title = Some(v.trim().trim_matches(|c| c == '"' || c == '\'').to_string()); }
            }
            first = end + 2;
        }
    }
    let body = if first <= lines.len() { &lines[first..] } else { &lines[0..0] };
    let mut path: Vec<(usize, String)> = Vec::new();
    let mut cur: Vec<&Block> = Vec::new();
    let all = blocks(body, first);
    let mut carry: Option<&Block> = None;

    fn heading_of(path: &[(usize, String)]) -> String { path.iter().map(|(_, t)| t.as_str()).collect::<Vec<_>>().join(" > ") }
    fn flush<'a>(cur: &mut Vec<&'a Block>, path: &[(usize, String)], doc: &mut Doc, carry: &mut Option<&'a Block>) {
        if !cur.iter().any(|b| b.heading.is_none()) { cur.clear(); return; }
        let text = cur.iter().map(|b| b.text.as_str()).collect::<Vec<_>>().join("\n\n");
        let heading = heading_of(path);
        let anchor = path.last().map(|(_, t)| slug(t)).unwrap_or_default();
        let hash = hash_hex(&format!("{heading}\n{text}"));
        doc.chunks.push(Chunk { heading, anchor, line_start: cur[0].start + 1, line_end: cur[cur.len() - 1].end + 1, text, hash });
        // overlap: the last block carries into the next chunk of the same section if it is small
        *carry = cur.last().copied().filter(|b| b.heading.is_none() && b.text.len() <= TARGET / 4);
        cur.clear();
    }

    for b in &all {
        if let Some((level, t)) = &b.heading {
            flush(&mut cur, &path, &mut doc, &mut carry);
            carry = None;
            while path.last().map(|(l, _)| *l >= *level).unwrap_or(false) { path.pop(); }
            path.push((*level, t.clone()));
            cur.push(b);
            continue;
        }
        let size: usize = cur.iter().map(|x| x.text.len() + 2).sum();
        if size + b.text.len() > TARGET && cur.iter().any(|x| x.heading.is_none()) {
            flush(&mut cur, &path, &mut doc, &mut carry);
            if let Some(c) = carry.take() { cur.push(c); }
        }
        if b.text.len() > HARD {
            // one oversized block (huge fence/table): split by lines, never mid-line
            flush(&mut cur, &path, &mut doc, &mut carry);
            carry = None;
            let ls: Vec<&str> = b.text.split('\n').collect();
            let mut s = 0;
            while s < ls.len() {
                let mut e = s; let mut n = 0;
                while e < ls.len() && (n == 0 || n + ls[e].len() < TARGET * 2) { n += ls[e].len() + 1; e += 1; }
                let text = ls[s..e].join("\n");
                let heading = heading_of(&path);
                let hash = hash_hex(&format!("{heading}\n{text}"));
                doc.chunks.push(Chunk { heading, anchor: path.last().map(|(_, t)| slug(t)).unwrap_or_default(), line_start: b.start + s + 1, line_end: b.start + e, text, hash });
                s = e;
            }
            continue;
        }
        cur.push(b);
    }
    flush(&mut cur, &path, &mut doc, &mut carry);
    doc
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn headings_paths_and_lines() {
        let d = chunk_markdown("# A\n\npara a\n\n## B\n\npara b1\npara b2\n\n### C\n\nc\n\n## D\n\nd\n");
        let h: Vec<_> = d.chunks.iter().map(|c| (c.heading.as_str(), c.line_start, c.line_end)).collect();
        assert_eq!(h, vec![("A", 1, 3), ("A > B", 5, 8), ("A > B > C", 10, 12), ("A > D", 14, 16)]);
        assert_eq!(d.chunks[1].anchor, "b");
        assert!(d.chunks[1].text.starts_with("## B\n\npara b1"));
    }

    #[test]
    fn fences_math_tables_stay_whole() {
        let fence = format!("```\n{}\n# not a heading\n```", "x\n".repeat(5));
        let src = format!("# T\n\n{}\n\n{fence}\n\n$$\na\n\nb\n$$\n\n| a | b |\n|---|---|\n| 1 | 2 |\n", "word ".repeat(300));
        let d = chunk_markdown(&src);
        assert!(d.chunks.iter().all(|c| c.heading == "T"), "fence content must not open a heading");
        let joined: Vec<_> = d.chunks.iter().map(|c| c.text.clone()).collect();
        assert!(joined.iter().any(|t| t.contains(&fence)), "fence kept intact");
        assert!(joined.iter().any(|t| t.contains("$$\na\n\nb\n$$")), "math kept intact");
        assert!(joined.iter().any(|t| t.contains("| a | b |\n|---|---|\n| 1 | 2 |")), "table intact");
    }

    #[test]
    fn size_split_with_overlap() {
        let para = |i: usize| format!("Paragraph {i} {}", "lorem ipsum ".repeat(30));
        let src = format!("# Big\n\n{}", (0..12).map(para).collect::<Vec<_>>().join("\n\n"));
        let d = chunk_markdown(&src);
        assert!(d.chunks.len() >= 3, "split into several chunks: {}", d.chunks.len());
        assert!(d.chunks.iter().all(|c| c.text.len() <= TARGET + 400 + 400));
        // overlap: the last paragraph of chunk k starts chunk k+1
        let last_para = d.chunks[0].text.rsplit("\n\n").next().unwrap();
        assert!(d.chunks[1].text.starts_with(last_para));
        assert!(d.chunks[1].line_start <= d.chunks[0].line_end);
    }

    #[test]
    fn front_matter_setext_and_hash() {
        let d = chunk_markdown("---\ntitle: \"My note\"\ntags: [a]\n---\nIntro\n=====\n\ntext\n\nSub\n---\n\nmore\n");
        assert_eq!(d.title.as_deref(), Some("My note"));
        let h: Vec<_> = d.chunks.iter().map(|c| (c.heading.as_str(), c.line_start)).collect();
        assert_eq!(h, vec![("Intro", 5), ("Intro > Sub", 10)]);
        let again = chunk_markdown("---\ntitle: x\n---\nIntro\n=====\n\ntext\n\nSub\n---\n\nmore\n");
        assert_eq!(d.chunks[0].hash, again.chunks[0].hash, "hash depends on content, not position");
        assert_eq!(hash_hex("abc"), "e71fa2190541574b");
    }

    #[test]
    fn oversized_block_split_by_lines() {
        let fence = format!("```\n{}```", "line of code here\n".repeat(400));
        let d = chunk_markdown(&format!("# Code\n\n{fence}\n"));
        assert!(d.chunks.len() >= 2);
        assert!(d.chunks.iter().all(|c| !c.text.is_empty()));
        assert_eq!(d.chunks[0].line_start, 3);
    }

    #[test]
    fn cjk_and_empty() {
        assert!(chunk_markdown("").chunks.is_empty());
        let d = chunk_markdown("# 标题\n\n中文内容。");
        assert_eq!(d.chunks[0].anchor, "标题");
    }
}
