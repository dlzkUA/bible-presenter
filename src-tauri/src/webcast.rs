//! Live output: a small web server that mirrors the projector to vMix / OBS
//! (a "Web Browser" input) in real time, with its own look, plus the stage
//! display for the people on the platform. Both pages are pushed to over
//! Server-Sent Events.

use crate::lan::lan_addresses;
use crate::sse::{self, Client, Running};
use axum::body::Body;
use axum::extract::{ConnectInfo, Path as AxPath, Query, Request, State};
use axum::http::{header, HeaderValue, Response, StatusCode};
use axum::response::IntoResponse;
use axum::routing::get;
use axum::Router;
use parking_lot::Mutex;
use serde_json::{json, Value};
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Arc;
use std::time::Instant;
use tower::ServiceExt;
use tower_http::services::ServeFile;

const PAGE: &str = include_str!("../pages/live.html");
const STAGE_PAGE: &str = include_str!("../pages/stage.html");
const BG_STAGE_JS: &str = include_str!("../../app/shared/bgStage.js");
const LINK_JS: &str = include_str!("../pages/link.js");
const FONTFACES_JS: &str = include_str!("../../app/shared/fontfaces.js");
const LAUNCHER: &str = include_str!("../pages/launcher.html");
const DEFAULTS: &str = include_str!("../data/stream-defaults.json");

const TAG_STREAM: u8 = 0;
const TAG_STAGE: u8 = 1;

pub type MediaResolver = Arc<dyn Fn(&str) -> Option<PathBuf> + Send + Sync>;

struct Inner {
    running: Option<Running>,
    clients: Vec<Client>,
    /// What the stream shows (can be held clear).
    last_payload: Option<Value>,
    /// What the projector shows: the stage display follows the room.
    last_stage: Option<Value>,
    style: Value,
    stage_config: Value,
    stage_epoch: Instant,
    resolver: Option<MediaResolver>,
    /// Counts starts, so the keep-alive task of an earlier run ends even when
    /// the output comes back on the same port.
    run: u64,
}

#[derive(Clone)]
pub struct Webcast(Arc<Mutex<Inner>>);

impl Default for Webcast {
    fn default() -> Self {
        let defaults: Value = serde_json::from_str(DEFAULTS).unwrap_or(json!({ "song": {}, "bible": {} }));
        Webcast(Arc::new(Mutex::new(Inner {
            running: None,
            clients: vec![],
            last_payload: None,
            last_stage: None,
            style: defaults,
            stage_config: json!({ "layout": "current-next", "clock": true, "timer": true, "scale": 1, "ampm": false }),
            stage_epoch: Instant::now(),
            resolver: None,
            run: 0,
        })))
    }
}

/// Style values end up in CSS on the live and stage pages. A stream theme
/// shared by someone else could carry "red; background:url(…)" in a colour, so
/// text that could break out of one CSS value is dropped.
fn css_safe(v: &Value) -> bool {
    match v {
        Value::String(s) => {
            let l = s.to_ascii_lowercase();
            !s.contains([';', '{', '}', '<', '>', '\\']) && !l.contains("url(") && !l.contains("expression(") && !l.contains("@import")
        }
        Value::Array(_) | Value::Object(_) => false,
        _ => true,
    }
}

fn merge(base: &mut Value, patch: &Value) {
    if let (Some(b), Some(p)) = (base.as_object_mut(), patch.as_object()) {
        for (k, v) in p {
            if css_safe(v) {
                b.insert(k.clone(), v.clone());
            }
        }
    }
}

impl Webcast {
    pub fn is_running(&self) -> bool {
        self.0.lock().running.is_some()
    }

    /// A small page to open in vMix or OBS as a file instead of the address:
    /// it waits for this program and then opens the live page. Holds only the
    /// addresses of this computer, so it can be kept and shared within the
    /// church. None while the output is off (there is no port yet).
    pub fn launcher_page(&self) -> Option<String> {
        let port = self.0.lock().running.as_ref().map(|r| r.port)?;
        let mut targets = vec![format!("http://127.0.0.1:{port}/")];
        for ip in lan_addresses() {
            let host = if ip.contains(':') { format!("[{ip}]") } else { ip };
            targets.push(format!("http://{host}:{port}/"));
        }
        let list = serde_json::to_string(&targets).ok()?.replace('<', "\\u003c");
        Some(LAUNCHER.replace("__TARGETS__", &list))
    }

    fn stage_payload(i: &Inner) -> Value {
        let mut v = i.stage_config.clone();
        // Elapsed time, not a timestamp: devices' clocks don't agree.
        v["timerElapsedMs"] = json!(i.stage_epoch.elapsed().as_millis() as u64);
        v
    }

    pub fn broadcast(&self, event: &str, data: &Value) {
        let mut i = self.0.lock();
        if event == "slide" {
            i.last_payload = Some(data.clone());
        }
        if event == "clear" {
            i.last_payload = None;
        }
        let msg = sse::event(event, data);
        sse::send_all(&mut i.clients, &msg, None);
    }

    /// The stage display shows what is on the PROJECTOR, independent of a
    /// stream held clear.
    pub fn broadcast_stage(&self, payload: Option<&Value>) {
        let mut i = self.0.lock();
        i.last_stage = payload.map(|p| {
            json!({
                "text": p.get("text").and_then(|v| v.as_str()).unwrap_or(""),
                "nextText": p.get("nextText").and_then(|v| v.as_str()).unwrap_or(""),
                "reference": p.get("reference").and_then(|v| v.as_str()).unwrap_or(""),
            })
        });
        let msg = match &i.last_stage {
            Some(s) => sse::event("stageSlide", s),
            None => "event: stageClear\ndata: {}\n\n".to_string(),
        };
        sse::send_all(&mut i.clients, &msg, None);
    }

    pub fn set_style(&self, style: &Value) -> Value {
        let out = {
            let mut i = self.0.lock();
            // The full { song, bible } object, or a flat patch for both.
            if style.get("song").is_some() || style.get("bible").is_some() {
                if let Some(s) = style.get("song") {
                    merge(&mut i.style["song"], s);
                }
                if let Some(b) = style.get("bible") {
                    merge(&mut i.style["bible"], b);
                }
            } else {
                merge(&mut i.style["song"], style);
                merge(&mut i.style["bible"], style);
            }
            i.style.clone()
        };
        self.broadcast("style", &out);
        out
    }

    pub fn get_style(&self) -> Value {
        self.0.lock().style.clone()
    }

    pub fn set_stage_config(&self, cfg: &Value) -> Value {
        let (cfg_out, payload) = {
            let mut i = self.0.lock();
            merge(&mut i.stage_config, cfg);
            (i.stage_config.clone(), Self::stage_payload(&i))
        };
        self.broadcast("stage", &payload);
        cfg_out
    }

    pub fn get_stage_config(&self) -> Value {
        self.0.lock().stage_config.clone()
    }

    pub fn reset_stage_timer(&self) {
        let payload = {
            let mut i = self.0.lock();
            i.stage_epoch = Instant::now();
            Self::stage_payload(&i)
        };
        self.broadcast("stage", &payload);
    }

    pub fn status(&self) -> Value {
        let mut i = self.0.lock();
        i.clients.retain(|c| c.alive());
        let port = i.running.as_ref().map(|r| r.port);
        json!({
            "running": port.is_some(),
            "port": port,
            "ips": lan_addresses(),
            "clients": i.clients.iter().filter(|c| c.tag == TAG_STREAM).count(),
            "stageClients": i.clients.iter().filter(|c| c.tag == TAG_STAGE).count(),
        })
    }

    pub fn start(&self, port: u16, resolver: MediaResolver) -> Result<Value, std::io::Error> {
        if let Some(p) = self.0.lock().running.as_ref().map(|r| r.port) {
            return Ok(json!({ "port": p, "ips": lan_addresses() }));
        }
        let router = Router::new()
            .route("/", get(page))
            .route("/index.html", get(page))
            .route("/stage", get(stage_page))
            .route("/stage.html", get(stage_page))
            .route("/events", get(events))
            .route("/ws", get(ws))
            .route("/bgstage.js", get(bgstage))
            .route("/link.js", get(link_js))
            .route("/fontfaces.js", get(fontfaces_js))
            .route("/media/{name}", get(media))
            .route("/fonts", get(font_faces))
            .route("/font/{id}", get(font_file))
            .fallback(|| async { sse::text(StatusCode::NOT_FOUND, "text/plain; charset=utf-8", "not found") })
            .layer(axum::middleware::from_fn(sse::guard_host))
            .with_state(self.clone())
            .into_make_service_with_connect_info::<std::net::SocketAddr>();
        let running = sse::serve_connect_info(port, router)?;
        let actual = running.port;
        let run = {
            let mut i = self.0.lock();
            i.stage_epoch = Instant::now();
            i.resolver = Some(resolver);
            i.running = Some(running);
            i.run += 1;
            i.run
        };
        // A comment line every 20 s keeps idle connections alive through
        // routers and lets a dead client be noticed and dropped.
        let me = self.clone();
        tauri::async_runtime::spawn(async move {
            loop {
                tokio::time::sleep(std::time::Duration::from_secs(20)).await;
                let mut i = me.0.lock();
                if i.running.is_none() || i.run != run {
                    break;
                }
                sse::send_all(&mut i.clients, ": ping\n\n", None);
            }
        });
        Ok(json!({ "port": actual, "ips": lan_addresses() }))
    }

    pub fn stop(&self) {
        let mut i = self.0.lock();
        i.clients.clear(); // ends every event stream, so the server can close
        // What was up when the output went off is not what is up when it comes
        // back: the projector may have been cleared meanwhile, and nothing is
        // broadcast while the output is off. The next start sends the current
        // slide again (windows::webcast_start).
        i.last_payload = None;
        i.last_stage = None;
        if let Some(mut r) = i.running.take() {
            if let Some(tx) = r.stop.take() {
                let _ = tx.send(());
            }
        }
    }
}

fn html(body: &'static str) -> Response<Body> {
    let mut r = sse::text(StatusCode::OK, "text/html; charset=utf-8", body);
    let h = r.headers_mut();
    h.insert(header::CACHE_CONTROL, HeaderValue::from_static("no-cache"));
    // The pages load nothing from outside: a colour value in an imported
    // stream theme can't make vMix or OBS fetch another site. "ws:" is there
    // because older browsers (the one inside some vMix versions) don't count
    // this server's own WebSocket as 'self'; only the page's own script, which
    // a theme can't change, opens sockets.
    h.insert(
        header::CONTENT_SECURITY_POLICY,
        HeaderValue::from_static(
            "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; \
             img-src 'self' data: blob:; media-src 'self' blob:; font-src 'self' data:; connect-src 'self' ws:; \
             object-src 'none'; base-uri 'none'; form-action 'none'",
        ),
    );
    h.insert(header::X_CONTENT_TYPE_OPTIONS, HeaderValue::from_static("nosniff"));
    h.insert(header::REFERRER_POLICY, HeaderValue::from_static("no-referrer"));
    r
}
async fn page() -> Response<Body> {
    html(PAGE)
}
async fn stage_page() -> Response<Body> {
    html(STAGE_PAGE)
}
fn script(body: &'static str) -> Response<Body> {
    let mut r = sse::text(StatusCode::OK, "application/javascript; charset=utf-8", body);
    r.headers_mut().insert(header::CACHE_CONTROL, HeaderValue::from_static("no-cache"));
    r.headers_mut().insert(header::X_CONTENT_TYPE_OPTIONS, HeaderValue::from_static("nosniff"));
    r
}
async fn bgstage() -> Response<Body> {
    script(BG_STAGE_JS)
}
async fn link_js() -> Response<Body> {
    script(LINK_JS)
}
async fn fontfaces_js() -> Response<Body> {
    script(FONTFACES_JS)
}

/// What a page needs the moment it connects: the look and what is up now.
fn first_messages(i: &Inner, stage: bool) -> Vec<String> {
    let mut first = vec!["retry: 2000\n\n".to_string()];
    if stage {
        first.push(sse::event("stage", &Webcast::stage_payload(i)));
        if let Some(s) = &i.last_stage {
            first.push(sse::event("stageSlide", s));
        }
    } else {
        first.push(sse::event("style", &i.style));
        if let Some(p) = &i.last_payload {
            first.push(sse::event("slide", p));
        }
    }
    first
}

/// The event stream. The pages use the WebSocket below; this stays for pages
/// that can't open one and for pages loaded from an older version.
async fn events(
    State(w): State<Webcast>,
    ConnectInfo(addr): ConnectInfo<std::net::SocketAddr>,
    Query(q): Query<HashMap<String, String>>,
) -> Response<Body> {
    let stage = q.get("role").map(|r| r == "stage").unwrap_or(false);
    let ip = Some(addr.ip().to_canonical());
    let mut i = w.0.lock();
    let first = first_messages(&i, stage);
    sse::admit(&mut i.clients, ip);
    // No cross-origin header: vMix, OBS and stage tablets load the page from
    // this same server, and other web sites must not read the stream.
    let (client, res) = sse::stream(if stage { TAG_STAGE } else { TAG_STREAM }, ip, first);
    i.clients.push(client);
    res
}

async fn ws(
    State(w): State<Webcast>,
    ConnectInfo(addr): ConnectInfo<std::net::SocketAddr>,
    Query(q): Query<HashMap<String, String>>,
    headers: axum::http::HeaderMap,
    upgrade: axum::extract::ws::WebSocketUpgrade,
) -> Response<Body> {
    // Browsers let any site open a WebSocket to any address, so the same
    // protection the event stream gets from the same-origin rule is checked
    // here by hand.
    if !sse::origin_ok(&headers) {
        return sse::text(StatusCode::FORBIDDEN, "text/plain; charset=utf-8", "forbidden");
    }
    let stage = q.get("role").map(|r| r == "stage").unwrap_or(false);
    let ip = Some(addr.ip().to_canonical());
    upgrade
        .max_message_size(4096)
        .max_frame_size(4096)
        .on_upgrade(move |socket| async move {
            let rx = {
                let mut i = w.0.lock();
                let (tx, rx) = sse::queue(first_messages(&i, stage));
                sse::admit(&mut i.clients, ip);
                i.clients.push(Client { tx, tag: if stage { TAG_STAGE } else { TAG_STREAM }, ip });
                rx
            };
            sse::run_ws(socket, rx).await;
        })
        .into_response()
}

/// The largest picture the stream gets. vMix and OBS draw a browser input at
/// the output size (1080p, sometimes 1440p); a phone photo of 6000×4000 sent
/// as it is costs the stream computer a 17 MB download and a long decode for
/// every slide, which shows up as a stutter in the broadcast.
const STREAM_MAX: (u32, u32) = (2560, 1440);

type Scaled = Option<(axum::body::Bytes, &'static str)>;
type ScaledCell = std::sync::Arc<once_cell::sync::OnceCell<Scaled>>;
static SCALED: once_cell::sync::Lazy<parking_lot::Mutex<Vec<((PathBuf, std::time::SystemTime, u64), ScaledCell)>>> =
    once_cell::sync::Lazy::new(|| parking_lot::Mutex::new(Vec::new()));

/// A smaller copy of a large picture for the stream (kept for the session),
/// or None when the original is already small enough or isn't a picture.
/// Two requests for the same picture wait for one resize instead of doing two.
pub fn stream_picture(path: &std::path::Path) -> Scaled {
    let ext = crate::store::extname(&path.to_string_lossy()).to_lowercase();
    if !matches!(ext.as_str(), ".jpg" | ".jpeg" | ".png" | ".webp" | ".bmp") {
        return None;
    }
    let meta = std::fs::metadata(path).ok()?;
    let key = (path.to_path_buf(), meta.modified().ok()?, meta.len());
    let cell = {
        let mut list = SCALED.lock();
        if let Some((_, c)) = list.iter().find(|(k, _)| *k == key) {
            c.clone()
        } else {
            let c: ScaledCell = Default::default();
            list.push((key, c.clone()));
            if list.len() > 32 {
                list.remove(0);
            }
            c
        }
    };
    cell.get_or_init(|| {
        use image::metadata::Orientation as O;
        use image::ImageDecoder;
        let mut decoder = image::ImageReader::open(path).ok()?.with_guessed_format().ok()?.into_decoder().ok()?;
        let (w, h) = decoder.dimensions();
        // Phone photos are stored sideways with a note saying which way is up.
        // Browsers follow the note for the original file; the smaller copy
        // made here has no note, so it is turned the right way round itself.
        let orientation = decoder.orientation().unwrap_or(O::NoTransforms);
        let turned = matches!(orientation, O::Rotate90 | O::Rotate270 | O::Rotate90FlipH | O::Rotate270FlipH);
        let (shown_w, shown_h) = if turned { (h, w) } else { (w, h) };
        if shown_w <= STREAM_MAX.0 && shown_h <= STREAM_MAX.1 {
            return None;
        }
        let img = image::DynamicImage::from_decoder(decoder).ok()?;
        // thumbnail(): a box filter, three times faster than resize() and as good when shrinking this much.
        let (box_w, box_h) = if turned { (STREAM_MAX.1, STREAM_MAX.0) } else { STREAM_MAX };
        let mut img = img.thumbnail(box_w, box_h);
        img.apply_orientation(orientation);
        let mut out = Vec::new();
        if img.color().has_alpha() {
            img.write_to(&mut std::io::Cursor::new(&mut out), image::ImageFormat::Png).ok()?;
            Some((axum::body::Bytes::from(out), "image/png"))
        } else {
            let enc = image::codecs::jpeg::JpegEncoder::new_with_quality(&mut out, 90);
            img.to_rgb8().write_with_encoder(enc).ok()?;
            Some((axum::body::Bytes::from(out), "image/jpeg"))
        }
    })
    .clone()
}

/// Starts making the stream copy of a picture the moment it is put on the
/// output, so it is (nearly) ready when vMix or OBS asks for it.
pub fn prewarm(path: PathBuf) {
    std::thread::spawn(move || {
        let _ = stream_picture(&path);
    });
}

/// Files sent to the stream, by opaque id; byte ranges are honoured (video
/// players need them). Large pictures go out as a smaller copy.
async fn media(State(w): State<Webcast>, AxPath(name): AxPath<String>, req: Request) -> Response<Body> {
    let name = crate::store::basename(&name);
    let resolver = w.0.lock().resolver.clone();
    let Some(path) = resolver.and_then(|r| r(&name)).filter(|p| p.is_file()) else {
        return sse::text(StatusCode::NOT_FOUND, "text/plain; charset=utf-8", "not found");
    };
    let p2 = path.clone();
    if let Ok(Some((bytes, mime))) = tokio::task::spawn_blocking(move || stream_picture(&p2)).await {
        let mut r = Response::new(Body::from(bytes)); // shared, not copied per request
        let h = r.headers_mut();
        h.insert(header::CONTENT_TYPE, HeaderValue::from_static(mime));
        h.insert(header::CACHE_CONTROL, HeaderValue::from_static("private, max-age=3600"));
        h.insert(header::X_CONTENT_TYPE_OPTIONS, HeaderValue::from_static("nosniff"));
        return r;
    }
    let mime = mime_guess::from_path(&path).first_or_octet_stream();
    match ServeFile::new_with_mime(&path, &mime).oneshot(req).await {
        Ok(r) => {
            let mut r = r.map(Body::new).into_response();
            r.headers_mut().insert(header::X_CONTENT_TYPE_OPTIONS, HeaderValue::from_static("nosniff"));
            r
        }
        Err(_) => sse::text(StatusCode::NOT_FOUND, "text/plain; charset=utf-8", "not found"),
    }
}

/// The files of one font family, for the live page's @font-face: vMix may run
/// on a computer that doesn't have the font, and even on the same computer its
/// browser may not see it (see fonts.rs). Ids only — no paths or file names.
async fn font_faces(axum::extract::Query(q): axum::extract::Query<std::collections::HashMap<String, String>>) -> Response<Body> {
    let fam = q.get("family").map(|s| s.as_str()).unwrap_or("");
    let cat = tauri::async_runtime::spawn_blocking(crate::fonts::catalog).await.unwrap_or_default();
    let faces: Vec<Value> = cat
        .faces(fam)
        .iter()
        .map(|f| json!({ "url": format!("/font/{}", f.id), "weight": f.weight,
            "style": if f.italic { "italic" } else { "normal" }, "stretch": f.stretch }))
        .collect();
    let mut r = sse::text(StatusCode::OK, "application/json", json!({ "faces": faces }).to_string());
    r.headers_mut().insert(header::CACHE_CONTROL, HeaderValue::from_static("no-cache"));
    r
}

async fn font_file(AxPath(id): AxPath<String>, req: axum::extract::Request) -> Response<Body> {
    let not_found = || sse::text(StatusCode::NOT_FOUND, "text/plain; charset=utf-8", "not found");
    let cat = tauri::async_runtime::spawn_blocking(crate::fonts::catalog).await.unwrap_or_default();
    let Some(fp) = cat.file(&id).cloned() else { return not_found() };
    let mime = mime_guess::from_path(&fp).first_or_octet_stream();
    match tower::ServiceExt::oneshot(tower_http::services::ServeFile::new_with_mime(&fp, &mime), req).await {
        Ok(r) => {
            let mut r = r.map(Body::new).into_response();
            r.headers_mut().insert(header::CACHE_CONTROL, HeaderValue::from_static("max-age=86400"));
            r.headers_mut().insert(header::X_CONTENT_TYPE_OPTIONS, HeaderValue::from_static("nosniff"));
            r
        }
        Err(_) => not_found(),
    }
}
