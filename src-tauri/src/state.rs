//! Everything the app keeps in memory while it runs.

use crate::store::Paths;
use parking_lot::Mutex;
use serde_json::Value;
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Arc;
use std::time::Instant;
use tauri::{AppHandle, Manager, WebviewWindow};

#[derive(Default)]
pub struct Ui {
    pub lang: String,
    pub strings: HashMap<String, String>,
}

/// What the projector and the stream are showing.
#[derive(Default)]
pub struct Output {
    /// Last theme set; sent again whenever the projector page (re)loads.
    pub theme: Option<Value>,
    /// What the projector shows right now, kept even while live output is off.
    pub projector: Option<Value>,
    /// The same slide as sent to the stream (file links rewritten).
    pub mirrored: Option<Value>,
    /// Live output held clear by the operator.
    pub stream_blackout: bool,
    /// Ordering guard for slides arriving from the control window.
    pub last_seq: u64,
}

pub struct Upload {
    pub path: PathBuf,
    pub name: String,
    pub written: u64,
}

/// A presentation being imported: the PDF to draw, and the slides drawn so far.
pub struct PresJob {
    pub pdf: PathBuf,
    pub cleanup: Vec<PathBuf>,
    pub title: String,
    pub rendered_with: &'static str,
    pub written: Vec<String>,
}

pub struct AppState {
    pub paths: Paths,
    pub version: String,
    pub build_date: String,
    pub ui: Mutex<Ui>,
    pub bible_cache: Mutex<HashMap<String, Arc<crate::bible::Translation>>>,
    pub name_lang_cache: Mutex<HashMap<String, Option<String>>>,
    pub fonts: Mutex<Option<Vec<String>>>,
    pub output: Mutex<Output>,
    /// Files the live-output server may hand out, by opaque id.
    pub stream_media: Arc<Mutex<HashMap<String, PathBuf>>>,
    pub uploads: Mutex<HashMap<String, Upload>>,
    pub jobs: Mutex<HashMap<String, PresJob>>,
    pub closing_since: Mutex<Option<Instant>>,
    pub webcast: crate::webcast::Webcast,
    pub remote: crate::remote::Remote,
    pub remote_cfg: Mutex<crate::remote::Config>,
    /// Slides and clears recorded for the automated tests.
    pub test_log: Mutex<Vec<String>>,
    pub update: crate::update::Updates,
    pub test_mode: bool,
}

impl AppState {
    pub fn new(paths: Paths, version: String, remote_cfg: crate::remote::Config, test_mode: bool) -> AppState {
        AppState {
            paths,
            version,
            build_date: env!("BP_BUILD_DATE").to_string(),
            ui: Mutex::new(Ui { lang: "en".into(), strings: HashMap::new() }),
            bible_cache: Mutex::new(HashMap::new()),
            name_lang_cache: Mutex::new(HashMap::new()),
            fonts: Mutex::new(None),
            output: Mutex::new(Output::default()),
            stream_media: Arc::new(Mutex::new(HashMap::new())),
            uploads: Mutex::new(HashMap::new()),
            jobs: Mutex::new(HashMap::new()),
            closing_since: Mutex::new(None),
            webcast: crate::webcast::Webcast::default(),
            remote: crate::remote::Remote::default(),
            remote_cfg: Mutex::new(remote_cfg),
            test_log: Mutex::new(Vec::new()),
            update: crate::update::Updates::default(),
            test_mode,
        }
    }

    pub fn stream_media_handle(&self) -> Arc<Mutex<HashMap<String, PathBuf>>> {
        self.stream_media.clone()
    }

    /// The interface string in the current language (the control window sends
    /// the dictionary for the handful of texts the core shows itself).
    pub fn t(&self, key: &str) -> String {
        self.ui.lock().strings.get(key).cloned().unwrap_or_else(|| key.to_string())
    }
}

pub fn control(app: &AppHandle) -> Option<WebviewWindow> {
    app.get_webview_window("control")
}

pub fn output(app: &AppHandle) -> Option<WebviewWindow> {
    app.get_webview_window("output")
}
