//! Native open/save dialogs, always attached to the control window.

use once_cell::sync::Lazy;
use parking_lot::Mutex;
use std::collections::VecDeque;
use std::path::PathBuf;

/// Answers queued by the automated tests in place of a dialog (an empty list
/// stands for "cancelled"). Only filled in test mode.
pub static TEST_ANSWERS: Lazy<Mutex<VecDeque<Vec<PathBuf>>>> = Lazy::new(|| Mutex::new(VecDeque::new()));
fn test_answer() -> Option<Vec<PathBuf>> {
    TEST_ANSWERS.lock().pop_front()
}
use tauri::{AppHandle, Manager};
use tauri_plugin_dialog::{DialogExt, FileDialogBuilder};

fn builder(app: &AppHandle, title: &str, filters: &[(&str, &[&str])]) -> FileDialogBuilder<tauri::Wry> {
    let mut b = app.dialog().file().set_title(title);
    for (name, exts) in filters {
        b = b.add_filter(*name, exts);
    }
    if let Some(w) = app.get_webview_window("control") {
        b = b.set_parent(&w);
    }
    b
}

pub fn pick_file(app: &AppHandle, title: &str, filters: &[(&str, &[&str])]) -> Option<PathBuf> {
    if let Some(a) = test_answer() {
        return a.into_iter().next();
    }
    builder(app, title, filters).blocking_pick_file().and_then(|p| p.into_path().ok())
}

pub fn pick_files(app: &AppHandle, title: &str, filters: &[(&str, &[&str])]) -> Vec<PathBuf> {
    if let Some(a) = test_answer() {
        return a;
    }
    builder(app, title, filters)
        .blocking_pick_files()
        .map(|v| v.into_iter().filter_map(|p| p.into_path().ok()).collect())
        .unwrap_or_default()
}

pub fn pick_folder(app: &AppHandle, title: &str) -> Option<PathBuf> {
    if let Some(a) = test_answer() {
        return a.into_iter().next();
    }
    builder(app, title, &[]).blocking_pick_folder().and_then(|p| p.into_path().ok())
}

pub fn save_file(app: &AppHandle, title: &str, default_name: &str, filters: &[(&str, &[&str])]) -> Option<PathBuf> {
    if let Some(a) = test_answer() {
        return a.into_iter().next();
    }
    builder(app, title, filters)
        .set_file_name(default_name)
        .blocking_save_file()
        .and_then(|p| p.into_path().ok())
}

/// A question with two answers; true when the first one is chosen.
pub fn ask(app: &AppHandle, title: &str, message: &str, detail: &str, yes: &str, no: &str) -> bool {
    if let Some(a) = test_answer() {
        return !a.is_empty();
    }
    use tauri_plugin_dialog::{MessageDialogButtons, MessageDialogKind};
    let text = if detail.is_empty() { message.to_string() } else { format!("{message}\n\n{detail}") };
    let mut b = app
        .dialog()
        .message(text)
        .title(title)
        .kind(MessageDialogKind::Info)
        .buttons(MessageDialogButtons::OkCancelCustom(yes.to_string(), no.to_string()));
    if let Some(w) = app.get_webview_window("control") {
        b = b.parent(&w);
    }
    b.blocking_show()
}
