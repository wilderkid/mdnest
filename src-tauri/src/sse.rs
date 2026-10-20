//! Small Server-Sent Events parser.
//!
//! Feeds arrive as arbitrary byte chunks (a line may be split across chunks).
//! The parser yields complete events. A `data` payload of `[DONE]` is reported
//! as a terminal marker so the HTTP client can close the stream.

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum SseItem {
    /// A dispatched event. `event` is `None` when the stream used the default name.
    Event { event: Option<String>, data: String },
    /// The conventional OpenAI terminator (`data: [DONE]`).
    Done,
}

#[derive(Debug, Default)]
pub struct SseParser {
    buf: Vec<u8>,
    data: Vec<String>,
    event: Option<String>,
    /// True once any field of the current event has been seen.
    have_fields: bool,
}

impl SseParser {
    pub fn new() -> Self {
        Self::default()
    }

    /// Push a chunk. `eof` flushes a trailing line that never received a newline.
    pub fn push(&mut self, chunk: &[u8], eof: bool) -> Vec<SseItem> {
        self.buf.extend_from_slice(chunk);
        let mut out = Vec::new();
        loop {
            let nl = self.buf.iter().position(|b| *b == b'\n');
            let Some(nl) = nl else {
                break;
            };
            let mut line: Vec<u8> = self.buf.drain(..=nl).collect();
            // drop the newline, and a preceding CR (CRLF)
            line.pop();
            if line.last() == Some(&b'\r') {
                line.pop();
            }
            if let Some(item) = self.feed_line(&line) {
                out.push(item);
            }
        }
        if eof && !self.buf.is_empty() {
            let rest = std::mem::take(&mut self.buf);
            if let Some(item) = self.feed_line(&rest) {
                out.push(item);
            }
        }
        if eof {
            if let Some(item) = self.dispatch() {
                out.push(item);
            }
        }
        out
    }

    fn feed_line(&mut self, line: &[u8]) -> Option<SseItem> {
        if line.is_empty() {
            return self.dispatch();
        }
        // Comment line. A line of only ":" still counts as a comment, not a dispatch.
        if line[0] == b':' {
            return None;
        }
        let (field, value) = split_field(line);
        let field = String::from_utf8_lossy(field);
        match field.as_ref() {
            "data" => {
                self.have_fields = true;
                self.data.push(String::from_utf8_lossy(value).into_owned());
            }
            "event" => {
                self.have_fields = true;
                let name = String::from_utf8_lossy(value).into_owned();
                if !name.is_empty() {
                    self.event = Some(name);
                }
            }
            // id / retry are ignored; unknown fields are ignored per the spec.
            _ => {}
        }
        None
    }

    fn dispatch(&mut self) -> Option<SseItem> {
        if !self.have_fields {
            self.event = None;
            self.data.clear();
            return None;
        }
        let data = std::mem::take(&mut self.data).join("\n");
        let event = self.event.take();
        self.have_fields = false;
        if data == "[DONE]" {
            return Some(SseItem::Done);
        }
        Some(SseItem::Event { event, data })
    }
}

/// `field:value` — one optional leading space is stripped from the value.
fn split_field(line: &[u8]) -> (&[u8], &[u8]) {
    match line.iter().position(|b| *b == b':') {
        Some(i) => {
            let mut value = &line[i + 1..];
            if value.first() == Some(&b' ') {
                value = &value[1..];
            }
            (&line[..i], value)
        }
        None => (line, b""),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn events(chunks: &[&[u8]]) -> Vec<SseItem> {
        let mut p = SseParser::new();
        let mut out = Vec::new();
        for (i, c) in chunks.iter().enumerate() {
            let eof = i + 1 == chunks.len();
            out.extend(p.push(c, eof));
        }
        out
    }

    #[test]
    fn data_lines_and_default_event() {
        let got = events(&[b"data: hello\n\n"]);
        assert_eq!(
            got,
            vec![SseItem::Event {
                event: None,
                data: "hello".into()
            }]
        );
    }

    #[test]
    fn multiline_data_joined_by_newline() {
        let raw = b"data: one\ndata: two\ndata:three\n\n";
        let got = events(&[raw]);
        assert_eq!(
            got,
            vec![SseItem::Event {
                event: None,
                data: "one\ntwo\nthree".into()
            }]
        );
    }

    #[test]
    fn named_event() {
        let raw = b"event: delta\ndata: {\"t\":1}\n\n";
        let got = events(&[raw]);
        assert_eq!(
            got,
            vec![SseItem::Event {
                event: Some("delta".into()),
                data: "{\"t\":1}".into()
            }]
        );
    }

    #[test]
    fn comments_are_ignored() {
        let raw = b": keep-alive\n: another\ndata: x\n\n";
        let got = events(&[raw]);
        assert_eq!(
            got,
            vec![SseItem::Event {
                event: None,
                data: "x".into()
            }]
        );
    }

    #[test]
    fn crlf() {
        let raw = b"event: ping\r\ndata: pong\r\n\r\n";
        let got = events(&[raw]);
        assert_eq!(
            got,
            vec![SseItem::Event {
                event: Some("ping".into()),
                data: "pong".into()
            }]
        );
    }

    #[test]
    fn chunk_boundary_splits_a_line() {
        let got = events(&[b"data: hel", b"lo\n\n"]);
        assert_eq!(
            got,
            vec![SseItem::Event {
                event: None,
                data: "hello".into()
            }]
        );
    }

    #[test]
    fn chunk_boundary_splits_crlf_and_blank_line() {
        let got = events(&[b"data: a\r", b"\n", b"data: b\r\n", b"\r\n"]);
        assert_eq!(
            got,
            vec![SseItem::Event {
                event: None,
                data: "a\nb".into()
            }]
        );
    }

    #[test]
    fn done_marker() {
        let got = events(&[b"data: [DONE]\n\n"]);
        assert_eq!(got, vec![SseItem::Done]);
    }

    #[test]
    fn done_after_real_event() {
        let raw = b"data: {\"a\":1}\n\ndata: [DONE]\n\n";
        let got = events(&[raw]);
        assert_eq!(
            got,
            vec![
                SseItem::Event {
                    event: None,
                    data: "{\"a\":1}".into()
                },
                SseItem::Done,
            ]
        );
    }

    #[test]
    fn several_events_across_chunks() {
        let got = events(&[b"data: a\n\nda", b"ta: b\n\n"]);
        assert_eq!(
            got,
            vec![
                SseItem::Event {
                    event: None,
                    data: "a".into()
                },
                SseItem::Event {
                    event: None,
                    data: "b".into()
                },
            ]
        );
    }

    #[test]
    fn field_without_colon_is_empty_data() {
        // "data" with no colon is a field name and an empty value.
        let got = events(&[b"data\n\n"]);
        assert_eq!(
            got,
            vec![SseItem::Event {
                event: None,
                data: String::new()
            }]
        );
    }

    #[test]
    fn eof_flushes_unterminated_event() {
        let mut p = SseParser::new();
        assert!(p.push(b"data: tail", false).is_empty());
        assert_eq!(
            p.push(b"", true),
            vec![SseItem::Event {
                event: None,
                data: "tail".into()
            }]
        );
    }
}
