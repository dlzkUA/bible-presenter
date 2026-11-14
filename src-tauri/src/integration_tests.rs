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
use crate::{bible, propres, sse};
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

    // A file claiming verse 900,000,000 is read without building a list that
    // long (which would run the computer out of memory).
    let huge = d.0.join("huge.xml");
    std::fs::write(&huge, r#"<XMLBIBLE><BIBLEBOOK bnumber="1"><CHAPTER cnumber="1"><VERS vnumber="1">In the beginning</VERS><VERS vnumber="900000000">x</VERS></CHAPTER><CHAPTER cnumber="900000000"><VERS vnumber="1">y</VERS></CHAPTER></BIBLEBOOK></XMLBIBLE>"#).unwrap();
    let h = bible::import_bible_xml(&huge, &canon, &bibles, None).unwrap();
    let hd = read_json_safe(&bibles.join(format!("{}.json", str_of(&h, "id")))).unwrap();
    assert_eq!(hd["books"]["Gen"]["chapters"].as_array().unwrap().len(), 1);
    std::fs::remove_file(bibles.join(format!("{}.json", str_of(&h, "id")))).unwrap();

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
        let mut q = c.post(format!("{base}{p}")).header("Content-Type", "application/json").body(body.to_string());
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
    // A page on another web site can't pair: its plain-text POST is refused
    // before the PIN is even looked at (and costs no tries).
    let cross_site = c.post(format!("{base}/api/pair")).header("Content-Type", "text/plain").body(json!({ "pin": cfg.pin }).to_string()).send().unwrap();
    assert_eq!(cross_site.status(), 403);
    // The phone page sends no referrer, so its browser says "Origin: null".
    let res = c
        .post(format!("{base}/api/pair"))
        .header("Content-Type", "application/json")
        .header("Origin", "null")
        .body(json!({ "pin": cfg.pin }).to_string())
        .send()
        .unwrap();
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
    let pair = |pin: &str| {
        c.post(format!("http://127.0.0.1:{port}/api/pair"))
            .header("Content-Type", "application/json")
            .body(json!({ "pin": pin }).to_string())
            .send()
            .unwrap()
            .status()
    };
    for _ in 0..4 {
        assert_eq!(pair("000000"), 401);
    }
    assert_eq!(pair("000000"), 429, "fifth wrong PIN: a pause");
    assert_eq!(pair("123456"), 429, "even the right PIN waits out the pause");
    r.stop();
}

// ---------------------------------------------------------------- live output (vMix / OBS, stage)

#[test]
fn live_output_gets_no_local_paths() {
    let d = TempData::new();
    let st = AppState::new(d.paths(), "test".into(), remote::load_config(&d.paths()), false);
    let inside = st.paths.media.join("bg.png");
    std::fs::copy(fixture("slide.png"), &inside).unwrap();
    let out = crate::windows::mirror(&st, &json!({
        "text": "Amazing grace",
        "image": inside.to_string_lossy(),
        "theme": { "bgPath": "C:\\Users\\Pastor\\AppData\\Roaming\\BiblePresenter\\backgrounds\\x.mp4", "bgFile": "x.mp4", "fontFamily": "Georgia" },
        "secretField": "/Users/pastor/notes.txt",
    }));
    let text = out.to_string();
    assert!(!text.contains("Pastor") && !text.contains("pastor") && !text.contains("secretField"), "{text}");
    assert_eq!(out["theme"]["fontFamily"], "Georgia");
    assert!(out["image"].as_str().unwrap().starts_with("/media/"));
    // A file outside the data folder is never offered to the network.
    let outside = crate::windows::mirror(&st, &json!({ "image": fixture("slide.png").to_string_lossy() }));
    assert_eq!(outside["image"], "/media/-");
}

fn full_headers_lack_cors(c: &reqwest::blocking::Client, url: &str) -> bool {
    !c.get(url).send().unwrap().headers().contains_key("access-control-allow-origin")
}

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

    // One device can't take every place: its own oldest stream makes way,
    // and nobody gets turned away.
    let extra: Vec<_> = (0..sse::MAX_PER_IP + 2).map(|_| c.get(format!("{base}/events")).send().unwrap()).collect();
    assert!(extra.iter().all(|r| r.status() == 200));

    // Only this server's own pages may read it: no cross-site header, and a
    // request naming some other web site's domain (DNS rebinding) is refused.
    assert!(full_headers_lack_cors(&c, &format!("{base}/media/abc")));
    let foreign = c.get(format!("{base}/events")).header("Host", "evil.example.com").send().unwrap();
    assert_eq!(foreign.status(), 403);
    let by_name = c.get(format!("{base}/")).header("Host", "church-pc:7777").send().unwrap();
    assert_eq!(by_name.status(), 200, "a bare computer name still works");

    // Stopping frees the port.
    w.stop();
    let t = Instant::now();
    while c.get(format!("{base}/")).send().is_ok() {
        assert!(t.elapsed() < Duration::from_secs(5), "server still answering after stop");
        std::thread::sleep(Duration::from_millis(100));
    }
}

#[test]
fn live_output_restart_does_not_bring_back_an_old_slide() {
    let w = Webcast::default();
    let resolver: crate::webcast::MediaResolver = Arc::new(|_: &str| None);
    w.start(0, resolver.clone()).unwrap();
    w.broadcast("slide", &json!({ "text": "Old slide" }));
    w.broadcast_stage(Some(&json!({ "text": "Old slide" })));
    // Output off (the projector may be cleared meanwhile: nothing is broadcast
    // while it is off), then on again: a page that connects starts empty.
    w.stop();
    let port2 = w.start(0, resolver).unwrap()["port"].as_u64().unwrap();
    let c = http();
    let mut feed = std::io::BufReader::new(c.get(format!("http://127.0.0.1:{port2}/events")).send().unwrap());
    next_event(&mut feed, "style");
    w.broadcast("slide", &json!({ "text": "New slide" }));
    assert_eq!(next_event(&mut feed, "slide")["text"], "New slide");
    let mut stage = std::io::BufReader::new(c.get(format!("http://127.0.0.1:{port2}/events?role=stage")).send().unwrap());
    next_event(&mut stage, "stage");
    w.broadcast_stage(Some(&json!({ "text": "New slide" })));
    assert_eq!(next_event(&mut stage, "stageSlide")["text"], "New slide");
    w.stop();
}

/// Opens a WebSocket the way a browser does and returns the HTTP status of the
/// handshake, plus the open stream when it was accepted.
fn ws_open(port: u64, path: &str, origin: Option<&str>) -> (u16, Option<std::net::TcpStream>) {
    use std::io::{Read, Write};
    let mut s = std::net::TcpStream::connect(("127.0.0.1", port as u16)).unwrap();
    s.set_read_timeout(Some(Duration::from_secs(5))).unwrap();
    let origin = origin.map(|o| format!("Origin: {o}\r\n")).unwrap_or_default();
    write!(
        s,
        "GET {path} HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\
         Sec-WebSocket-Version: 13\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n{origin}\r\n"
    )
    .unwrap();
    let mut head = Vec::new();
    let mut b = [0u8; 1];
    while !head.ends_with(b"\r\n\r\n") {
        if s.read(&mut b).unwrap() == 0 {
            break;
        }
        head.push(b[0]);
    }
    let status = String::from_utf8_lossy(&head).split_whitespace().nth(1).and_then(|x| x.parse().ok()).unwrap_or(0);
    (status, (status == 101).then_some(s))
}

/// Reads frames until one carries this event; returns its data.
fn ws_event(s: &mut std::net::TcpStream, name: &str) -> Value {
    use std::io::Read;
    loop {
        let mut h = [0u8; 2];
        s.read_exact(&mut h).unwrap();
        let mut len = (h[1] & 0x7f) as usize;
        if len == 126 {
            let mut e = [0u8; 2];
            s.read_exact(&mut e).unwrap();
            len = u16::from_be_bytes(e) as usize;
        } else if len == 127 {
            let mut e = [0u8; 8];
            s.read_exact(&mut e).unwrap();
            len = u64::from_be_bytes(e) as usize;
        }
        let mut body = vec![0u8; len];
        s.read_exact(&mut body).unwrap();
        if h[0] & 0x0f != 1 {
            continue; // not a text frame
        }
        let v: Value = serde_json::from_slice(&body).unwrap();
        if v["e"] == name {
            return v["d"].clone();
        }
    }
}

#[test]
fn live_output_websocket_and_vmix_file() {
    let w = Webcast::default();
    assert!(w.launcher_page().is_none(), "no file while the output is off");
    let resolver: crate::webcast::MediaResolver = Arc::new(|_: &str| None);
    let port = w.start(0, resolver).unwrap()["port"].as_u64().unwrap();
    let c = http();
    assert_eq!(c.get(format!("http://127.0.0.1:{port}/link.js")).send().unwrap().status(), 200);

    // A page from this server connects and gets the look, then each slide.
    let own = format!("http://127.0.0.1:{port}");
    let (st, s) = ws_open(port, "/ws", Some(&own));
    assert_eq!(st, 101);
    let mut s = s.unwrap();
    ws_event(&mut s, "style");
    w.broadcast("slide", &json!({ "text": "Amazing grace" }));
    assert_eq!(ws_event(&mut s, "slide")["text"], "Amazing grace");

    // More sockets than a browser's six-connection limit, all served.
    let many: Vec<_> = (0..10).map(|_| ws_open(port, "/ws", Some(&own))).collect();
    assert!(many.iter().all(|(st, _)| *st == 101));

    // The stage display gets its own events.
    let (st, s2) = ws_open(port, "/ws?role=stage", Some(&own));
    assert_eq!(st, 101);
    w.broadcast_stage(Some(&json!({ "text": "Line one", "nextText": "Line two" })));
    assert_eq!(ws_event(&mut s2.unwrap(), "stageSlide")["nextText"], "Line two");

    // Browsers let any web site open a WebSocket, so other origins are refused.
    assert_eq!(ws_open(port, "/ws", Some("http://evil.example.com")).0, 403);
    assert_eq!(ws_open(port, "/ws", Some("null")).0, 403);
    assert_eq!(ws_open(port, "/ws", None).0, 101, "a program without an Origin header");

    // The file for vMix points at this server, on this computer first.
    let page = w.launcher_page().unwrap();
    assert!(page.contains(&format!("\"http://127.0.0.1:{port}/\"")));
    assert!(!page.contains("__TARGETS__"));
    w.stop();
}

#[test]
fn local_media_server_serves_only_the_media_folders() {
    let d = TempData::new();
    let paths = d.paths();
    std::fs::create_dir_all(&paths.media).unwrap();
    std::fs::create_dir_all(&paths.backgrounds).unwrap();
    std::fs::write(paths.media.join("photo one.jpg"), b"0123456789").unwrap();
    std::fs::write(d.0.join("secret.txt"), b"private").unwrap();
    let l = crate::localmedia::start(&paths).unwrap();
    let c = http();
    let url = format!("{}m/{}", l.base, "photo%20one.jpg");
    assert_eq!(crate::localmedia::path_for(&l.base, &paths, &url), Some(paths.media.join("photo one.jpg")));

    let r = c.get(&url).send().unwrap();
    assert_eq!(r.status(), 200);
    assert!(r.headers().get("access-control-allow-origin").is_none(), "no CORS without an app origin");
    assert_eq!(r.bytes().unwrap().as_ref(), b"0123456789");
    // Video seeking needs byte ranges.
    let r = c.get(&url).header("Range", "bytes=2-4").send().unwrap();
    assert_eq!(r.status(), 206);
    assert_eq!(r.bytes().unwrap().as_ref(), b"234");
    // The app's own pages may read pixels; a web site may not.
    let r = c.get(&url).header("Origin", "tauri://localhost").send().unwrap();
    assert_eq!(r.headers()["access-control-allow-origin"], "tauri://localhost");
    let r = c.get(&url).header("Origin", "http://evil.example.com").send().unwrap();
    assert!(r.headers().get("access-control-allow-origin").is_none());

    let port_base = l.base.split('/').take(3).collect::<Vec<_>>().join("/");
    for bad in [
        format!("{port_base}/{}/m/photo%20one.jpg", "0".repeat(32)), // wrong token
        format!("{}x/photo%20one.jpg", l.base),                     // unknown folder
        format!("{}m/..%2Fsecret.txt", l.base),                     // outside the folder
        format!("{}b/photo%20one.jpg", l.base),                     // other folder
    ] {
        assert_eq!(c.get(&bad).send().unwrap().status(), 404, "{bad}");
    }
    // Another host name pointing here (DNS rebinding) is refused.
    assert_eq!(c.get(&url).header("Host", "evil.example.com").send().unwrap().status(), 404);

    // Installed fonts, by the id the font scan gave them.
    crate::fonts::use_for_tests(&[fixture_fonts()]);
    let cat = crate::fonts::catalog();
    let id = &cat.faces("BP Test Sans")[0].id;
    let r = c.get(format!("{}f/{id}", l.base)).header("Origin", "tauri://localhost").send().unwrap();
    assert_eq!(r.status(), 200);
    assert_eq!(r.headers()["access-control-allow-origin"], "tauri://localhost", "fonts load in CORS mode");
    assert_eq!(c.get(format!("{}f/test-latin.ttf", l.base)).send().unwrap().status(), 404);
    assert_eq!(c.get(format!("{port_base}/{}/f/{id}", "0".repeat(32))).send().unwrap().status(), 404);
}

#[test]
fn big_pictures_are_scaled_down_for_the_stream() {
    let d = TempData::new();
    let big = d.0.join("big.png");
    image::RgbImage::from_pixel(4000, 3000, image::Rgb([10, 20, 30])).save(&big).unwrap();
    let (bytes, mime) = crate::webcast::stream_picture(&big).expect("scaled");
    assert_eq!(mime, "image/jpeg");
    let img = image::load_from_memory(&bytes).unwrap();
    assert!(img.width() <= 2560 && img.height() <= 1440, "{}x{}", img.width(), img.height());
    let small = d.0.join("small.png");
    image::RgbImage::from_pixel(800, 600, image::Rgb([1, 2, 3])).save(&small).unwrap();
    assert!(crate::webcast::stream_picture(&small).is_none(), "small pictures go out as they are");
}

/// A JPEG stored on its side with the note phones add: "turn me a quarter".
fn sideways_photo(path: &Path, w: u32, h: u32) {
    let mut img = image::RgbImage::from_pixel(w, h, image::Rgb([10, 20, 30]));
    for y in 0..h / 4 {
        for x in 0..w / 4 {
            img.put_pixel(x, y, image::Rgb([255, 0, 0])); // red at the stored top-left
        }
    }
    let mut plain = Vec::new();
    image::DynamicImage::ImageRgb8(img).write_to(&mut std::io::Cursor::new(&mut plain), image::ImageFormat::Jpeg).unwrap();
    // An "Exif" block with one entry: Orientation = 6.
    let mut app1 = b"Exif\0\0MM\0\x2a\0\0\0\x08\0\x01\x01\x12\0\x03\0\0\0\x01\0\x06\0\0\0\0\0\0".to_vec();
    let mut out = plain[..2].to_vec();
    out.extend([0xFF, 0xE1]);
    out.extend(((app1.len() + 2) as u16).to_be_bytes());
    out.append(&mut app1);
    out.extend(&plain[2..]);
    std::fs::write(path, out).unwrap();
}

#[test]
fn phone_photos_keep_their_way_up_on_the_stream() {
    let d = TempData::new();
    let photo = d.0.join("phone.jpg");
    sideways_photo(&photo, 4000, 3000);
    let (bytes, _) = crate::webcast::stream_picture(&photo).expect("scaled");
    let img = image::load_from_memory(&bytes).unwrap().to_rgb8();
    assert_eq!((img.width(), img.height()), (1080, 1440), "upright, inside 2560x1440");
    assert!(img.get_pixel(1060, 20).0[0] > 200 && img.get_pixel(20, 20).0[0] < 80, "the stored top-left corner is now top-right");
}

#[test]
fn settings_survive_a_restart() {
    let d = TempData::new();
    let p = crate::prefs::Prefs::load(&d.0);
    assert!(p.init_script().is_none(), "nothing saved yet");
    // An older version's settings arrive in one go, then single changes.
    p.set_all(&json!({ "uiLang": "uk", "webcastStyles": "{\"song\":{\"fontFamily\":\"Montserrat\"}}", "bad": 5 }));
    p.set(&json!({ "key": "transitionMs", "value": "250" }));
    p.set(&json!({ "key": "uiLang", "value": null }));
    p.set(&json!({ "key": "", "value": "x" }));
    p.set(&json!({ "key": "huge", "value": "x".repeat(600 * 1024) }));
    p.flush();

    let again = crate::prefs::Prefs::load(&d.0);
    let js = again.init_script().unwrap();
    assert!(js.contains("Montserrat") && js.contains("transitionMs"));
    assert!(!js.contains("uiLang") && !js.contains("\"bad\"") && !js.contains("huge"));
    let saved: Value = serde_json::from_slice(&std::fs::read(d.0.join("settings.json")).unwrap()).unwrap();
    assert_eq!(saved["transitionMs"], "250");
}

fn fixture_fonts() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../tests/fixtures/fonts")
}

#[test]
fn installed_fonts_are_found_with_their_files() {
    let cat = crate::fonts::scan(&[fixture_fonts()]);
    // Typographic family names group the weights the way browsers do.
    assert_eq!(cat.families, vec!["BP Test Latin", "BP Test Sans", "BP Test Var"]);
    let mut w: Vec<_> = cat.faces("BP Test Sans").iter().map(|f| f.weight.clone()).collect();
    w.sort();
    assert_eq!(w, vec!["400", "600", "700"]);
    // A variable font is declared over its whole weight range, so weight 400
    // isn't drawn at the file's default (Thin) instance.
    assert_eq!(cat.faces("BP Test Var")[0].weight, "100 900");
    use crate::fonts::{COVER_CYRILLIC, COVER_UKRAINIAN};
    assert_eq!(cat.cover["BP Test Sans"] & 3, COVER_CYRILLIC | COVER_UKRAINIAN);
    assert_eq!(cat.cover["BP Test Var"] & 3, COVER_CYRILLIC, "Russian letters only");
    assert_eq!(cat.cover["BP Test Latin"], 0);
}

#[test]
fn every_family_of_a_font_collection_is_listed() {
    // Three of the test fonts packed into one .ttc, the way Windows and macOS
    // ship "MS Gothic" + "MS UI Gothic" or the PingFang set.
    let d = TempData::new();
    let files: Vec<Vec<u8>> = ["test-latin.ttf", "test-sans-regular.ttf", "test-var.ttf"].iter().map(|n| std::fs::read(fixture_fonts().join(n)).unwrap()).collect();
    let mut ttc = b"ttcf\0\x01\0\0".to_vec();
    ttc.extend((files.len() as u32).to_be_bytes());
    let mut bases = Vec::new();
    let mut base = 12 + 4 * files.len();
    for f in &files {
        bases.push(base);
        base += (f.len() + 3) & !3;
    }
    for b in &bases {
        ttc.extend((*b as u32).to_be_bytes());
    }
    for (f, b) in files.iter().zip(&bases) {
        let mut f = f.clone();
        for i in 0..u16::from_be_bytes([f[4], f[5]]) as usize {
            let at = 12 + i * 16 + 8;
            let off = u32::from_be_bytes([f[at], f[at + 1], f[at + 2], f[at + 3]]) + *b as u32;
            f[at..at + 4].copy_from_slice(&off.to_be_bytes());
        }
        f.resize((f.len() + 3) & !3, 0);
        ttc.extend(f);
    }
    std::fs::write(d.0.join("pack.ttc"), ttc).unwrap();
    std::fs::write(d.0.join("cut.ttc"), b"ttcf\0\x01\0\0\0\0\xff\xff").unwrap();
    let cat = crate::fonts::scan(&[d.0.clone()]);
    assert_eq!(cat.families, vec!["BP Test Latin", "BP Test Sans", "BP Test Var"]);
    assert!(cat.faces("BP Test Sans").is_empty(), "collections are listed by name, not served as web fonts");
}

#[test]
fn live_output_serves_font_files_by_id_only() {
    crate::fonts::use_for_tests(&[fixture_fonts()]);
    let w = Webcast::default();
    let resolver: crate::webcast::MediaResolver = Arc::new(|_: &str| None);
    let port = w.start(0, resolver).unwrap()["port"].as_u64().unwrap();
    let c = http();
    let base = format!("http://127.0.0.1:{port}");
    assert_eq!(c.get(format!("{base}/fontfaces.js")).send().unwrap().status(), 200);
    let j: Value = c.get(format!("{base}/fonts?family=BP%20Test%20Sans")).send().unwrap().json().unwrap();
    let faces = j["faces"].as_array().unwrap();
    assert_eq!(faces.len(), 3);
    let url = faces[0]["url"].as_str().unwrap();
    assert!(url.starts_with("/font/") && !url.contains("ttf") && !j.to_string().contains("fixtures"), "no paths or file names: {j}");
    let r = c.get(format!("{base}{url}")).send().unwrap();
    assert_eq!(r.status(), 200);
    assert_eq!(&r.bytes().unwrap()[..4], &[0, 1, 0, 0]);
    let none: Value = c.get(format!("{base}/fonts?family=Nope")).send().unwrap().json().unwrap();
    assert_eq!(none["faces"].as_array().unwrap().len(), 0);
    for bad in ["/font/0000000000000000", "/font/..%2F..%2Fetc%2Fpasswd", "/font/test-latin.ttf"] {
        assert_eq!(c.get(format!("{base}{bad}")).send().unwrap().status(), 404, "{bad}");
    }
    // Same host check as every other route.
    assert_eq!(c.get(format!("{base}{url}")).header("Host", "evil.example.com").send().unwrap().status(), 403);
    w.stop();
}
