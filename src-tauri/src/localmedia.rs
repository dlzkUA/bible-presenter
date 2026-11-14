//! Pictures and clips for the app's own windows (projector, control), and the
//! files of installed fonts (fonts.rs), served over plain HTTP on this
//! computer only.
//!
//! On Windows the web view fetches files through Tauri's asset protocol by
//! handing every request — and every chunk of a playing video — to the app
//! through WebView2's custom-scheme callback. Under load (vMix running on the
//! same computer) that path is what stutters: videos drop frames and big
//! photos arrive late. A loopback HTTP server is read by the web view's own
//! network stack instead, with byte ranges and caching like any web page.
//!
//! Only this computer can connect (it listens on 127.0.0.1), only the media
//! and backgrounds folders are served, file names pass through `basename`, and
//! every address carries a random token, so a web page open in a browser on
//! this computer can't guess its way to the operator's pictures.

use crate::sse;
use crate::store::{self, Paths};
use axum::body::Body;
use axum::extract::{ConnectInfo, Path as AxPath, Request, State};
use axum::http::{header, HeaderValue, Response, StatusCode};
use axum::response::IntoResponse;
use axum::routing::get;
use axum::Router;
use std::path::PathBuf;
use std::sync::Arc;
use tower::ServiceExt;
use tower_http::services::ServeFile;

pub struct Local {
    pub base: String,
    _running: sse::Running,
}

#[derive(Clone)]
struct Ctx {
    token: Arc<String>,
    host: Arc<String>,
    media: PathBuf,
    backgrounds: PathBuf,
}

/// Used on Windows, where the asset protocol is the slow path. Elsewhere the
/// asset protocol stays (a development build can try this with BP_LOCAL_MEDIA=1).
pub fn wanted() -> bool {
    cfg!(windows) || (cfg!(debug_assertions) && std::env::var_os("BP_LOCAL_MEDIA").is_some())
}

pub fn start(paths: &Paths) -> Result<Local, std::io::Error> {
    let token = store::random_hex(16);
    let listener = tauri::async_runtime::block_on(async { tokio::net::TcpListener::bind(("127.0.0.1", 0)).await })?;
    let port = listener.local_addr()?.port();
    let ctx = Ctx {
        token: Arc::new(token.clone()),
        host: Arc::new(format!("127.0.0.1:{port}")),
        media: paths.media.clone(),
        backgrounds: paths.backgrounds.clone(),
    };
    let router = Router::new()
        .route("/{token}/{kind}/{name}", get(file))
        .fallback(|| async { sse::text(StatusCode::NOT_FOUND, "text/plain; charset=utf-8", "not found") })
        .with_state(ctx)
        .into_make_service_with_connect_info::<std::net::SocketAddr>();
    let running = sse::serve_listener(listener, router);
    Ok(Local { base: format!("http://127.0.0.1:{port}/{token}/"), _running: running })
}

/// The file a URL from `start`'s base points to, for code that needs the path
/// back (the live output mirrors the projector by path).
pub fn path_for(base: &str, paths: &Paths, url: &str) -> Option<PathBuf> {
    let rest = url.strip_prefix(base)?;
    let rest = rest.split(['?', '#']).next().unwrap_or(rest);
    let (kind, name) = rest.split_once('/')?;
    let dir = match kind {
        "m" => &paths.media,
        "b" => &paths.backgrounds,
        _ => return None,
    };
    let name = store::basename(&percent_decode(name));
    let fp = dir.join(&name);
    store::inside(dir, &fp).then_some(fp)
}

/// "%D0%B0" → "а". Works on bytes: a "%" in front of a non-Latin letter (a
/// file called "100%€.jpg") must not cut that letter in half.
pub(crate) fn percent_decode(s: &str) -> String {
    fn hex(b: u8) -> Option<u8> {
        (b as char).to_digit(16).map(|d| d as u8)
    }
    let b = s.as_bytes();
    let mut out = Vec::with_capacity(b.len());
    let mut i = 0;
    while i < b.len() {
        if b[i] == b'%' && i + 2 < b.len() {
            if let (Some(hi), Some(lo)) = (hex(b[i + 1]), hex(b[i + 2])) {
                out.push(hi << 4 | lo);
                i += 3;
                continue;
            }
        }
        out.push(b[i]);
        i += 1;
    }
    String::from_utf8_lossy(&out).to_string()
}

async fn file(
    State(c): State<Ctx>,
    ConnectInfo(peer): ConnectInfo<std::net::SocketAddr>,
    AxPath((token, kind, name)): AxPath<(String, String, String)>,
    req: Request,
) -> Response<Body> {
    let not_found = || sse::text(StatusCode::NOT_FOUND, "text/plain; charset=utf-8", "not found");
    // This computer only, under its own address (no DNS rebinding), with the token.
    let host_ok = req.headers().get(header::HOST).and_then(|h| h.to_str().ok()) == Some(c.host.as_str());
    if !peer.ip().to_canonical().is_loopback() || !host_ok || !same(&token, &c.token) {
        return not_found();
    }
    let fp = if kind == "f" {
        // An installed font, by the id the font scan gave it (fonts.rs).
        match crate::fonts::catalog().file(&name) {
            Some(p) => p.clone(),
            None => return not_found(),
        }
    } else {
        let dir = match kind.as_str() {
            "m" => &c.media,
            "b" => &c.backgrounds,
            _ => return not_found(),
        };
        let name = store::basename(&name);
        let fp = dir.join(&name);
        if name.is_empty() || !store::inside(dir, &fp) {
            return not_found();
        }
        fp
    };
    if !fp.is_file() {
        return not_found();
    }
    let mime = mime_guess::from_path(&fp).first_or_octet_stream();
    // The control window reads a still frame of a background into a canvas
    // (crossOrigin="anonymous"), which needs a CORS answer — for the app's
    // own pages only, never for a web site.
    let app_origin = req
        .headers()
        .get(header::ORIGIN)
        .and_then(|o| o.to_str().ok())
        .filter(|o| matches!(*o, "http://tauri.localhost" | "https://tauri.localhost" | "tauri://localhost"))
        .and_then(|o| HeaderValue::from_str(o).ok());
    match ServeFile::new_with_mime(&fp, &mime).oneshot(req).await {
        Ok(r) => {
            let mut r = r.map(Body::new).into_response();
            let h = r.headers_mut();
            h.insert(header::X_CONTENT_TYPE_OPTIONS, HeaderValue::from_static("nosniff"));
            h.insert(header::CACHE_CONTROL, HeaderValue::from_static("private, max-age=600"));
            // Always: a copy cached for a plain <img> must not answer a CORS read.
            h.insert(header::VARY, HeaderValue::from_static("Origin"));
            if let Some(o) = app_origin {
                h.insert(header::ACCESS_CONTROL_ALLOW_ORIGIN, o);
            }
            r
        }
        Err(_) => not_found(),
    }
}

fn same(a: &str, b: &str) -> bool {
    a.len() == b.len() && a.bytes().zip(b.bytes()).fold(0u8, |acc, (x, y)| acc | (x ^ y)) == 0
}
