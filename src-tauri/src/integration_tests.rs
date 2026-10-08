//! Backend integration tests: real files in a temporary data folder and the
//! real network servers on free ports, driven over HTTP the way a phone, vMix
//! or OBS would. They cover what breaks a service if it breaks: importing a
//! Bible and finding a verse, ProPresenter imports, and the phone remote and
//! live output servers, including their access rules.
//!
//! Run with `cargo test` in src-tauri (part of `npm run check`).

use crate::remote::{self, Remote};
use crate::state::AppState;
use crate::store::{read_json_safe, str_of, Paths};
use crate::webcast::Webcast;
use crate::{bible, propres};
use parking_lot::Mutex;
use serde_json::{json, Value};
use std::io::BufRead;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::{Duration, Instant};

fn fixture(name: &str) -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("../tests/fixtures").join(name)
}

/// A fresh, empty data folder, removed when the test ends.
struct TempData(PathBuf);
impl TempData {
    fn new() -> TempData {
        let p = std::env::temp_dir().join(format!("bp-it-{}", crate::store::random_hex(6)));
        std::fs::create_dir_all(&p).unwrap();
        TempData(p)
    }
    fn paths(&self) -> Paths {
        Paths::at(self.0.clone())
    }
}
impl Drop for TempData {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

fn http() -> reqwest::blocking::Client {
    reqwest::blocking::Client::builder().timeout(Duration::from_secs(10)).build().unwrap()
}

/// Reads an event stream until an event with this name arrives.
fn next_event(lines: &mut impl BufRead, name: &str) -> Value {
    let (mut ev, mut data) = (String::new(), String::new());
    loop {
        let mut line = String::new();
        assert!(lines.read_line(&mut line).unwrap() > 0, "stream ended before \"{name}\"");
        let line = line.trim_end();
        if line.is_empty() {
            if ev == name {
                return serde_json::from_str(&data).unwrap();
            }
            ev.clear();
            data.clear();
        } else if let Some(x) = line.strip_prefix("event: ") {
            ev = x.into();
        } else if let Some(x) = line.strip_prefix("data: ") {
            data = x.into();
        }
    }
}

// ---------------------------------------------------------------- Bible

#[test]
fn bible_import_then_search() {
    let d = TempData::new();
    let st = AppState::new(d.paths(), "test".into(), remote::load_config(&d.paths()), false);
    let bibles = st.paths.bibles.clone();

    // Zefania, from a file with a non-Latin name: the id must be stable, so a
    // second import replaces the first instead of adding a copy.
    let named = d.0.join("Синодальный.xml");
    std::fs::copy(fixture("bible-zefania.xml"), &named).unwrap();
    let canon = bible::canonical_books("en");
    let a = bible::import_bible_xml(&named, &canon, &bibles, None).unwrap();
    let b = bible::import_bible_xml(&named, &canon, &bibles, None).unwrap();
    assert_eq!(a["id"], b["id"]);
    assert!(str_of(&a, "id").starts_with("user-bible-"), "{a}");
    assert_eq!(a["books"], 2, "the non-canonical book is skipped");

    // OSIS, with markup inside the verse.
    let o = bible::import_bible_xml(&fixture("bible-osis.xml"), &canon, &bibles, None).unwrap();
    assert_eq!(o["id"], "user-bible-osis");
    let data = read_json_safe(&bibles.join("user-bible-osis.json")).unwrap();
    assert_eq!(data["books"]["Ps"]["chapters"][22][0], "The LORD is my shepherd; I shall not want.");

    // Not a Bible: a readable error code, nothing written.
    let err = bible::import_bible_xml(&fixture("not-a-bible.xml"), &canon, &bibles, None).unwrap_err();
    assert!(err.contains("XML_UNRECOGNISED"), "{err}");

    let list = bible::list_translations(&st.paths);
    assert_eq!(list.len(), 2, "{list:?}");

    // Phrase search across the imported text, case-insensitive.
    let hits = bible::search(&st, &json!({ "translationId": a["id"], "query": "SO LOVED the world" })).unwrap();
    let hits = hits.as_array().unwrap();
    assert_eq!(hits.len(), 1, "{hits:?}");
    assert_eq!(hits[0]["osis"], "John");
    assert_eq!((hits[0]["chapter"].as_u64(), hits[0]["verse"].as_u64()), (Some(3), Some(16)));
}

// ---------------------------------------------------------------- ProPresenter

#[test]
fn propresenter_song_keeps_arrangement() {
    let s = propres::import_pro_file(&fixture("arranged.pro")).unwrap();
    let names: Vec<&str> = s["sections"].as_array().unwrap().iter().map(|x| x["name"].as_str().unwrap()).collect();
    assert_eq!(names, vec!["Verse 1", "Chorus", "Verse 2", "Chorus"]);
}

#[test]
fn propresenter_theme_becomes_a_theme() {
    use prost::Message as _;
    use std::io::Write as _;
    let desc = propres::POOL.get_message_by_name("rv.data.Template.Document").unwrap();
    let doc = json!({ "slides": [{ "name": "Lower Third", "baseSlide": {
        "backgroundColor": { "red": 0.1, "green": 0.2, "blue": 0.3, "alpha": 1.0 },
        "elements": [{ "element": { "text": {
            "attributes": {
                "font": { "name": "NoirPro-Bold", "family": "Noir Pro", "size": 64.0, "face": "Bold" },
                "textSolidFill": { "red": 1.0, "green": 0.9, "blue": 0.0, "alpha": 1.0 },
                "capitalization": "CAPITALIZATION_ALL_CAPS",
                "paragraphStyle": { "alignment": "ALIGNMENT_LEFT", "lineHeightMultiple": 1.5 }
            },
            "verticalAlignment": "VERTICAL_ALIGNMENT_BOTTOM"
        } } }]
    } }] });
    let bytes = prost_reflect::DynamicMessage::deserialize(desc, doc).unwrap().encode_to_vec();
    let d = TempData::new();
    let path = d.0.join("Lower Third.proTheme");
    let mut z = zip::ZipWriter::new(std::fs::File::create(&path).unwrap());
    z.start_file("Lower Third/Theme", zip::write::SimpleFileOptions::default()).unwrap();
    z.write_all(&bytes).unwrap();
    z.finish().unwrap();

    let t = propres::import_pro_theme(&path).unwrap();
    assert_eq!(t["name"], "Lower Third");
    assert_eq!(t["fontFamily"], "Noir Pro");
    assert_eq!(t["fontSize"], 64.0);
    assert_eq!(t["bold"], true);
    assert_eq!(t["color"], "#ffe600");
    assert_eq!(t["background"], "#1a334d");
    assert_eq!(t["uppercase"], true);
    assert_eq!((t["align"].as_str(), t["valign"].as_str()), (Some("left"), Some("flex-end")));
}

// ---------------------------------------------------------------- phone remote

#[test]
fn phone_remote_pairing_commands_and_state() {
    let d = TempData::new();
    // Key and PIN are created once and survive a restart (a paired phone keeps working).
    let cfg = remote::load_config(&d.paths());
    assert_eq!(remote::load_config(&d.paths()).key, cfg.key);
    assert!(cfg.pin.len() == 6 && cfg.key.len() >= 24);

    let got: Arc<Mutex<Vec<Value>>> = Arc::default();
    let sink = got.clone();
    let r = Remote::default();
    let port = r.start(0, &cfg.key, &cfg.pin, Arc::new(move |c| sink.lock().push(c))).unwrap();
    let base = format!("http://127.0.0.1:{port}");
    let c = http();
    let get = |p: &str| c.get(format!("{base}{p}")).send().unwrap();
    let post = |p: &str, body: Value, key: Option<&str>| {
        let mut q = c.post(format!("{base}{p}")).body(body.to_string());
        if let Some(k) = key {
            q = q.header("X-Key", k);
        }
        q.send().unwrap()
    };

    // The page itself is public, with a strict content policy.
    let page = get("/");
    assert_eq!(page.status(), 200);
    assert!(page.headers()["content-security-policy"].to_str().unwrap().contains("frame-ancestors 'none'"));
    assert_eq!(get("/../../etc/passwd").status(), 404);

    // Everything else needs the key.
    assert_eq!(get("/events").status(), 401);
    assert_eq!(get("/thumb/0").status(), 401);
    assert_eq!(post("/api/cmd", json!({ "cmd": "next" }), None).status(), 401);
    assert_eq!(post("/api/cmd", json!({ "cmd": "next" }), Some("wrong-key-wrong-key-wrong-key")).status(), 401);

    // The right PIN gives the key.
    let res = post("/api/pair", json!({ "pin": cfg.pin }), None);
    assert_eq!(res.status(), 200);
    let key = res.json::<Value>().unwrap()["key"].as_str().unwrap().to_string();
    assert_eq!(key, cfg.key);
    assert_eq!(get(&format!("/api/hello?k={key}")).status(), 200);

    // Commands are checked before they reach the app.
    assert_eq!(post("/api/cmd", json!({ "cmd": "next" }), Some(&key)).status(), 200);
    assert_eq!(post("/api/cmd", json!({ "cmd": "slide", "idx": 2, "sig": "s1" }), Some(&key)).status(), 200);
    for bad in [json!({ "cmd": "rm -rf" }), json!({ "cmd": "slide", "idx": -1 }), json!({ "cmd": "pres", "id": "../x" }), json!({ "cmd": "playlist", "id": "" })] {
        assert_eq!(post("/api/cmd", bad.clone(), Some(&key)).status(), 400, "{bad}");
    }
    assert_eq!(*got.lock(), vec![json!({ "cmd": "next" }), json!({ "cmd": "slide", "idx": 2, "sig": "s1" })]);

    // Live state: everything on connect, then only what changed.
    r.set_state(json!({ "screen": true, "live": { "text": "Amazing grace" } }), None);
    let stream = c.get(format!("{base}/events?k={key}")).send().unwrap();
    assert_eq!(stream.status(), 200);
    let mut lines = std::io::BufReader::new(stream);
    let first = next_event(&mut lines, "state");
    assert_eq!(first["live"]["text"], "Amazing grace");
    r.set_state(json!({ "screen": false }), None);
    assert_eq!(next_event(&mut lines, "state"), json!({ "screen": false }));

    // Slide pictures: only the files listed for the current slides, by position.
    r.set_state(json!({}), Some(vec![Some(fixture("slide.png")), None]));
    let th = get(&format!("/thumb/0?k={key}"));
    assert_eq!(th.status(), 200);
    assert_eq!(th.headers()["content-type"], "image/jpeg");
    assert_eq!(get(&format!("/thumb/1?k={key}")).status(), 404);
    assert_eq!(get(&format!("/thumb/9?k={key}")).status(), 404);

    // Presentation covers come from the library folders, by safe id only.
    let p = d.paths();
    std::fs::copy(fixture("slide.png"), p.media.join("s1.png")).unwrap();
    std::fs::write(p.presentations.join("deck-1.json"), json!({ "slides": [{ "image": "s1.png" }] }).to_string()).unwrap();
    r.set_library_dirs(p.media.clone(), p.presentations.clone());
    assert_eq!(get(&format!("/cover/deck-1?k={key}")).status(), 200);
    assert_eq!(get(&format!("/cover/..%2Fdeck-1?k={key}")).status(), 404);
    assert_eq!(get("/cover/deck-1").status(), 401);

    // "Reset access": the old key stops working.
    r.set_credentials(&remote::new_key(), &remote::new_pin());
    assert_eq!(post("/api/cmd", json!({ "cmd": "next" }), Some(&key)).status(), 401);
    r.stop();
}

#[test]
fn phone_remote_wrong_pins_are_slowed_down() {
    let r = Remote::default();
    let port = r.start(0, &remote::new_key(), "123456", Arc::new(|_| {})).unwrap();
    let c = http();
    let pair = |pin: &str| c.post(format!("http://127.0.0.1:{port}/api/pair")).body(json!({ "pin": pin }).to_string()).send().unwrap().status();
    for _ in 0..4 {
        assert_eq!(pair("000000"), 401);
    }
    assert_eq!(pair("000000"), 429, "fifth wrong PIN: a pause");
    assert_eq!(pair("123456"), 429, "even the right PIN waits out the pause");
    r.stop();
}

// ---------------------------------------------------------------- live output (vMix / OBS, stage)

#[test]
fn live_output_streams_slides_and_media() {
    let w = Webcast::default();
    let png = fixture("slide.png");
    let resolver: crate::webcast::MediaResolver = Arc::new(move |id: &str| (id == "abc").then(|| png.clone()));
    let port = w.start(0, resolver).unwrap()["port"].as_u64().unwrap();
    let base = format!("http://127.0.0.1:{port}");
    let c = http();

    assert_eq!(c.get(format!("{base}/")).send().unwrap().status(), 200);
    assert_eq!(c.get(format!("{base}/stage")).send().unwrap().status(), 200);

    // A slide reaches a connected page, and a page that connects later gets it too.
    let mut feed = std::io::BufReader::new(c.get(format!("{base}/events")).send().unwrap());
    next_event(&mut feed, "style");
    w.broadcast("slide", &json!({ "text": "For God so loved the world" }));
    assert_eq!(next_event(&mut feed, "slide")["text"], "For God so loved the world");
    let mut late = std::io::BufReader::new(c.get(format!("{base}/events")).send().unwrap());
    assert_eq!(next_event(&mut late, "slide")["text"], "For God so loved the world");

    // The stage display follows the projector, with the next line.
    let mut stage = std::io::BufReader::new(c.get(format!("{base}/events?role=stage")).send().unwrap());
    next_event(&mut stage, "stage");
    w.broadcast_stage(Some(&json!({ "text": "Line one", "nextText": "Line two" })));
    let s = next_event(&mut stage, "stageSlide");
    assert_eq!((s["text"].as_str(), s["nextText"].as_str()), (Some("Line one"), Some("Line two")));

    // Media by opaque id only, with byte ranges (video players need them).
    let full = c.get(format!("{base}/media/abc")).send().unwrap();
    assert_eq!(full.status(), 200);
    assert_eq!(full.headers()["content-type"], "image/png");
    let part = c.get(format!("{base}/media/abc")).header("Range", "bytes=0-7").send().unwrap();
    assert_eq!(part.status(), 206);
    assert_eq!(part.bytes().unwrap().as_ref(), b"\x89PNG\r\n\x1a\n");
    assert_eq!(c.get(format!("{base}/media/nope")).send().unwrap().status(), 404);
    assert_eq!(c.get(format!("{base}/media/..%2F..%2Fetc%2Fpasswd")).send().unwrap().status(), 404);

    // Stopping frees the port.
    w.stop();
    let t = Instant::now();
    while c.get(format!("{base}/")).send().is_ok() {
        assert!(t.elapsed() < Duration::from_secs(5), "server still answering after stop");
        std::thread::sleep(Duration::from_millis(100));
    }
}
