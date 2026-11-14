//! A copy of the control page's settings (interface language, the live-output
//! look and fonts, stage display, last playlist…) in `settings.json` in the
//! data folder.
//!
//! The page keeps them in localStorage, which WebView2 writes to disk lazily:
//! closing the app soon after a change could lose it, and the stream fonts
//! came back reset after a restart. So every change is also sent here and
//! saved, and the saved copy is put back into the page before it starts.

use parking_lot::Mutex;
use serde_json::{Map, Value};
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::Duration;

const MAX_KEYS: usize = 400;
const MAX_KEY: usize = 200;
const MAX_VALUE: usize = 512 * 1024;

pub struct Prefs {
    file: PathBuf,
    map: Mutex<Map<String, Value>>,
    dirty: AtomicBool,
    pending: AtomicBool,
    /// Held from taking the copy to finishing the write: two writers (the
    /// delayed one and the one at exit) could otherwise finish in the wrong
    /// order and leave the older copy in the file.
    writing: Mutex<()>,
}

impl Prefs {
    pub fn load(root: &std::path::Path) -> Arc<Prefs> {
        let file = root.join("settings.json");
        let map = std::fs::read(&file)
            .ok()
            .and_then(|b| serde_json::from_slice::<Value>(&b).ok())
            .and_then(|v| v.as_object().cloned())
            .unwrap_or_default();
        Arc::new(Prefs { file, map: Mutex::new(map), dirty: AtomicBool::new(false), pending: AtomicBool::new(false), writing: Mutex::new(()) })
    }

    /// The script that puts the saved settings back before the page's own
    /// scripts read them. The file holds everything the page had (see
    /// `set_all`), so a key missing from it was removed and stays removed.
    pub fn init_script(&self) -> Option<String> {
        let map = self.map.lock();
        if map.is_empty() {
            return None;
        }
        let data = serde_json::to_string(&*map).ok()?;
        Some(format!(
            "(function(){{try{{var d={data},s=localStorage,k,i;for(i=s.length-1;i>=0;i--){{k=s.key(i);if(!(k in d))s.removeItem(k);}}for(k in d){{if(typeof d[k]==='string')s.setItem(k,d[k]);}}}}catch(e){{}}}})();"
        ))
    }

    /// One change: `{ key, value }`, value null when the key was removed.
    pub fn set(self: &Arc<Self>, arg: &Value) {
        let Some(key) = arg.get("key").and_then(|k| k.as_str()) else { return };
        if key.is_empty() || key.len() > MAX_KEY {
            return;
        }
        {
            let mut map = self.map.lock();
            match arg.get("value").and_then(|v| v.as_str()) {
                Some(v) if v.len() <= MAX_VALUE => {
                    if !map.contains_key(key) && map.len() >= MAX_KEYS {
                        return;
                    }
                    map.insert(key.to_string(), Value::String(v.to_string()));
                }
                Some(_) => return,
                None => {
                    map.remove(key);
                }
            }
        }
        self.changed();
    }

    /// Everything the page has, sent once when it starts (this also fills the
    /// file the first time, from settings an older version kept only in the page).
    pub fn set_all(self: &Arc<Self>, arg: &Value) {
        let Some(obj) = arg.as_object() else { return };
        let mut fresh = Map::new();
        for (k, v) in obj.iter() {
            if let Some(s) = v.as_str() {
                if !k.is_empty() && k.len() <= MAX_KEY && s.len() <= MAX_VALUE && fresh.len() < MAX_KEYS {
                    fresh.insert(k.clone(), Value::String(s.to_string()));
                }
            }
        }
        *self.map.lock() = fresh;
        self.changed();
    }

    // Slider drags send many changes a second; they are written together a
    // moment later, and whatever is left is written when the app exits.
    fn changed(self: &Arc<Self>) {
        self.dirty.store(true, Ordering::SeqCst);
        if self.pending.swap(true, Ordering::SeqCst) {
            return;
        }
        let me = self.clone();
        std::thread::spawn(move || {
            std::thread::sleep(Duration::from_millis(400));
            me.pending.store(false, Ordering::SeqCst);
            me.flush();
        });
    }

    pub fn flush(&self) {
        let _one_writer = self.writing.lock();
        if !self.dirty.swap(false, Ordering::SeqCst) {
            return;
        }
        let snapshot = Value::Object(self.map.lock().clone());
        if crate::store::write_json_atomic(&self.file, &snapshot, false).is_err() {
            self.dirty.store(true, Ordering::SeqCst);
        }
    }
}
