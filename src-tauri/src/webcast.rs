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
            .route("/bgstage.js", get(bgstage))
            .route("/media/{name}", get(media))
            .fallback(|| async { sse::text(StatusCode::NOT_FOUND, "text/plain; charset=utf-8", "not found") })
            .layer(axum::middleware::from_fn(sse::guard_host))
            .with_state(self.clone())
            .into_make_service_with_connect_info::<std::net::SocketAddr>();
        let running = sse::serve_connect_info(port, router)?;
        let actual = running.port;
        {
            let mut i = self.0.lock();
            i.stage_epoch = Instant::now();
            i.resolver = Some(resolver);
            i.running = Some(running);
        }
        // A comment line every 20 s keeps idle connections alive through
        // routers and lets a dead client be noticed and dropped.
        let me = self.clone();
        tauri::async_runtime::spawn(async move {
            loop {
                tokio::time::sleep(std::time::Duration::from_secs(20)).await;
                let mut i = me.0.lock();
                if i.running.as_ref().map(|r| r.port) != Some(actual) {
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
    // stream theme can't make vMix or OBS fetch another site.
    h.insert(
        header::CONTENT_SECURITY_POLICY,
        HeaderValue::from_static(
            "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; \
             img-src 'self' data: blob:; media-src 'self' blob:; font-src 'self' data:; connect-src 'self'; \
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
async fn bgstage() -> Response<Body> {
    let mut r = sse::text(StatusCode::OK, "application/javascript; charset=utf-8", BG_STAGE_JS);
    r.headers_mut().insert(header::CACHE_CONTROL, HeaderValue::from_static("no-cache"));
    r
}

async fn events(
    State(w): State<Webcast>,
    ConnectInfo(addr): ConnectInfo<std::net::SocketAddr>,
    Query(q): Query<HashMap<String, String>>,
) -> Response<Body> {
    let stage = q.get("role").map(|r| r == "stage").unwrap_or(false);
    let mut i = w.0.lock();
    let mut first = vec!["retry: 2000\n\n".to_string()];
    if stage {
        first.push(sse::event("stage", &Webcast::stage_payload(&i)));
        if let Some(s) = &i.last_stage {
            first.push(sse::event("stageSlide", s));
        }
    } else {
        first.push(sse::event("style", &i.style));
        if let Some(p) = &i.last_payload {
            first.push(sse::event("slide", p));
        }
    }
    sse::admit(&mut i.clients, Some(addr.ip().to_canonical()));
    // No cross-origin header: vMix, OBS and stage tablets load the page from
    // this same server, and other web sites must not read the stream.
    let (client, res) = sse::stream(if stage { TAG_STAGE } else { TAG_STREAM }, Some(addr.ip().to_canonical()), first);
    i.clients.push(client);
    res
}

/// Files sent to the stream, by opaque id; byte ranges are honoured (video
/// players need them).
async fn media(State(w): State<Webcast>, AxPath(name): AxPath<String>, req: Request) -> Response<Body> {
    let name = crate::store::basename(&name);
    let resolver = w.0.lock().resolver.clone();
    let Some(path) = resolver.and_then(|r| r(&name)).filter(|p| p.is_file()) else {
        return sse::text(StatusCode::NOT_FOUND, "text/plain; charset=utf-8", "not found");
    };
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
