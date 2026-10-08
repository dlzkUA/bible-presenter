//! Automatic updates from GitHub Releases. A new version downloads quietly in
//! the background and installs when the app is closed, unless the operator
//! chooses to restart straight away. Never mid-service without asking.

use crate::state::AppState;
use parking_lot::Mutex;
use serde_json::{json, Value};
use std::sync::Arc;
use tauri::{AppHandle, Manager};
use tauri_plugin_updater::{Update, UpdaterExt};

#[derive(Default)]
pub struct Updates {
    pending: Mutex<Option<(Update, Vec<u8>)>>,
    downloading: Mutex<bool>,
}

/// The update feed is filled in by the release build on GitHub; a build made
/// elsewhere has no feed and says so instead of guessing.
pub fn feed_configured(app: &AppHandle) -> bool {
    let cfg = app.config();
    let Some(up) = cfg.plugins.0.get("updater") else { return false };
    up.get("endpoints")
        .and_then(|e| e.as_array())
        .map(|a| a.iter().any(|u| u.as_str().map(|s| !s.contains("OWNER/REPO")).unwrap_or(false)))
        .unwrap_or(false)
}

pub fn start_background_check(app: &AppHandle) {
    if cfg!(debug_assertions) || !feed_configured(app) {
        return;
    }
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        // Give the windows a moment before going to the network.
        tokio::time::sleep(std::time::Duration::from_secs(4)).await;
        let _ = download_if_newer(&app).await;
    });
}

async fn download_if_newer(app: &AppHandle) -> Result<Option<String>, String> {
    let st = app.state::<Arc<AppState>>();
    if let Some((u, _)) = st.update.pending.lock().as_ref() {
        return Ok(Some(u.version.clone()));
    }
    {
        let mut d = st.update.downloading.lock();
        if *d {
            return Ok(None);
        }
        *d = true;
    }
    let result = async {
        let updater = app.updater().map_err(|e| e.to_string())?;
        let Some(update) = updater.check().await.map_err(|e| e.to_string())? else { return Ok(None) };
        let bytes = update.download(|_, _| {}, || {}).await.map_err(|e| e.to_string())?;
        let version = update.version.clone();
        *st.update.pending.lock() = Some((update, bytes));
        offer_restart(app, &version);
        Ok(Some(version))
    }
    .await;
    *st.update.downloading.lock() = false;
    result
}

fn offer_restart(app: &AppHandle, version: &str) {
    let app = app.clone();
    let version = version.to_string();
    std::thread::spawn(move || {
        let st = app.state::<Arc<AppState>>();
        let now = crate::dialogs::ask(
            &app,
            &st.t("Оновлення готове"),
            &st.t("Bible Presenter {version} завантажено.").replace("{version}", &version),
            &st.t("Оновлення встановиться автоматично, коли ви закриєте програму. Можна також перезапустити зараз."),
            &st.t("Перезапустити зараз"),
            &st.t("Пізніше"),
        );
        if now {
            install_pending(&app);
            app.restart();
        }
    });
}

/// Installs a downloaded update; on Windows this hands over to the installer.
pub fn install_pending(app: &AppHandle) -> bool {
    let st = app.state::<Arc<AppState>>();
    let pending = st.update.pending.lock().take();
    match pending {
        Some((u, bytes)) => u.install(bytes).is_ok(),
        None => false,
    }
}

/// The "Check for updates" button.
pub fn check_now(app: &AppHandle, version: &str) -> Value {
    if !feed_configured(app) {
        return json!({ "status": "unavailable", "version": version });
    }
    let st = app.state::<Arc<AppState>>();
    // A check already running in the background: wait for it.
    for _ in 0..600 {
        if !*st.update.downloading.lock() {
            break;
        }
        std::thread::sleep(std::time::Duration::from_millis(500));
    }
    match tauri::async_runtime::block_on(download_if_newer(app)) {
        Ok(Some(v)) if v != version => json!({ "status": "available", "version": v }),
        Ok(_) => json!({ "status": "current", "version": version }),
        Err(e) => json!({ "status": "error", "message": e }),
    }
}
