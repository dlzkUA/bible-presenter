//! Phone remote: a page on the local network that turns any phone into a
//! remote control, nothing to install. The phone pairs by scanning a QR code
//! (which carries a long random key) or by typing a 6-digit PIN that is
//! exchanged for the same key. Every command and the live state need that
//! key; "Reset access" replaces both and drops every phone.

use crate::lan::lan_addresses;
use crate::sse::{self, Client, Running};
use crate::store::{basename, is_safe_id, read_json_safe, str_of, write_json_atomic, Paths};
use axum::body::{Body, Bytes};
use axum::extract::{ConnectInfo, Path as AxPath, Query, State};
use axum::http::{header, HeaderMap, HeaderValue, Response, StatusCode};
use axum::routing::{get, post};
use axum::Router;
use base64::Engine;
use parking_lot::Mutex;
use serde_json::{json, Map, Value};
use std::collections::HashMap;
use std::net::SocketAddr;
use std::path::PathBuf;
use std::sync::Arc;
use std::time::{Duration, Instant};

const PAGE: &str = include_str!("../../app/renderer/remote/index.html");
const PAGE_JS: &str = include_str!("../../app/renderer/remote/remote.js");
const ICON_192: &[u8] = include_bytes!("../../app/renderer/assets/remote-192.png");
const ICON_512: &[u8] = include_bytes!("../../app/renderer/assets/remote-512.png");
const ICON_180: &[u8] = include_bytes!("../../app/renderer/assets/remote-180.png");

pub type CommandHook = Arc<dyn Fn(Value) + Send + Sync>;

#[derive(Clone, Debug)]
pub struct Config {
    pub key: String,
    pub pin: String,
    pub port: u16,
    pub enabled: bool,
}

struct Fail {
    n: u32,
    until: Option<Instant>,
    since: Instant,
}

/// Wrong PINs allowed per PIN (see `pin_fails_total`). One in a million per
/// guess, so 50 tries leave about a 1-in-20,000 chance.
const PIN_TRIES: u32 = 50;

struct Inner {
    running: Option<Running>,
    clients: Vec<Client>,
    key: String,
    pin: String,
    /// Merged live state; a phone that joins gets all of it at once.
    state: Map<String, Value>,
    fails: HashMap<String, Fail>,
    recent_fails: Vec<Instant>,
    pair_locked_until: Option<Instant>,
    /// Wrong PINs since this PIN was made. Past PIN_TRIES the PIN stops
    /// working until the operator presses "Reset access" (the QR code still
    /// works), so slow guessing over days can't get through either.
    pin_fails_total: u32,
    slide_files: Vec<Option<PathBuf>>,
    thumbs: HashMap<String, Arc<Vec<u8>>>,
    thumb_order: Vec<String>,
    on_command: Option<CommandHook>,
    last_error: String,
    /// Where presentation slides live, for the covers in the phone's library.
    media_dir: Option<PathBuf>,
    pres_dir: Option<PathBuf>,
}

#[derive(Clone)]
pub struct Remote(Arc<Mutex<Inner>>);

impl Default for Remote {
    fn default() -> Self {
        Remote(Arc::new(Mutex::new(Inner {
            running: None,
            clients: vec![],
            key: String::new(),
            pin: String::new(),
            state: Map::new(),
            fails: HashMap::new(),
            recent_fails: vec![],
            pair_locked_until: None,
            pin_fails_total: 0,
            slide_files: vec![],
            thumbs: HashMap::new(),
            thumb_order: vec![],
            on_command: None,
            last_error: String::new(),
            media_dir: None,
            pres_dir: None,
        })))
    }
}

pub fn new_key() -> String {
    let mut b = [0u8; 24];
    // A key made from zeros would let anyone in; never carry on without randomness.
    getrandom::fill(&mut b).expect("the system's random number source failed");
    base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(b)
}

pub fn new_pin() -> String {
    let mut b = [0u8; 4];
    getrandom::fill(&mut b).expect("the system's random number source failed");
    format!("{:06}", u32::from_le_bytes(b) % 1_000_000)
}

/// Settings live in remote.json: the key and PIN survive restarts, so a phone
/// paired once (or a home-screen icon) keeps working.
pub fn load_config(p: &Paths) -> Config {
    let v = read_json_safe(&p.remote).unwrap_or(json!({}));
    let mut changed = false;
    let key = v.get("key").and_then(|k| k.as_str()).filter(|k| k.len() >= 24 && k.chars().all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-'))
        .map(String::from)
        .unwrap_or_else(|| {
            changed = true;
            new_key()
        });
    let pin = v.get("pin").and_then(|k| k.as_str()).filter(|k| k.len() == 6 && k.chars().all(|c| c.is_ascii_digit()))
        .map(String::from)
        .unwrap_or_else(|| {
            changed = true;
            new_pin()
        });
    let port = v.get("port").and_then(|p| p.as_u64()).filter(|p| *p > 0 && *p < 65536).unwrap_or(7780) as u16;
    let enabled = v.get("enabled").and_then(|e| e.as_bool()).unwrap_or(false);
    let c = Config { key, pin, port, enabled };
    if changed {
        save_config(p, &c);
    }
    c
}

pub fn save_config(p: &Paths, c: &Config) {
    let _ = write_json_atomic(&p.remote, &json!({ "key": c.key, "pin": c.pin, "port": c.port, "enabled": c.enabled }), true);
}

fn same_secret(a: &str, b: &str) -> bool {
    // Constant time for equal lengths.
    if a.is_empty() || a.len() != b.len() {
        return false;
    }
    a.bytes().zip(b.bytes()).fold(0u8, |acc, (x, y)| acc | (x ^ y)) == 0
}

const CMDS: [&str; 8] = ["next", "prev", "screen", "clearText", "slide", "item", "playlist", "pres"];

fn clean_command(b: &Value) -> Option<Value> {
    let cmd = b.get("cmd")?.as_str()?;
    if !CMDS.contains(&cmd) {
        return None;
    }
    let mut out = json!({ "cmd": cmd });
    if cmd == "slide" || cmd == "item" {
        let i = b.get("idx")?.as_i64()?;
        if !(0..=100_000).contains(&i) {
            return None;
        }
        out["idx"] = json!(i);
        if let Some(sig) = b.get("sig").filter(|s| !s.is_null()) {
            let s = match sig {
                Value::String(s) => s.clone(),
                other => other.to_string(),
            };
            out["sig"] = json!(s.chars().take(300).collect::<String>());
        }
    }
    if cmd == "playlist" || cmd == "pres" {
        let id = b.get("id")?.as_str()?;
        if id.is_empty() || id.len() > 200 || (cmd == "pres" && !is_safe_id(id)) {
            return None;
        }
        out["id"] = json!(id);
    }
    Some(out)
}

impl Remote {
    pub fn is_running(&self) -> bool {
        self.0.lock().running.is_some()
    }

    pub fn last_error(&self) -> String {
        self.0.lock().last_error.clone()
    }
    pub fn set_last_error(&self, e: &str) {
        self.0.lock().last_error = e.to_string();
    }

    /// The control window sends only what changed (the slide list is large
    /// and rarely changes); phones merge the same patches.
    pub fn set_state(&self, patch: Value, slide_files: Option<Vec<Option<PathBuf>>>) {
        let Value::Object(p) = patch else { return };
        let mut i = self.0.lock();
        if let Some(f) = slide_files {
            i.slide_files = f;
        }
        for (k, v) in &p {
            i.state.insert(k.clone(), v.clone());
        }
        if i.running.is_some() {
            let msg = sse::event("state", &Value::Object(p));
            sse::send_all(&mut i.clients, &msg, None);
        }
    }

    pub fn set_library_dirs(&self, media: PathBuf, presentations: PathBuf) {
        let mut i = self.0.lock();
        i.media_dir = Some(media);
        i.pres_dir = Some(presentations);
    }

    /// A JPEG preview of an image file, made once and kept (the newest 300).
    async fn preview(&self, path: PathBuf, width: u32) -> Option<Arc<Vec<u8>>> {
        let meta = std::fs::metadata(&path).ok()?;
        let ck = format!("{}|{:?}|{}|{width}", path.display(), meta.modified().ok(), meta.len());
        if let Some(j) = self.0.lock().thumbs.get(&ck).cloned() {
            return Some(j);
        }
        let made = tauri::async_runtime::spawn_blocking(move || make_thumb(&path, width)).await.ok().flatten()?;
        let j = Arc::new(made);
        let mut i = self.0.lock();
        i.thumbs.insert(ck.clone(), j.clone());
        i.thumb_order.push(ck);
        if i.thumb_order.len() > 300 {
            let old = i.thumb_order.remove(0);
            i.thumbs.remove(&old);
        }
        Some(j)
    }

    pub fn set_credentials(&self, key: &str, pin: &str) {
        let mut i = self.0.lock();
        i.key = key.to_string();
        i.pin = pin.to_string();
        i.fails.clear();
        i.recent_fails.clear();
        i.pair_locked_until = None;
        i.pin_fails_total = 0;
        // Phones holding the old key are dropped and come back to the PIN screen.
        i.clients.clear();
    }

    pub fn status(&self) -> Value {
        let mut i = self.0.lock();
        i.clients.retain(|c| c.alive());
        let port = i.running.as_ref().map(|r| r.port);
        json!({ "running": port.is_some(), "port": port, "ips": lan_addresses(), "phones": i.clients.len() })
    }

    pub fn start(&self, port: u16, key: &str, pin: &str, on_command: CommandHook) -> Result<u16, std::io::Error> {
        {
            let mut i = self.0.lock();
            i.key = key.to_string();
            i.pin = pin.to_string();
            i.on_command = Some(on_command);
            if let Some(r) = &i.running {
                return Ok(r.port);
            }
        }
        let router = Router::new()
            .route("/", get(page))
            .route("/index.html", get(page))
            .route("/remote.js", get(page_js))
            .route("/ui.js", get(ui_js))
            .route("/manifest.webmanifest", get(manifest))
            .route("/icon-192.png", get(|| async { png(ICON_192) }))
            .route("/icon-512.png", get(|| async { png(ICON_512) }))
            .route("/favicon.ico", get(|| async { png(ICON_192) }))
            .route("/apple-touch-icon.png", get(|| async { png(ICON_180) }))
            .route("/apple-touch-icon-precomposed.png", get(|| async { png(ICON_180) }))
            .route("/api/pair", post(pair))
            .route("/api/hello", get(hello))
            .route("/api/cmd", post(command))
            .route("/events", get(events))
            .route("/thumb/{n}", get(thumb))
            .route("/cover/{id}", get(cover))
            .fallback(|| async { sse::text(StatusCode::NOT_FOUND, "text/plain; charset=utf-8", "not found") })
            .layer(axum::middleware::from_fn(sse::guard_host))
            .with_state(self.clone())
            .into_make_service_with_connect_info::<SocketAddr>();
        let running = sse::serve_connect_info(port, router)?;
        let actual = running.port;
        self.0.lock().running = Some(running);
        self.0.lock().last_error.clear();
        let me = self.clone();
        tauri::async_runtime::spawn(async move {
            loop {
                tokio::time::sleep(Duration::from_secs(20)).await;
                let mut i = me.0.lock();
                if i.running.as_ref().map(|r| r.port) != Some(actual) {
                    break;
                }
                sse::send_all(&mut i.clients, ": ping\n\n", None);
            }
        });
        Ok(actual)
    }

    pub fn stop(&self) {
        let mut i = self.0.lock();
        i.clients.clear();
        if let Some(mut r) = i.running.take() {
            if let Some(tx) = r.stop.take() {
                let _ = tx.send(());
            }
        }
    }

    fn authed(&self, headers: &HeaderMap, q: Option<&str>) -> bool {
        let key = self.0.lock().key.clone();
        let given = headers.get("x-key").and_then(|v| v.to_str().ok()).map(String::from).or_else(|| q.map(String::from)).unwrap_or_default();
        same_secret(&given, &key)
    }
}

fn png(bytes: &'static [u8]) -> Response<Body> {
    let mut r = sse::text(StatusCode::OK, "image/png", bytes);
    r.headers_mut().insert(header::CACHE_CONTROL, HeaderValue::from_static("max-age=86400"));
    r
}

fn json_res(code: StatusCode, v: Value) -> Response<Body> {
    let mut r = sse::text(code, "application/json; charset=utf-8", v.to_string());
    r.headers_mut().insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
    r
}

async fn page() -> Response<Body> {
    let mut r = sse::text(StatusCode::OK, "text/html; charset=utf-8", PAGE);
    let h = r.headers_mut();
    h.insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
    h.insert("X-Frame-Options", HeaderValue::from_static("DENY"));
    h.insert("Referrer-Policy", HeaderValue::from_static("no-referrer"));
    h.insert("X-Content-Type-Options", HeaderValue::from_static("nosniff"));
    h.insert(
        header::CONTENT_SECURITY_POLICY,
        HeaderValue::from_static("default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; manifest-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'"),
    );
    r
}

async fn page_js() -> Response<Body> {
    let mut r = sse::text(StatusCode::OK, "application/javascript; charset=utf-8", PAGE_JS);
    r.headers_mut().insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
    r
}

// Interface strings for the PIN screen, before the phone is paired: only
// the labels, nothing about what is on screen.
async fn ui_js(State(r): State<Remote>) -> Response<Body> {
    let (lang, ui) = {
        let i = r.0.lock();
        (i.state.get("lang").cloned().unwrap_or(json!("uk")), i.state.get("ui").cloned().unwrap_or(json!({})))
    };
    let body = format!("window.__BP={};", json!({ "lang": lang, "ui": ui }).to_string().replace('<', "\\u003c"));
    let mut res = sse::text(StatusCode::OK, "application/javascript; charset=utf-8", body);
    res.headers_mut().insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
    res
}

async fn manifest(State(r): State<Remote>) -> Response<Body> {
    let label = r.0.lock().state.get("ui").and_then(|u| u.get("Пульт")).and_then(|v| v.as_str()).unwrap_or("Remote").to_string();
    let v = json!({
        "name": format!("Bible Presenter — {label}"),
        "short_name": label,
        "start_url": "/", "scope": "/", "display": "standalone", "orientation": "any",
        "background_color": "#11111b", "theme_color": "#181825",
        "icons": [
            { "src": "/icon-192.png", "sizes": "192x192", "type": "image/png", "purpose": "any" },
            { "src": "/icon-512.png", "sizes": "512x512", "type": "image/png", "purpose": "any" },
        ],
    });
    let mut res = sse::text(StatusCode::OK, "application/manifest+json; charset=utf-8", v.to_string());
    res.headers_mut().insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
    res
}

/// A web page on another site can send a plain POST to this address from any
/// browser on the network (to burn PIN tries). Only the phone page's own
/// JSON request is accepted: a cross-site page can't send that without the
/// browser asking first, and this server never says yes.
fn same_site_json(headers: &HeaderMap) -> bool {
    let json = headers
        .get(header::CONTENT_TYPE)
        .and_then(|v| v.to_str().ok())
        .map(|v| v.trim_start().to_ascii_lowercase().starts_with("application/json"))
        .unwrap_or(false);
    // The phone page asks for no referrer, and with that setting browsers
    // send "Origin: null" even to their own site. The JSON type alone already
    // makes another site's page ask first, which never succeeds.
    let origin_ok = match (headers.get(header::ORIGIN).and_then(|v| v.to_str().ok()), headers.get(header::HOST).and_then(|v| v.to_str().ok())) {
        (None, _) | (Some("null"), _) => true,
        (Some(o), Some(h)) => o.eq_ignore_ascii_case(&format!("http://{h}")),
        (Some(_), None) => false,
    };
    json && origin_ok
}

async fn pair(State(r): State<Remote>, ConnectInfo(addr): ConnectInfo<SocketAddr>, headers: HeaderMap, body: Bytes) -> Response<Body> {
    if !same_site_json(&headers) {
        return json_res(StatusCode::FORBIDDEN, json!({ "error": "bad" }));
    }
    let ip = addr.ip().to_canonical().to_string();
    let now = Instant::now();
    let mut i = r.0.lock();
    let locked_ip = i.fails.get(&ip).and_then(|f| f.until).map(|u| now < u).unwrap_or(false);
    if i.pair_locked_until.map(|u| now < u).unwrap_or(false) || locked_ip || i.pin_fails_total >= PIN_TRIES {
        return json_res(StatusCode::TOO_MANY_REQUESTS, json!({ "error": "wait" }));
    }
    if body.len() > 512 {
        return json_res(StatusCode::BAD_REQUEST, json!({ "error": "bad" }));
    }
    let Ok(v) = serde_json::from_slice::<Value>(&body) else { return json_res(StatusCode::BAD_REQUEST, json!({ "error": "bad" })) };
    let pin: String = v.get("pin").map(|p| match p {
        Value::String(s) => s.clone(),
        other => other.to_string(),
    }).unwrap_or_default().chars().filter(|c| c.is_ascii_digit()).collect();
    if !i.pin.is_empty() && same_secret(&pin, &i.pin) {
        i.fails.remove(&ip);
        let key = i.key.clone();
        return json_res(StatusCode::OK, json!({ "key": key }));
    }
    // Five wrong PINs from one device: a minute's pause. Thirty from anyone in
    // ten minutes: pairing pauses for everyone for five minutes.
    let entry = i.fails.entry(ip).or_insert(Fail { n: 0, until: None, since: now });
    if now.duration_since(entry.since) > Duration::from_secs(600) {
        *entry = Fail { n: 0, until: None, since: now };
    }
    entry.n += 1;
    let mut wait = false;
    if entry.n >= 5 {
        entry.n = 0;
        entry.until = Some(now + Duration::from_secs(60));
        wait = true;
    }
    i.pin_fails_total += 1;
    i.recent_fails.retain(|t| now.duration_since(*t) < Duration::from_secs(600));
    i.recent_fails.push(now);
    if i.recent_fails.len() >= 30 {
        i.pair_locked_until = Some(now + Duration::from_secs(300));
        i.recent_fails.clear();
    }
    if wait {
        json_res(StatusCode::TOO_MANY_REQUESTS, json!({ "error": "wait" }))
    } else {
        json_res(StatusCode::UNAUTHORIZED, json!({ "error": "pin" }))
    }
}

async fn hello(State(r): State<Remote>, headers: HeaderMap, Query(q): Query<HashMap<String, String>>) -> Response<Body> {
    if r.authed(&headers, q.get("k").map(|s| s.as_str())) {
        json_res(StatusCode::OK, json!({ "ok": true }))
    } else {
        json_res(StatusCode::UNAUTHORIZED, json!({ "error": "key" }))
    }
}

// The key travels in a custom header: a page on another site can't add one
// without a CORS preflight, which this server never answers.
async fn command(State(r): State<Remote>, headers: HeaderMap, body: Bytes) -> Response<Body> {
    if !r.authed(&headers, None) {
        return json_res(StatusCode::UNAUTHORIZED, json!({ "error": "key" }));
    }
    if body.len() > 4096 {
        return json_res(StatusCode::BAD_REQUEST, json!({ "error": "bad" }));
    }
    let Some(cmd) = serde_json::from_slice::<Value>(&body).ok().as_ref().and_then(clean_command) else {
        return json_res(StatusCode::BAD_REQUEST, json!({ "error": "bad" }));
    };
    let hook = r.0.lock().on_command.clone();
    if let Some(h) = hook {
        h(cmd);
    }
    json_res(StatusCode::OK, json!({ "ok": true }))
}

async fn events(
    State(r): State<Remote>,
    ConnectInfo(addr): ConnectInfo<SocketAddr>,
    headers: HeaderMap,
    Query(q): Query<HashMap<String, String>>,
) -> Response<Body> {
    if !r.authed(&headers, q.get("k").map(|s| s.as_str())) {
        return json_res(StatusCode::UNAUTHORIZED, json!({ "error": "key" }));
    }
    let mut i = r.0.lock();
    let first = vec!["retry: 2000\n\n".to_string(), sse::event("state", &Value::Object(i.state.clone()))];
    let ip = Some(addr.ip().to_canonical());
    sse::admit(&mut i.clients, ip);
    let (client, res) = sse::stream(0, ip, first);
    i.clients.push(client);
    res
}

fn jpeg_res(jpeg: &[u8]) -> Response<Body> {
    let mut res = Response::new(Body::from(jpeg.to_vec()));
    let h = res.headers_mut();
    h.insert(header::CONTENT_TYPE, HeaderValue::from_static("image/jpeg"));
    h.insert(header::CACHE_CONTROL, HeaderValue::from_static("private, max-age=600"));
    res
}

fn not_found() -> Response<Body> {
    sse::text(StatusCode::NOT_FOUND, "text/plain", "")
}

// Small previews of presentation slides and pictures for the phone's list.
// Only files listed for the current slides can be fetched, by position.
// ?w=720 asks for a sharper one (the big "on screen" picture).
async fn thumb(State(r): State<Remote>, headers: HeaderMap, AxPath(n): AxPath<String>, Query(q): Query<HashMap<String, String>>) -> Response<Body> {
    if !r.authed(&headers, q.get("k").map(|s| s.as_str())) {
        return sse::text(StatusCode::UNAUTHORIZED, "text/plain", "");
    }
    let Ok(n) = n.parse::<usize>() else { return not_found() };
    let width = match q.get("w").and_then(|w| w.parse::<u32>().ok()) {
        Some(w) if w > 400 => 720,
        _ => 320,
    };
    let path = r.0.lock().slide_files.get(n).cloned().flatten();
    let Some(path) = path else { return not_found() };
    match r.preview(path, width).await {
        Some(j) => jpeg_res(&j),
        None => not_found(),
    }
}

// The first slide of a presentation, for the phone's presentation list.
async fn cover(State(r): State<Remote>, headers: HeaderMap, AxPath(id): AxPath<String>, Query(q): Query<HashMap<String, String>>) -> Response<Body> {
    if !r.authed(&headers, q.get("k").map(|s| s.as_str())) {
        return sse::text(StatusCode::UNAUTHORIZED, "text/plain", "");
    }
    if !is_safe_id(&id) {
        return not_found();
    }
    let (media, pres) = {
        let i = r.0.lock();
        (i.media_dir.clone(), i.pres_dir.clone())
    };
    let (Some(media), Some(pres)) = (media, pres) else { return not_found() };
    let Some(doc) = read_json_safe(&pres.join(format!("{id}.json"))) else { return not_found() };
    let first = doc.get("slides").and_then(|s| s.as_array()).and_then(|a| {
        a.iter().map(|s| str_of(s, "image").to_string()).find(|img| !img.is_empty())
    });
    let Some(img) = first else { return not_found() };
    match r.preview(media.join(basename(&img)), 320).await {
        Some(j) => jpeg_res(&j),
        None => not_found(),
    }
}

pub fn make_thumb(path: &std::path::Path, width: u32) -> Option<Vec<u8>> {
    let img = image::ImageReader::open(path).ok()?.with_guessed_format().ok()?.decode().ok()?;
    let img = if img.width() > width { img.resize(width, width * 4, image::imageops::FilterType::Triangle) } else { img };
    let rgb = img.to_rgb8();
    let mut out = Vec::new();
    let enc = image::codecs::jpeg::JpegEncoder::new_with_quality(&mut out, 72);
    rgb.write_with_encoder(enc).ok()?;
    Some(out)
}
