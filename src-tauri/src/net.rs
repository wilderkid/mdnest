//! Streaming HTTP for plugins.
//!
//! The frontend supplies a URL, headers and an optional `secret_ref`. Rust reads
//! the secret and attaches it as `Authorization: Bearer …` (or a named header).
//! The plaintext never crosses IPC. Events travel back on a Tauri `Channel`.

use std::collections::HashMap;
use std::sync::{Arc, Mutex, OnceLock};
use std::time::Duration;

use futures_util::StreamExt;
use serde::{Deserialize, Serialize};
use tauri::ipc::Channel;

use crate::secrets;
use crate::sse::{SseItem, SseParser};

const MAX_ERROR_BODY: usize = 2048;
const MAX_RETRIES: u32 = 2;

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StreamRequest {
    pub url: String,
    pub method: String,
    #[serde(default)]
    pub headers: HashMap<String, String>,
    pub body: Option<String>,
    pub secret_ref: Option<String>,
    /// `"bearer"` (default when a secret is set) or `"header:<name>"`.
    pub auth: Option<String>,
    pub timeout_ms: Option<u64>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(tag = "type", rename_all = "lowercase")]
pub enum StreamEvent {
    Open {
        status: u16,
    },
    Data {
        #[serde(skip_serializing_if = "Option::is_none")]
        event: Option<String>,
        data: String,
    },
    Error {
        #[serde(skip_serializing_if = "Option::is_none")]
        status: Option<u16>,
        message: String,
    },
    Done,
}

/// Shared cancel signal. `notify` wakes every `wait` future; `is_cancelled` is the flag.
struct CancelFlag {
    flag: Arc<std::sync::atomic::AtomicBool>,
    tx: tokio::sync::watch::Sender<bool>,
}

impl CancelFlag {
    fn new() -> (Self, CancelWait) {
        let (tx, rx) = tokio::sync::watch::channel(false);
        let flag = Arc::new(std::sync::atomic::AtomicBool::new(false));
        (
            Self {
                flag: flag.clone(),
                tx,
            },
            CancelWait { flag, rx },
        )
    }
    fn cancel(&self) {
        self.flag.store(true, std::sync::atomic::Ordering::SeqCst);
        let _ = self.tx.send(true);
    }
}

struct CancelWait {
    flag: Arc<std::sync::atomic::AtomicBool>,
    rx: tokio::sync::watch::Receiver<bool>,
}

impl CancelWait {
    fn is_cancelled(&self) -> bool {
        self.flag.load(std::sync::atomic::Ordering::SeqCst)
    }
    async fn cancelled(&mut self) {
        if self.is_cancelled() {
            return;
        }
        let _ = self.rx.changed().await;
    }
}

struct Inflight {
    handle: tauri::async_runtime::JoinHandle<()>,
    cancel: CancelFlag,
}

fn inflight() -> &'static Mutex<HashMap<String, Inflight>> {
    static MAP: OnceLock<Mutex<HashMap<String, Inflight>>> = OnceLock::new();
    MAP.get_or_init(|| Mutex::new(HashMap::new()))
}

fn http_client() -> &'static reqwest::Client {
    static CLIENT: OnceLock<reqwest::Client> = OnceLock::new();
    CLIENT.get_or_init(|| {
        // TLS comes from the platform: OpenSSL (Linux), schannel (Windows), Security.framework (macOS).
        reqwest::Client::builder()
            .build()
            .unwrap_or_else(|_| reqwest::Client::new())
    })
}

fn check_url(raw: &str) -> Result<reqwest::Url, String> {
    let url = reqwest::Url::parse(raw).map_err(|_| "invalid url".to_string())?;
    match url.scheme() {
        "http" | "https" => Ok(url),
        _ => Err("only http and https urls are allowed".into()),
    }
}

fn header_is_auth(name: &str) -> bool {
    name.eq_ignore_ascii_case("authorization") || name.eq_ignore_ascii_case("proxy-authorization")
}

/// Where the secret is written. `None` means Bearer (the default).
fn auth_header_name(auth: Option<&str>) -> Result<String, String> {
    match auth.map(str::trim).filter(|s| !s.is_empty()) {
        None | Some("bearer") => Ok("Authorization".into()),
        Some(other) => {
            let Some(name) = other.strip_prefix("header:") else {
                return Err("auth must be \"bearer\" or \"header:<name>\"".into());
            };
            let name = name.trim();
            if name.is_empty() || !name.bytes().all(|c| c.is_ascii_graphic() && c != b':') {
                return Err("invalid auth header name".into());
            }
            Ok(name.to_string())
        }
    }
}

fn apply_secret(value: &str, auth: Option<&str>) -> Result<(String, String), String> {
    let name = auth_header_name(auth)?;
    let header_value = if name.eq_ignore_ascii_case("authorization")
        && !value.to_ascii_lowercase().starts_with("bearer ")
    {
        format!("Bearer {value}")
    } else {
        value.to_string()
    };
    Ok((name, header_value))
}

fn scrub_message(message: &str, secret: Option<&str>) -> String {
    let mut out = message.to_string();
    if let Some(secret) = secret {
        out = secrets::scrub(&out, secret);
        // Also drop a "Bearer <secret>" form if the caller stored the token bare.
        if !secret.to_ascii_lowercase().starts_with("bearer ") {
            out = secrets::scrub(&out, &format!("Bearer {secret}"));
        }
    }
    out
}

fn truncate_body(bytes: &[u8]) -> String {
    let limit = bytes.len().min(MAX_ERROR_BODY);
    // Walk back to a char boundary so a multi-byte codepoint is not split.
    let mut end = limit;
    while end > 0 && !is_utf8_boundary(bytes, end) {
        end -= 1;
    }
    String::from_utf8_lossy(&bytes[..end]).into_owned()
}

fn is_utf8_boundary(bytes: &[u8], i: usize) -> bool {
    if i >= bytes.len() {
        return true;
    }
    (bytes[i] & 0b1100_0000) != 0b1000_0000
}

fn is_event_stream(resp: &reqwest::Response) -> bool {
    resp.headers()
        .get(reqwest::header::CONTENT_TYPE)
        .and_then(|v| v.to_str().ok())
        .map(|v| {
            let mime = v.split(';').next().unwrap_or(v).trim();
            mime.eq_ignore_ascii_case("text/event-stream")
        })
        .unwrap_or(false)
}

fn retryable(status: reqwest::StatusCode) -> bool {
    status.as_u16() == 429 || status.is_server_error()
}

fn send(channel: &Channel<StreamEvent>, ev: StreamEvent) {
    let _ = channel.send(ev);
}

async fn backoff(attempt: u32, cancel: &mut CancelWait) -> bool {
    // attempt is 1-based after a failure: 250ms, then 500ms. Returns false if cancelled.
    let ms = 250u64.saturating_mul(1u64 << (attempt - 1).min(4));
    tokio::select! {
        biased;
        _ = cancel.cancelled() => false,
        _ = tokio::time::sleep(Duration::from_millis(ms)) => !cancel.is_cancelled(),
    }
}

struct Prepared {
    url: reqwest::Url,
    method: reqwest::Method,
    headers: HashMap<String, String>,
    body: Option<String>,
    secret: Option<String>,
    timeout: Duration,
}

fn prepare(app: &tauri::AppHandle, req: StreamRequest) -> Result<Prepared, String> {
    let url = check_url(&req.url)?;
    let method = match req.method.to_ascii_uppercase().as_str() {
        "GET" => reqwest::Method::GET,
        "POST" => reqwest::Method::POST,
        other => return Err(format!("unsupported method {other}")),
    };
    let mut headers = req.headers;
    // The frontend must not smuggle the secret in via a caller-supplied auth header.
    headers.retain(|k, _| !header_is_auth(k));
    let mut secret = None;
    if let Some(id) = req.secret_ref.as_deref() {
        match secrets::lookup(Some(app), id)? {
            Some(value) => {
                let (name, header_value) = apply_secret(&value, req.auth.as_deref())?;
                headers.insert(name, header_value);
                secret = Some(value);
            }
            None => return Err(format!("unknown secret ref")),
        }
    }
    let timeout = Duration::from_millis(req.timeout_ms.unwrap_or(120_000).clamp(1_000, 600_000));
    Ok(Prepared {
        url,
        method,
        headers,
        body: req.body,
        secret,
        timeout,
    })
}

fn build_request(prep: &Prepared) -> Result<reqwest::RequestBuilder, String> {
    let mut b = http_client().request(prep.method.clone(), prep.url.clone());
    for (k, v) in &prep.headers {
        b = b.header(k, v);
    }
    if let Some(body) = &prep.body {
        if prep.method != reqwest::Method::GET {
            b = b.body(body.clone());
        }
    }
    b = b.timeout(prep.timeout);
    Ok(b)
}

async fn execute(channel: Channel<StreamEvent>, prep: Prepared, mut cancel: CancelWait) {
    let secret_for_scrub = prep.secret.clone();
    let mut attempt = 0u32;
    loop {
        if cancel.is_cancelled() {
            send(&channel, StreamEvent::Done);
            return;
        }
        let builder = match build_request(&prep) {
            Ok(b) => b,
            Err(e) => {
                send(
                    &channel,
                    StreamEvent::Error {
                        status: None,
                        message: scrub_message(&e, secret_for_scrub.as_deref()),
                    },
                );
                send(&channel, StreamEvent::Done);
                return;
            }
        };
        let send_fut = builder.send();
        tokio::pin!(send_fut);
        let resp = tokio::select! {
            biased;
            _ = cancel.cancelled() => {
                send(&channel, StreamEvent::Done);
                return;
            }
            result = &mut send_fut => result,
        };
        match resp {
            Ok(resp) => {
                let status = resp.status();
                // Retry only before any payload byte is forwarded. A retryable status
                // whose body we have not read still counts as "before the first byte".
                if retryable(status) && attempt < MAX_RETRIES {
                    drop(resp);
                    attempt += 1;
                    if !backoff(attempt, &mut cancel).await {
                        send(&channel, StreamEvent::Done);
                        return;
                    }
                    continue;
                }
                send(
                    &channel,
                    StreamEvent::Open {
                        status: status.as_u16(),
                    },
                );
                if !status.is_success() {
                    let bytes = resp.bytes().await.unwrap_or_default();
                    let mut message = truncate_body(&bytes);
                    if message.is_empty() {
                        message = format!("HTTP {}", status.as_u16());
                    }
                    message = scrub_message(&message, secret_for_scrub.as_deref());
                    send(
                        &channel,
                        StreamEvent::Error {
                            status: Some(status.as_u16()),
                            message,
                        },
                    );
                    send(&channel, StreamEvent::Done);
                    return;
                }
                if is_event_stream(&resp) {
                    stream_sse(&channel, resp, secret_for_scrub.as_deref(), &mut cancel).await;
                } else {
                    stream_body(&channel, resp, secret_for_scrub.as_deref(), &mut cancel).await;
                }
                send(&channel, StreamEvent::Done);
                return;
            }
            Err(e) => {
                // Connection / timeout failures before any byte: same retry budget.
                if attempt < MAX_RETRIES && e.status().is_none() && !cancel.is_cancelled() {
                    attempt += 1;
                    if !backoff(attempt, &mut cancel).await {
                        send(&channel, StreamEvent::Done);
                        return;
                    }
                    continue;
                }
                if cancel.is_cancelled() {
                    send(&channel, StreamEvent::Done);
                    return;
                }
                let status = e.status().map(|s| s.as_u16());
                send(
                    &channel,
                    StreamEvent::Error {
                        status,
                        message: scrub_message(&e.to_string(), secret_for_scrub.as_deref()),
                    },
                );
                send(&channel, StreamEvent::Done);
                return;
            }
        }
    }
}

async fn stream_sse(
    channel: &Channel<StreamEvent>,
    resp: reqwest::Response,
    secret: Option<&str>,
    cancel: &mut CancelWait,
) {
    let mut parser = SseParser::new();
    let mut body = resp.bytes_stream();
    loop {
        if cancel.is_cancelled() {
            return;
        }
        tokio::select! {
            biased;
            _ = cancel.cancelled() => return,
            chunk = body.next() => {
                match chunk {
                    Some(Ok(bytes)) => {
                        for item in parser.push(&bytes, false) {
                            if !emit_item(channel, item, secret) {
                                return;
                            }
                        }
                    }
                    Some(Err(e)) => {
                        send(
                            channel,
                            StreamEvent::Error {
                                status: e.status().map(|s| s.as_u16()),
                                message: scrub_message(&e.to_string(), secret),
                            },
                        );
                        return;
                    }
                    None => break,
                }
            }
        }
    }
    for item in parser.push(&[], true) {
        if !emit_item(channel, item, secret) {
            return;
        }
    }
}

fn emit_item(channel: &Channel<StreamEvent>, item: SseItem, secret: Option<&str>) -> bool {
    match item {
        SseItem::Done => false,
        SseItem::Event { event, data } => {
            send(
                channel,
                StreamEvent::Data {
                    event,
                    data: scrub_message(&data, secret),
                },
            );
            true
        }
    }
}

async fn stream_body(
    channel: &Channel<StreamEvent>,
    resp: reqwest::Response,
    secret: Option<&str>,
    cancel: &mut CancelWait,
) {
    let read = resp.bytes();
    tokio::pin!(read);
    let result = tokio::select! {
        biased;
        _ = cancel.cancelled() => return,
        result = &mut read => result,
    };
    match result {
        Ok(bytes) => {
            let data = scrub_message(&String::from_utf8_lossy(&bytes), secret);
            send(channel, StreamEvent::Data { event: None, data });
        }
        Err(e) => {
            send(
                channel,
                StreamEvent::Error {
                    status: e.status().map(|s| s.as_u16()),
                    message: scrub_message(&e.to_string(), secret),
                },
            );
        }
    }
}

/// Start a stream. Events are pushed on `on_event`. `id` is the cancel key.
pub fn start(
    app: tauri::AppHandle,
    id: String,
    req: StreamRequest,
    on_event: Channel<StreamEvent>,
) -> Result<(), String> {
    if id.is_empty() || id.len() > 64 || !id.bytes().all(|c| c.is_ascii_graphic()) {
        return Err("invalid stream id".into());
    }
    let prep = prepare(&app, req)?;
    // Replace any previous stream with the same id.
    cancel(&id);
    let (flag, wait) = CancelFlag::new();
    let id_for_task = id.clone();
    let handle = tauri::async_runtime::spawn(async move {
        execute(on_event, prep, wait).await;
        inflight()
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .remove(&id_for_task);
    });
    inflight().lock().unwrap_or_else(|e| e.into_inner()).insert(
        id,
        Inflight {
            handle,
            cancel: flag,
        },
    );
    Ok(())
}

pub fn cancel(id: &str) -> bool {
    if let Some(entry) = inflight()
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .remove(id)
    {
        entry.cancel.cancel();
        entry.handle.abort();
        true
    } else {
        false
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn url_scheme_gate() {
        assert!(check_url("https://example.com/v1").is_ok());
        assert!(check_url("http://127.0.0.1:11434/v1").is_ok());
        assert!(check_url("file:///etc/passwd").is_err());
        assert!(check_url("javascript:alert(1)").is_err());
        assert!(check_url("not a url").is_err());
    }

    #[test]
    fn auth_forms() {
        assert_eq!(auth_header_name(None).unwrap(), "Authorization");
        assert_eq!(auth_header_name(Some("bearer")).unwrap(), "Authorization");
        assert_eq!(
            auth_header_name(Some("header:X-Api-Key")).unwrap(),
            "X-Api-Key"
        );
        assert!(auth_header_name(Some("basic")).is_err());
        assert!(auth_header_name(Some("header:")).is_err());
        assert!(auth_header_name(Some("header:Bad Name")).is_err());
    }

    #[test]
    fn secret_becomes_bearer() {
        let (n, v) = apply_secret("sk-test", Some("bearer")).unwrap();
        assert_eq!(n, "Authorization");
        assert_eq!(v, "Bearer sk-test");
        let (n, v) = apply_secret("sk-test", Some("header:X-Api-Key")).unwrap();
        assert_eq!(n, "X-Api-Key");
        assert_eq!(v, "sk-test");
        // Already-qualified bearer values are not doubled.
        let (_, v) = apply_secret("Bearer sk-test", None).unwrap();
        assert_eq!(v, "Bearer sk-test");
    }

    #[test]
    fn scrub_drops_secret_from_error_text() {
        let msg = scrub_message("upstream said token sk-live is bad", Some("sk-live"));
        assert!(!msg.contains("sk-live"));
        assert!(msg.contains("[redacted]"));
    }

    #[test]
    fn truncate_respects_utf8_and_limit() {
        let s = "é".repeat(3000);
        let bytes = s.as_bytes();
        let cut = truncate_body(bytes);
        assert!(cut.len() <= MAX_ERROR_BODY);
        assert!(std::str::from_utf8(cut.as_bytes()).is_ok());
        assert!(!cut.is_empty());
        assert!(cut.ends_with('é'));
        // ASCII fills the cap exactly.
        let ascii = truncate_body(&vec![b'a'; 4000]);
        assert_eq!(ascii.len(), MAX_ERROR_BODY);
    }

    #[test]
    fn retryable_statuses() {
        assert!(retryable(reqwest::StatusCode::TOO_MANY_REQUESTS));
        assert!(retryable(reqwest::StatusCode::BAD_GATEWAY));
        assert!(retryable(reqwest::StatusCode::SERVICE_UNAVAILABLE));
        assert!(!retryable(reqwest::StatusCode::BAD_REQUEST));
        assert!(!retryable(reqwest::StatusCode::OK));
        assert!(!retryable(reqwest::StatusCode::UNAUTHORIZED));
    }
}
