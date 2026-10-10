// Bible Presenter — presentation software for churches.
//
// The Rust core owns the data folder, the windows, the live-output server and
// the phone remote; the pages (app/renderer) are the interface and talk to it
// through one command, `api`, with a channel name such as "songs:list".
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod bible;
mod dialogs;
mod fonts;
mod lan;
mod library;
mod migrate;
mod present;
mod propres;
mod remote;
mod rtf;
mod sse;
mod state;
mod store;
mod update;
mod webcast;
mod windows;

#[cfg(test)]
mod integration_tests;

use serde_json::{json, Value};
use state::{AppState, Upload};
use std::io::Write;
use std::sync::Arc;
use tauri::{AppHandle, Emitter, Manager};

type R = Result<Value, String>;


fn main() {
    let paths = store::Paths::new();
    let remote_cfg = remote::load_config(&paths);
    // Test hooks exist only in development builds: in a released copy an
    // environment variable must not be able to run scripts inside the app.
    let test_mode = cfg!(debug_assertions) && std::env::var_os("BP_TEST").is_some();
    let context = tauri::generate_context!();
    let st = Arc::new(AppState::new(paths, context.package_info().version.to_string(), remote_cfg, test_mode));

    let mut builder = tauri::Builder::default();
    // A second launch only brings the running copy to the front: a stray
    // second instance can keep the old .exe locked during an update. (Not in
    // the automated test, which must run next to the operator's own copy.)
    if !test_mode {
        builder = builder.plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            if let Some(w) = state::control(app) {
                let _ = w.unminimize();
                let _ = w.show();
                let _ = w.set_focus();
            }
        }));
    }
    let app = builder
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .manage(st.clone())
        .invoke_handler(tauri::generate_handler![api, api_sync, upload_chunk, job_pdf, job_slide])
        .on_page_load(|webview, payload| {
            if payload.event() == tauri::webview::PageLoadEvent::Finished && webview.label() == "control" {
                windows::on_control_loaded(webview);
            }
        })
        .on_window_event(windows::on_window_event)
        .setup(move |app| {
            let handle = app.handle().clone();
            // Media files are shown through the asset protocol; allow exactly
            // the data folder.
            let _ = app.asset_protocol_scope().allow_directory(&st.paths.root, true);
            windows::create_control(&handle)?;
            windows::create_output(&handle)?;
            windows::watch_displays(&handle);
            autostart_remote(&handle);
            update::start_background_check(&handle);
            Ok(())
        })
        .build(context)
        .expect("error while building Bible Presenter");

    app.run(|handle, event| {
        if let tauri::RunEvent::Exit = event {
            let st = handle.state::<Arc<AppState>>();
            st.webcast.stop();
            st.remote.stop();
        }
    });
}

fn state(app: &AppHandle) -> Arc<AppState> {
    app.state::<Arc<AppState>>().inner().clone()
}

/// Everything the pages ask for. Runs off the main thread: dialogs, imports
/// and downloads may take a while.
#[tauri::command]
async fn api(app: AppHandle, ch: String, arg: Option<Value>) -> R {
    let arg = arg.unwrap_or(Value::Null);
    tauri::async_runtime::spawn_blocking(move || dispatch(&app, &ch, &arg))
        .await
        .map_err(|e| e.to_string())?
}

/// The few messages whose ORDER matters (slides to the projector, state for
/// the phone): handled one after another as they arrive.
#[tauri::command]
fn api_sync(app: AppHandle, ch: String, arg: Option<Value>) -> R {
    let arg = arg.unwrap_or(Value::Null);
    let st = state(&app);
    match ch.as_str() {
        "output:showSlide" => windows::show_slide(&app, &st, arg),
        "output:clear" => windows::clear(&app, &st, &arg),
        "output:setTheme" => {
            st.output.lock().theme = Some(arg.clone());
            if let Some(w) = state::output(&app) {
                let _ = w.emit_to(w.label(), "output:setTheme", arg);
            }
            Ok(Value::Null)
        }
        "output:ready" => {
            windows::resend_to_output(&app, &st);
            Ok(Value::Null)
        }
        "output:key" => {
            if let Some(w) = state::control(&app) {
                let _ = w.emit_to("control", "clicker:nav", arg);
            }
            Ok(Value::Null)
        }
        "remote:state" => {
            remote_state(&st, arg);
            Ok(Value::Null)
        }
        _ => dispatch(&app, &ch, &arg),
    }
}

/// A chunk of a file dropped onto the window (see bridge.js).
#[tauri::command]
fn upload_chunk(app: AppHandle, request: tauri::ipc::Request<'_>) -> R {
    let st = state(&app);
    let id = request.headers().get("x-upload").and_then(|v| v.to_str().ok()).unwrap_or("").to_string();
    let tauri::ipc::InvokeBody::Raw(bytes) = request.body() else { return Err("bad upload".into()) };
    let mut ups = st.uploads.lock();
    let up = ups.get_mut(&id).ok_or("bad upload")?;
    let mut f = std::fs::OpenOptions::new().append(true).open(&up.path).map_err(|e| e.to_string())?;
    f.write_all(bytes).map_err(|e| e.to_string())?;
    up.written += bytes.len() as u64;
    Ok(Value::Null)
}

#[tauri::command]
fn job_pdf(app: AppHandle, id: String) -> Result<tauri::ipc::Response, String> {
    present::job_pdf(&state(&app), &id).map(tauri::ipc::Response::new)
}

#[tauri::command]
fn job_slide(app: AppHandle, request: tauri::ipc::Request<'_>) -> R {
    let h = request.headers();
    let id = h.get("x-job").and_then(|v| v.to_str().ok()).unwrap_or("").to_string();
    let name = h.get("x-name").and_then(|v| v.to_str().ok()).unwrap_or("").to_string();
    let tauri::ipc::InvokeBody::Raw(bytes) = request.body() else { return Err("PDF_UNREADABLE: page".into()) };
    present::job_slide(&state(&app), &id, &name, bytes).map(|_| Value::Null)
}

fn dispatch(app: &AppHandle, ch: &str, arg: &Value) -> R {
    let st = state(app);
    let st = st.as_ref();
    match ch {
        "system:setUiStrings" => {
            let mut ui = st.ui.lock();
            ui.lang = store::str_of(arg, "lang").to_string();
            ui.strings = arg
                .get("strings")
                .and_then(|s| s.as_object())
                .map(|o| o.iter().filter_map(|(k, v)| v.as_str().map(|s| (k.clone(), s.to_string()))).collect())
                .unwrap_or_default();
            Ok(json!(true))
        }
        "system:appInfo" => {
            let exe = std::env::current_exe().ok().and_then(|p| p.parent().map(|d| d.to_string_lossy().to_string()));
            Ok(json!({ "version": st.version, "buildDate": st.build_date, "dataDir": st.paths.root.to_string_lossy(), "exeDir": exe }))
        }
        "system:listFonts" => {
            let mut cache = st.fonts.lock();
            if cache.is_none() {
                *cache = Some(fonts::scan_installed_fonts());
            }
            Ok(json!(cache.clone().unwrap_or_default()))
        }
        "system:openExternal" => {
            let url = arg.as_str().unwrap_or("");
            if url.starts_with("https://") {
                use tauri_plugin_opener::OpenerExt;
                let _ = app.opener().open_url(url, None::<&str>);
            }
            Ok(Value::Null)
        }
        "system:checkForUpdates" => Ok(update::check_now(app, &st.version)),
        "app:quit" => {
            update::install_pending(app);
            app.exit(0);
            Ok(Value::Null)
        }

        // ---- live output ----
        "webcast:status" => Ok(st.webcast.status()),
        "webcast:start" => windows::webcast_start(st, arg),
        "webcast:stop" => {
            st.webcast.stop();
            Ok(json!({ "ok": true }))
        }
        "webcast:setStyle" => Ok(st.webcast.set_style(arg)),
        "webcast:getStyle" => Ok(st.webcast.get_style()),
        "webcast:setStage" => Ok(st.webcast.set_stage_config(arg)),
        "webcast:getStage" => Ok(st.webcast.get_stage_config()),
        "webcast:resetStageTimer" => {
            st.webcast.reset_stage_timer();
            Ok(json!(true))
        }
        "webcast:setBlackout" => {
            let on = arg.as_bool().unwrap_or(false);
            let mirrored = {
                let mut o = st.output.lock();
                o.stream_blackout = on;
                o.mirrored.clone()
            };
            if st.webcast.is_running() {
                if on {
                    st.webcast.broadcast("clear", &json!({}));
                } else if let Some(m) = mirrored {
                    st.webcast.broadcast("slide", &m);
                }
            }
            Ok(json!(on))
        }
        "webcast:clear" => {
            if st.webcast.is_running() {
                st.webcast.broadcast("clear", &json!({}));
            }
            Ok(json!(true))
        }

        // ---- phone remote ----
        "remote:status" => {
            let cfg = st.remote_cfg.lock().clone();
            let mut s = st.remote.status();
            if s["port"].is_null() {
                s["port"] = json!(cfg.port);
            }
            s["enabled"] = json!(cfg.enabled);
            s["pin"] = json!(cfg.pin);
            s["key"] = json!(cfg.key);
            s["error"] = json!(st.remote.last_error());
            Ok(s)
        }
        "remote:start" => {
            let cfg_port = st.remote_cfg.lock().port;
            let port = arg.as_u64().filter(|p| *p > 0 && *p < 65536).map(|p| p as u16).unwrap_or(cfg_port);
            if st.remote.is_running() && st.remote.status()["port"].as_u64() != Some(port as u64) {
                st.remote.stop();
            }
            match start_remote(app, st, port) {
                Ok(_) => {
                    let mut cfg = st.remote_cfg.lock();
                    cfg.enabled = true;
                    cfg.port = port;
                    remote::save_config(&st.paths, &cfg);
                    Ok(json!({ "ok": true }))
                }
                Err(e) => Ok(json!({ "ok": false, "error": e })),
            }
        }
        "remote:stop" => {
            st.remote.stop();
            st.remote.set_last_error("");
            let mut cfg = st.remote_cfg.lock();
            cfg.enabled = false;
            remote::save_config(&st.paths, &cfg);
            Ok(json!({ "ok": true }))
        }
        "remote:reset" => {
            let mut cfg = st.remote_cfg.lock();
            cfg.key = remote::new_key();
            cfg.pin = remote::new_pin();
            remote::save_config(&st.paths, &cfg);
            st.remote.set_credentials(&cfg.key, &cfg.pin);
            Ok(json!(true))
        }
        "remote:qr" => {
            let text = arg.as_str().unwrap_or("").chars().take(500).collect::<String>();
            let code = qrcode::QrCode::with_error_correction_level(text.as_bytes(), qrcode::EcLevel::M).map_err(|e| e.to_string())?;
            let svg = code.render::<qrcode::render::svg::Color>().quiet_zone(true).module_dimensions(5, 5).build();
            let svg = match svg.find("<svg") {
                Some(i) => svg[i..].to_string(),
                None => svg,
            };
            Ok(json!(svg))
        }

        // ---- files dropped onto the window ----
        "upload:begin" => {
            let name = store::basename(store::str_of(arg, "name"));
            let id = store::random_hex(8);
            let _ = std::fs::create_dir_all(&st.paths.uploads);
            let path = st.paths.uploads.join(format!("{id}{}", store::extname(&name).to_lowercase()));
            std::fs::File::create(&path).map_err(|e| e.to_string())?;
            st.uploads.lock().insert(id.clone(), Upload { path, name, written: 0 });
            Ok(json!(id))
        }
        "upload:end" => {
            let up = st.uploads.lock().remove(store::str_of(arg, "id")).ok_or("bad upload")?;
            Ok(json!({ "path": up.path.to_string_lossy(), "name": up.name, "temp": true }))
        }
        "upload:cancel" => {
            if let Some(up) = st.uploads.lock().remove(store::str_of(arg, "id")) {
                store::remove_file_quiet(&up.path);
            }
            Ok(Value::Null)
        }

        // ---- automated tests only ----
        c if c.starts_with("test:") => test_channel(app, st, c, arg),

        _ => library::handle(app, st, ch, arg)
            .or_else(|| bible::handle(app, st, ch, arg))
            .or_else(|| propres::handle(app, st, ch, arg))
            .or_else(|| present::handle(app, st, ch, arg))
            .unwrap_or_else(|| Err(format!("Unknown channel {ch}"))),
    }
}

/// The control window sends what the phone should show; file paths for the
/// slide previews stay here, the phone only learns that a preview exists.
fn remote_state(st: &AppState, mut patch: Value) {
    let mut files = None;
    if let Some(slides) = patch.get_mut("slides").and_then(|s| s.as_array_mut()) {
        let mut list = Vec::with_capacity(slides.len());
        for s in slides.iter_mut() {
            // Only pictures from the data folder go to the phone.
            let img = s
                .get("img")
                .and_then(|v| v.as_str())
                .map(std::path::PathBuf::from)
                .filter(|p| p.is_absolute() && st.paths.shareable(p));
            let video = s.get("v").and_then(|v| v.as_bool()).unwrap_or(false);
            if let Some(o) = s.as_object_mut() {
                o.remove("img");
                o.insert("th".into(), json!(img.is_some() && !video));
            }
            list.push(if video { None } else { img });
        }
        files = Some(list);
    }
    st.remote.set_state(patch, files);
}

fn start_remote(app: &AppHandle, st: &AppState, port: u16) -> Result<u16, String> {
    let (key, pin) = {
        let c = st.remote_cfg.lock();
        (c.key.clone(), c.pin.clone())
    };
    st.remote.set_library_dirs(st.paths.media.clone(), st.paths.presentations.clone());
    let handle = app.clone();
    let hook: remote::CommandHook = Arc::new(move |cmd| {
        let _ = handle.emit_to("control", "remote:cmd", cmd);
    });
    st.remote.start(port, &key, &pin, hook).map_err(|e| {
        let msg = sse::port_error(&e, port, &st.t("Порт {port} вже зайнятий іншою програмою."));
        st.remote.set_last_error(&msg);
        msg
    })
}

/// The phone remote comes back on by itself if it was on last time: a
/// home-screen remote that stops working after every restart is no remote.
fn autostart_remote(app: &AppHandle) {
    let st = state(app);
    let cfg = st.remote_cfg.lock().clone();
    if cfg.enabled {
        let _ = start_remote(app, &st, cfg.port);
    }
}

fn test_channel(app: &AppHandle, st: &AppState, ch: &str, arg: &Value) -> R {
    if !st.test_mode {
        return Err("Unknown channel".into());
    }
    match ch {
        "test:log" => {
            if let Some(p) = std::env::var_os("BP_TEST_OUT") {
                if let Ok(mut f) = std::fs::OpenOptions::new().create(true).append(true).open(p) {
                    let _ = writeln!(f, "{}", arg.as_str().map(String::from).unwrap_or_else(|| arg.to_string()));
                }
            }
            Ok(Value::Null)
        }
        "test:exit" => {
            app.exit(0);
            Ok(Value::Null)
        }
        "test:shown" => Ok(json!(st.test_log.lock().clone())),
        "test:answer" => {
            let list: Vec<std::path::PathBuf> = arg
                .as_array()
                .map(|a| a.iter().filter_map(|x| x.as_str().map(std::path::PathBuf::from)).collect())
                .unwrap_or_default();
            dialogs::TEST_ANSWERS.lock().push_back(list);
            Ok(Value::Null)
        }
        "test:outputState" => {
            let w = state::output(app);
            Ok(json!({
                "exists": w.is_some(),
                "visible": w.as_ref().and_then(|w| w.is_visible().ok()),
                "fullscreen": w.as_ref().and_then(|w| w.is_fullscreen().ok()),
                "decorated": w.as_ref().and_then(|w| w.is_decorated().ok()),
            }))
        }
        // HTTP from outside the page (the page's own rules forbid it).
        "test:http" => {
            let client = reqwest::blocking::Client::builder().timeout(std::time::Duration::from_secs(10)).build().map_err(|e| e.to_string())?;
            let method = store::str_of(arg, "method");
            let url = store::str_of(arg, "url");
            let mut req = if method == "POST" { client.post(url) } else { client.get(url) };
            if let Some(h) = arg.get("headers").and_then(|h| h.as_object()) {
                for (k, v) in h {
                    req = req.header(k.as_str(), v.as_str().unwrap_or(""));
                }
            }
            if let Some(b) = arg.get("body") {
                req = req.header("Content-Type", "application/json").body(if b.is_string() { b.as_str().unwrap().to_string() } else { b.to_string() });
            }
            match req.send() {
                Ok(r) => {
                    let status = r.status().as_u16();
                    let headers: serde_json::Map<String, Value> = r.headers().iter().map(|(k, v)| (k.to_string(), json!(v.to_str().unwrap_or("")))).collect();
                    let bytes = r.bytes().map(|b| b.to_vec()).unwrap_or_default();
                    Ok(json!({ "status": status, "headers": headers, "len": bytes.len(), "head": bytes.iter().take(4).collect::<Vec<_>>(), "text": String::from_utf8_lossy(&bytes) }))
                }
                Err(e) => Ok(json!({ "status": 0, "error": e.to_string() })),
            }
        }
        _ => Err("Unknown channel".into()),
    }
}
