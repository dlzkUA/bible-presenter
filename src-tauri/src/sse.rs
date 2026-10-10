//! Small shared pieces of the two network servers (live output and phone
//! remote): Server-Sent Event clients and starting/stopping a server.

use axum::body::{Body, Bytes};
use axum::http::{header, HeaderValue, Response, StatusCode};
use futures_util::StreamExt;
use std::convert::Infallible;
use tokio::sync::{mpsc, oneshot};
use tokio_stream::wrappers::ReceiverStream;

/// Events queued for one client before it counts as gone. A device that opens
/// the stream and never reads it would otherwise grow memory for the whole
/// service.
const QUEUE: usize = 256;
/// Open event streams per server. A church needs a handful (vMix, OBS, a few
/// stage tablets, phones); far more means someone is flooding the server.
pub const MAX_CLIENTS: usize = 64;
/// Open event streams per device. vMix and OBS on this same computer (one
/// stream per input or scene) are not limited; a device on the network that
/// opens too many replaces its own oldest one, so it can't take every place.
pub const MAX_PER_IP: usize = 16;

pub struct Client {
    pub tx: mpsc::Sender<String>,
    pub tag: u8,
    pub ip: Option<std::net::IpAddr>,
}

/// Makes room for a new stream from `ip`: the device's own oldest stream goes
/// when it has too many, and when the server is full the oldest stream of the
/// device holding the most goes. Nobody is ever refused.
pub fn admit(clients: &mut Vec<Client>, ip: Option<std::net::IpAddr>) {
    clients.retain(|c| c.alive());
    let local = ip.map(|i| i.is_loopback()).unwrap_or(false);
    if ip.is_some() && !local && clients.iter().filter(|c| c.ip == ip).count() >= MAX_PER_IP {
        if let Some(i) = clients.iter().position(|c| c.ip == ip) {
            clients.remove(i);
        }
    }
    if clients.len() >= MAX_CLIENTS {
        let mut counts: std::collections::HashMap<Option<std::net::IpAddr>, usize> = Default::default();
        for c in clients.iter() {
            *counts.entry(c.ip).or_default() += 1;
        }
        let busiest = counts.into_iter().max_by_key(|(_, n)| *n).map(|(k, _)| k);
        if let Some(i) = clients.iter().position(|c| Some(c.ip) == busiest) {
            clients.remove(i);
        }
    }
}

impl Client {
    pub fn alive(&self) -> bool {
        !self.tx.is_closed()
    }
}

/// A new event-stream response and the client handle that feeds it.
pub fn stream(tag: u8, ip: Option<std::net::IpAddr>, first: Vec<String>) -> (Client, Response<Body>) {
    let (tx, rx) = mpsc::channel::<String>(QUEUE);
    for m in first {
        let _ = tx.try_send(m);
    }
    let body = Body::from_stream(ReceiverStream::new(rx).map(|s| Ok::<Bytes, Infallible>(Bytes::from(s))));
    let mut res = Response::new(body);
    let h = res.headers_mut();
    h.insert(header::CONTENT_TYPE, HeaderValue::from_static("text/event-stream"));
    h.insert(header::CACHE_CONTROL, HeaderValue::from_static("no-cache, no-store"));
    h.insert(header::CONNECTION, HeaderValue::from_static("keep-alive"));
    h.insert("X-Accel-Buffering", HeaderValue::from_static("no"));
    h.insert(header::X_CONTENT_TYPE_OPTIONS, HeaderValue::from_static("nosniff"));
    (Client { tx, tag, ip }, res)
}

pub fn event(name: &str, data: &serde_json::Value) -> String {
    format!("event: {name}\ndata: {}\n\n", serde_json::to_string(data).unwrap_or_else(|_| "{}".into()))
}

/// Sends to every client still connected and forgets the rest.
/// Sends to every client still connected and forgets the rest, including any
/// whose queue is full because it stopped reading.
pub fn send_all(clients: &mut Vec<Client>, msg: &str, only: Option<u8>) {
    clients.retain(|c| {
        if !c.alive() {
            return false;
        }
        if only.map(|t| t == c.tag).unwrap_or(true) {
            return c.tx.try_send(msg.to_string()).is_ok();
        }
        true
    });
}

/// Requests must name this computer the way a device on the network does: an
/// IP address, "localhost", a bare computer name or a ".local" name. A web page
/// on some other site that points its own domain at this computer (DNS
/// rebinding) sends its domain instead and is refused.
pub fn host_ok(headers: &axum::http::HeaderMap) -> bool {
    let Some(h) = headers.get(header::HOST).and_then(|v| v.to_str().ok()) else { return true };
    let host = if let Some(rest) = h.strip_prefix('[') {
        rest.split(']').next().unwrap_or("")
    } else {
        h.rsplit_once(':').map(|(a, _)| a).unwrap_or(h)
    }
    .trim_end_matches('.')
    .to_ascii_lowercase();
    let ip_part = host.split('%').next().unwrap_or(""); // fe80::1%en0
    let first_label = host.split('.').next().unwrap_or("");
    ip_part.parse::<std::net::IpAddr>().is_ok()
        || host == "localhost"
        || host.ends_with(".localhost")
        || host.ends_with(".local")
        || (!host.is_empty() && !host.contains('.'))
        // This computer's own name under the router's domain (church-pc.lan,
        // church-pc.fritz.box): set up by the router, not by an outside site.
        || (!first_label.is_empty() && first_label == computer_name().as_str())
}

fn computer_name() -> &'static String {
    static NAME: once_cell::sync::Lazy<String> = once_cell::sync::Lazy::new(|| {
        let raw = std::env::var("COMPUTERNAME").ok().filter(|_| cfg!(windows)).or_else(|| {
            std::process::Command::new("hostname").output().ok().map(|o| String::from_utf8_lossy(&o.stdout).to_string())
        });
        raw.unwrap_or_default().trim().split('.').next().unwrap_or("").to_ascii_lowercase()
    });
    &NAME
}

/// Router layer that applies `host_ok` to every request.
pub async fn guard_host(req: axum::extract::Request, next: axum::middleware::Next) -> Response<Body> {
    if host_ok(req.headers()) {
        next.run(req).await
    } else {
        text(StatusCode::FORBIDDEN, "text/plain; charset=utf-8", "forbidden")
    }
}

pub fn text(status: StatusCode, content_type: &'static str, body: impl Into<Body>) -> Response<Body> {
    let mut r = Response::new(body.into());
    *r.status_mut() = status;
    r.headers_mut().insert(header::CONTENT_TYPE, HeaderValue::from_static(content_type));
    r
}

pub struct Running {
    pub port: u16,
    pub stop: Option<oneshot::Sender<()>>,
}

/// Binds the port (on every IPv4 interface) and serves the router until
/// stopped. Each request can see the client's address (per-device limits).
pub fn serve_connect_info(
    port: u16,
    svc: axum::extract::connect_info::IntoMakeServiceWithConnectInfo<axum::Router, std::net::SocketAddr>,
) -> Result<Running, std::io::Error> {
    let listener = bind(port)?;
    let actual = listener.local_addr().map(|a| a.port()).unwrap_or(port);
    let (stop, graceful, hard) = stopper();
    tauri::async_runtime::spawn(async move {
        let server = axum::serve(listener, svc).with_graceful_shutdown(graceful);
        tokio::select! { _ = server => {}, _ = hard => {} }
    });
    Ok(Running { port: actual, stop: Some(stop) })
}

fn bind(port: u16) -> Result<tokio::net::TcpListener, std::io::Error> {
    tauri::async_runtime::block_on(async move { tokio::net::TcpListener::bind(("0.0.0.0", port)).await })
}

/// A stop switch: the graceful signal fires at once; the hard one 1.5 s
/// later, so connections still open (a video being streamed) can't keep the
/// port busy.
fn stopper() -> (
    oneshot::Sender<()>,
    impl std::future::Future<Output = ()> + Send + 'static,
    impl std::future::Future<Output = ()> + Send + 'static,
) {
    let (tx, rx) = oneshot::channel::<()>();
    let (wtx, wrx) = tokio::sync::watch::channel(false);
    tauri::async_runtime::spawn(async move {
        let _ = rx.await;
        let _ = wtx.send(true);
    });
    let mut g = wrx.clone();
    let mut h = wrx;
    let graceful = async move {
        let _ = g.wait_for(|v| *v).await;
    };
    let hard = async move {
        let _ = h.wait_for(|v| *v).await;
        tokio::time::sleep(std::time::Duration::from_millis(1500)).await;
    };
    (tx, graceful, hard)
}

pub fn port_error(e: &std::io::Error, port: u16, busy_text: &str) -> String {
    if e.kind() == std::io::ErrorKind::AddrInUse {
        busy_text.replace("{port}", &port.to_string())
    } else {
        e.to_string()
    }
}
