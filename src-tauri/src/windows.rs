//! The two windows (control and projector), where the projector goes when
//! displays come and go, and what reaches the projector and the stream.

use crate::state::{self, AppState};
use crate::store;
use serde_json::{json, Value};
use sha1::{Digest, Sha1};
use std::path::PathBuf;
use std::sync::Arc;
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter, LogicalSize, Manager, Monitor, PhysicalPosition, PhysicalSize, WebviewUrl, WebviewWindow, WebviewWindowBuilder, Window, WindowEvent};

type R = Result<Value, String>;

// WebView2 (Windows): announcement videos start on their own, with sound.
// The default Tauri switches are repeated because this list replaces them.
#[cfg(windows)]
const BROWSER_ARGS: &str = "--disable-features=msWebOOUI,msPdfOOUI,msSmartScreenProtection --autoplay-policy=no-user-gesture-required";

fn st(app: &AppHandle) -> Arc<AppState> {
    app.state::<Arc<AppState>>().inner().clone()
}

/// Neither window is a browser: a stray drop or link must never navigate it
/// away from the app (a blank control panel mid-service).
fn is_app_url(url: &tauri::Url) -> bool {
    url.scheme() == "tauri" || url.host_str() == Some("tauri.localhost") || url.scheme() == "about"
}

pub fn create_control(app: &AppHandle) -> tauri::Result<WebviewWindow> {
    let st = st(app);
    // Open at a size that fits the screen it lands on.
    let (mut w, mut h) = (1440.0, 900.0);
    if let Ok(Some(m)) = app.primary_monitor() {
        let s = m.scale_factor();
        let wa = m.work_area().size;
        w = (wa.width as f64 / s - 40.0).clamp(980.0, 1440.0);
        h = (wa.height as f64 / s - 40.0).clamp(640.0, 900.0);
    }
    let mut b = WebviewWindowBuilder::new(app, "control", WebviewUrl::App("renderer/control/index.html".into()))
        .title(format!("Bible Presenter {} — Control", st.version))
        .inner_size(w, h)
        .min_inner_size(980.0, 620.0)
        .center()
        .on_navigation(is_app_url)
        .disable_drag_drop_handler();
    #[cfg(windows)]
    {
        b = b.additional_browser_args(BROWSER_ARGS);
    }
    if let Some(js) = crate::migrate::init_script(&st.paths.root) {
        b = b.initialization_script(&js);
    }
    if st.test_mode {
        if let Ok(lang) = std::env::var("BP_TEST_LANG") {
            b = b.initialization_script(&format!("try{{localStorage.setItem('uiLang',{});}}catch(e){{}}", serde_json::to_string(&lang).unwrap()));
        }
    }
    b.build()
}

fn monitor_key(m: &Monitor) -> String {
    format!("{:?}|{:?}|{:?}", m.name(), m.position(), m.size())
}

/// The projector is the first display that is not the main one.
fn second_monitor(app: &AppHandle) -> Option<Monitor> {
    let primary = app.primary_monitor().ok().flatten();
    let all = app.available_monitors().ok()?;
    let pk = primary.as_ref().map(monitor_key);
    all.into_iter().find(|m| Some(monitor_key(m)) != pk)
}

pub fn create_output(app: &AppHandle) -> tauri::Result<WebviewWindow> {
    #[allow(unused_mut)]
    let mut b = WebviewWindowBuilder::new(app, "output", WebviewUrl::App("renderer/output/index.html".into()))
        .title("Bible Presenter — Output")
        .inner_size(1280.0, 720.0)
        .position(100.0, 100.0)
        // Shown without taking keyboard focus: typing in the control window
        // must keep going to the control window.
        .focused(false)
        .visible(false)
        .background_color(tauri::window::Color(0, 0, 0, 255))
        .on_navigation(is_app_url)
        .disable_drag_drop_handler();
    #[cfg(windows)]
    {
        b = b.additional_browser_args(BROWSER_ARGS);
    }
    let w = b.build()?;
    place_output(app, &w);
    Ok(w)
}

/// Full screen on the second display; a normal window when there is only one
/// screen, so it can't get stuck full screen over the control window.
fn place_output(app: &AppHandle, w: &WebviewWindow) {
    let second = second_monitor(app);
    #[cfg(target_os = "macos")]
    {
        // Native full screen gives the window its own Space; every switch to
        // the control window would flip the desktop. Simple full screen instead.
        let _ = w.set_simple_fullscreen(false);
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = w.set_fullscreen(false);
    }
    match second {
        Some(m) => {
            let _ = w.set_decorations(false);
            let pos = m.position();
            let size = m.size();
            let _ = w.set_position(PhysicalPosition::new(pos.x, pos.y));
            let _ = w.set_size(PhysicalSize::new(size.width, size.height));
            let _ = w.show();
            #[cfg(target_os = "macos")]
            {
                let _ = w.set_simple_fullscreen(true);
                let _ = w.set_visible_on_all_workspaces(true);
            }
            #[cfg(not(target_os = "macos"))]
            {
                let _ = w.set_fullscreen(true);
            }
        }
        None => {
            let _ = w.set_decorations(true);
            let _ = w.set_size(LogicalSize::new(1280.0, 720.0));
            let _ = w.set_position(tauri::LogicalPosition::new(100.0, 100.0));
            let _ = w.show();
        }
    }
    if let Some(c) = state::control(app) {
        let _ = c.set_focus();
    }
}

/// Displays plugged in or removed: the projector moves to wherever the
/// second display now is, keeping what it shows.
pub fn watch_displays(app: &AppHandle) {
    let app = app.clone();
    std::thread::spawn(move || {
        let sig = |app: &AppHandle| -> String {
            app.available_monitors().map(|v| v.iter().map(monitor_key).collect::<Vec<_>>().join(";")).unwrap_or_default()
        };
        let mut last = sig(&app);
        loop {
            std::thread::sleep(Duration::from_secs(2));
            let now = sig(&app);
            if now != last && !now.is_empty() {
                last = now;
                let a2 = app.clone();
                let _ = app.run_on_main_thread(move || {
                    if let Some(w) = state::output(&a2) {
                        place_output(&a2, &w);
                    }
                });
            }
        }
    });
}

pub fn on_window_event(window: &Window, event: &WindowEvent) {
    let app = window.app_handle();
    match (window.label(), event) {
        ("control", WindowEvent::CloseRequested { api, .. }) => {
            let st = st(app);
            let mut since = st.closing_since.lock();
            // The page saves the open song (or asks about an untitled one)
            // and then says app:quit. If the page does not answer, a second
            // close a few seconds later closes anyway.
            if let Some(t) = *since {
                if t.elapsed() > Duration::from_secs(4) {
                    crate::update::install_pending(app);
                    app.exit(0);
                    return;
                }
            }
            api.prevent_close();
            *since = Some(Instant::now());
            let _ = app.emit_to("control", "app:close-requested", ());
        }
        ("control", WindowEvent::Destroyed) => app.exit(0),
        // Closing the projector window by accident must not lose it for the
        // rest of the service: it is hidden and comes back with a display change.
        ("output", WindowEvent::CloseRequested { api, .. }) => {
            api.prevent_close();
            let _ = window.hide();
        }
        _ => {}
    }
}

pub fn on_control_loaded(webview: &tauri::Webview) {
    let app = webview.app_handle();
    let st = st(app);
    *st.closing_since.lock() = None;
    st.output.lock().last_seq = 0; // a reloaded page numbers its slides from 1 again
    if st.test_mode {
        if let Some(p) = std::env::var_os("BP_TEST") {
            if let Ok(js) = std::fs::read_to_string(p) {
                let w = webview.clone();
                std::thread::spawn(move || {
                    std::thread::sleep(Duration::from_millis(1500));
                    let _ = w.eval(&format!("(async()=>{{try{{\n{js}\n}}catch(e){{await bp.call('test:log','FAIL exception '+(e&&e.stack||e));await bp.call('test:exit');}}}})();"));
                });
            }
        }
    }
}

// ---------------------------------------------------------------- slides

pub fn show_slide(app: &AppHandle, st: &AppState, payload: Value) -> R {
    // Slides arrive numbered; one that was overtaken by a newer one is dropped.
    let seq = payload.get("__seq").and_then(|v| v.as_u64()).unwrap_or(0);
    {
        let mut o = st.output.lock();
        if seq != 0 {
            if seq < o.last_seq {
                return Ok(Value::Null);
            }
            o.last_seq = seq;
        }
        o.projector = Some(payload.clone());
    }
    if st.test_mode {
        let p = &payload;
        let desc = if p.get("video").map(|v| !v.is_null()).unwrap_or(false) {
            "VIDEO".to_string()
        } else if p.get("image").map(|v| !v.is_null()).unwrap_or(false) {
            "IMAGE".to_string()
        } else {
            let mut s = serde_json::to_string(p.get("text").and_then(|t| t.as_str()).unwrap_or("")).unwrap();
            if let Some(r) = p.get("reference").and_then(|r| r.as_str()).filter(|r| !r.is_empty()) {
                s.push_str(&format!(" @{r}"));
            }
            s
        };
        st.test_log.lock().push(desc);
    }
    if let Some(w) = state::output(app) {
        let _ = w.emit_to("output", "output:showSlide", payload.clone());
    }
    // Mirror to the live output (vMix/OBS). Local file links mean nothing to
    // another computer, so they become links to this server.
    if st.webcast.is_running() {
        let m = mirror(st, &payload);
        let blackout = {
            let mut o = st.output.lock();
            o.mirrored = Some(m.clone());
            o.stream_blackout
        };
        if !blackout {
            st.webcast.broadcast("slide", &m);
        }
        st.webcast.broadcast_stage(Some(&payload)); // the stage display follows the room
    }
    Ok(Value::Null)
}

pub fn clear(app: &AppHandle, st: &AppState, arg: &Value) -> R {
    {
        let mut o = st.output.lock();
        let seq = arg.get("__seq").and_then(|v| v.as_u64()).unwrap_or(0);
        if seq != 0 {
            if seq < o.last_seq {
                return Ok(Value::Null);
            }
            o.last_seq = seq;
        }
        o.projector = None;
        o.mirrored = None; // un-holding the stream must not bring a cleared slide back
    }
    if st.test_mode {
        st.test_log.lock().push("CLEAR".into());
    }
    if let Some(w) = state::output(app) {
        let _ = w.emit_to("output", "output:clear", ());
    }
    if st.webcast.is_running() {
        st.webcast.broadcast("clear", &json!({}));
        st.webcast.broadcast_stage(None);
    }
    Ok(Value::Null)
}

/// The projector page (re)loaded: give it the theme and what is on screen.
pub fn resend_to_output(app: &AppHandle, st: &AppState) {
    let (theme, payload) = {
        let o = st.output.lock();
        (o.theme.clone(), o.projector.clone())
    };
    if let Some(w) = state::output(app) {
        if let Some(t) = theme {
            let _ = w.emit_to("output", "output:setTheme", t);
        }
        if let Some(mut p) = payload {
            p["transitionMs"] = json!(0);
            let _ = w.emit_to("output", "output:showSlide", p);
        }
    }
}

/// A page link to a local file (asset protocol, file:// or a plain path) →
/// the path on disk.
pub fn url_to_path(u: &str) -> Option<PathBuf> {
    fn decode(s: &str) -> String {
        let b = s.as_bytes();
        let mut out = Vec::with_capacity(b.len());
        let mut i = 0;
        while i < b.len() {
            if b[i] == b'%' && i + 2 < b.len() {
                if let Ok(v) = u8::from_str_radix(&s[i + 1..i + 3], 16) {
                    out.push(v);
                    i += 3;
                    continue;
                }
            }
            out.push(b[i]);
            i += 1;
        }
        String::from_utf8_lossy(&out).to_string()
    }
    for prefix in ["asset://localhost/", "http://asset.localhost/", "https://asset.localhost/"] {
        if let Some(rest) = u.strip_prefix(prefix) {
            let rest = rest.split(['?', '#']).next().unwrap_or(rest);
            return Some(PathBuf::from(decode(rest)));
        }
    }
    if let Some(rest) = u.strip_prefix("file://") {
        let p = decode(rest);
        // file:///C:/x on Windows → C:/x
        #[cfg(windows)]
        let p = p.trim_start_matches('/').to_string();
        return Some(PathBuf::from(p));
    }
    let p = PathBuf::from(u);
    if p.is_absolute() { Some(p) } else { None }
}

/// Files sent to the live output are served under an opaque id; only files
/// registered here can be fetched, nothing else on disk.
fn to_media_url(st: &AppState, u: &str) -> String {
    match url_to_path(u) {
        Some(fp) => {
            let mut h = Sha1::new();
            h.update(fp.to_string_lossy().as_bytes());
            let id = format!("{}{}", &hex::encode(h.finalize())[..16], store::extname(&fp.to_string_lossy()).to_lowercase());
            st.stream_media.lock().insert(id.clone(), fp);
            format!("/media/{id}")
        }
        None => format!("/media/{}", store::basename(u)),
    }
}

fn mirror(st: &AppState, payload: &Value) -> Value {
    let mut p = payload.clone();
    for k in ["image", "video"] {
        if let Some(u) = p.get(k).and_then(|v| v.as_str()).map(String::from) {
            p[k] = json!(to_media_url(st, &u));
        }
    }
    if let Some(u) = p.pointer("/theme/bgUrl").and_then(|v| v.as_str()).map(String::from) {
        p["theme"]["bgUrl"] = json!(to_media_url(st, &u));
    }
    if let Some(o) = p.as_object_mut() {
        o.remove("__seq");
    }
    p
}

pub fn webcast_start(st: &AppState, arg: &Value) -> R {
    let port = arg.as_u64().filter(|p| *p > 0 && *p < 65536).unwrap_or(7777) as u16;
    let media = st.paths.media.clone();
    let registry = st.stream_media_handle();
    let resolver: crate::webcast::MediaResolver = Arc::new(move |name: &str| {
        if let Some(p) = registry.lock().get(name) {
            return Some(p.clone());
        }
        let legacy = media.join(store::basename(name)); // older links: media folder only
        legacy.exists().then_some(legacy)
    });
    match st.webcast.start(port, resolver) {
        Ok(info) => {
            let projector = st.output.lock().projector.clone();
            if let Some(p) = projector {
                let m = mirror(st, &p);
                let blackout = {
                    let mut o = st.output.lock();
                    o.mirrored = Some(m.clone());
                    o.stream_blackout
                };
                if !blackout {
                    st.webcast.broadcast("slide", &m);
                }
                st.webcast.broadcast_stage(Some(&p));
            }
            let mut out = json!({ "ok": true });
            for (k, v) in info.as_object().cloned().unwrap_or_default() {
                out[k] = v;
            }
            Ok(out)
        }
        Err(e) => Ok(json!({ "ok": false, "error": crate::sse::port_error(&e, port, &st.t("Порт {port} вже зайнятий іншою програмою.")) })),
    }
}
