//! Small shared pieces of the two network servers (live output and phone
//! remote): Server-Sent Event clients and starting/stopping a server.

use axum::body::{Body, Bytes};
use axum::http::{header, HeaderValue, Response, StatusCode};
use futures_util::StreamExt;
use std::convert::Infallible;
use tokio::sync::{mpsc, oneshot};
use tokio_stream::wrappers::UnboundedReceiverStream;

pub struct Client {
    pub tx: mpsc::UnboundedSender<String>,
    pub tag: u8,
}

impl Client {
    pub fn alive(&self) -> bool {
        !self.tx.is_closed()
    }
}

/// A new event-stream response and the client handle that feeds it.
pub fn stream(tag: u8, first: Vec<String>) -> (Client, Response<Body>) {
    let (tx, rx) = mpsc::unbounded_channel::<String>();
    for m in first {
        let _ = tx.send(m);
    }
    let body = Body::from_stream(UnboundedReceiverStream::new(rx).map(|s| Ok::<Bytes, Infallible>(Bytes::from(s))));
    let mut res = Response::new(body);
    let h = res.headers_mut();
    h.insert(header::CONTENT_TYPE, HeaderValue::from_static("text/event-stream"));
    h.insert(header::CACHE_CONTROL, HeaderValue::from_static("no-cache, no-store"));
    h.insert(header::CONNECTION, HeaderValue::from_static("keep-alive"));
    h.insert("X-Accel-Buffering", HeaderValue::from_static("no"));
    (Client { tx, tag }, res)
}

pub fn event(name: &str, data: &serde_json::Value) -> String {
    format!("event: {name}\ndata: {}\n\n", serde_json::to_string(data).unwrap_or_else(|_| "{}".into()))
}

/// Sends to every client still connected and forgets the rest.
pub fn send_all(clients: &mut Vec<Client>, msg: &str, only: Option<u8>) {
    clients.retain(|c| c.alive());
    for c in clients.iter() {
        if only.map(|t| t == c.tag).unwrap_or(true) {
            let _ = c.tx.send(msg.to_string());
        }
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
/// stopped.
pub fn serve(port: u16, router: axum::Router) -> Result<Running, std::io::Error> {
    let listener = bind(port)?;
    let actual = listener.local_addr().map(|a| a.port()).unwrap_or(port);
    let (stop, graceful, hard) = stopper();
    tauri::async_runtime::spawn(async move {
        let server = axum::serve(listener, router).with_graceful_shutdown(graceful);
        tokio::select! { _ = server => {}, _ = hard => {} }
    });
    Ok(Running { port: actual, stop: Some(stop) })
}

/// The same, for a server that needs to know each client's address.
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
