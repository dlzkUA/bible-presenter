//! Songs, collections, playlists, projector themes, live-output themes,
//! backgrounds and media sets: everything that is a JSON file (and its media)
//! in the data folder.

use crate::dialogs;
use crate::state::AppState;
use crate::store::*;
use serde_json::{json, Map, Value};
use std::collections::HashSet;
use std::fs;
use std::path::{Path, PathBuf};
use tauri::AppHandle;

pub const MEDIA_EXT: [&str; 10] = ["jpg", "jpeg", "png", "webp", "gif", "bmp", "mp4", "webm", "mov", "m4v"];
const IMAGE_EXT: [&str; 6] = ["jpg", "jpeg", "png", "webp", "gif", "bmp"];
const VIDEO_EXT: [&str; 4] = ["mp4", "webm", "mov", "m4v"];

pub fn is_video(name: &str) -> bool {
    let e = extname(name).trim_start_matches('.').to_lowercase();
    VIDEO_EXT.contains(&e.as_str())
}
fn is_media(name: &str) -> bool {
    let e = extname(name).trim_start_matches('.').to_lowercase();
    MEDIA_EXT.contains(&e.as_str())
}
fn kind(name: &str) -> &'static str {
    if is_video(name) { "video" } else { "image" }
}
fn p2s(p: &Path) -> String {
    p.to_string_lossy().to_string()
}

type R = Result<Value, String>;

pub fn handle(app: &AppHandle, st: &AppState, ch: &str, arg: &Value) -> Option<R> {
    let p = &st.paths;
    let r = match ch {
        // ---------------- songs ----------------
        "songCollections:list" => Ok(json!(all_song_collections(p))),
        "songCollections:add" => {
            let clean = arg.as_str().unwrap_or("").trim().to_string();
            if !clean.is_empty() {
                let mut list = read_song_collections(p);
                if !list.contains(&clean) {
                    list.push(clean);
                    if let Err(e) = write_json_atomic(&p.song_collections, &list, true) { return Some(Err(e)); }
                }
            }
            Ok(json!(all_song_collections(p)))
        }
        "songs:list" => Ok(Value::Array(
            list_json_dir(&p.songs)
                .into_iter()
                .map(|(id, d)| json!({ "id": id, "title": d.get("title").cloned().unwrap_or(Value::Null), "collection": str_of(&d, "collection") }))
                .collect(),
        )),
        "songs:get" => {
            let id = arg.as_str().unwrap_or("");
            Ok(if is_safe_id(id) { read_json_safe(&p.songs.join(format!("{id}.json"))).unwrap_or(Value::Null) } else { Value::Null })
        }
        "songs:save" => save_song(p, arg),
        "songs:delete" => {
            let id = arg.as_str().unwrap_or("");
            json_path(&p.songs, id).map(|fp| {
                remove_file_quiet(&fp);
                json!(true)
            })
        }
        "songs:exportFile" => export_song(app, st, arg.as_str().unwrap_or("")),
        "songs:importFile" => import_song_files(app, st),

        // ---------------- playlists ----------------
        "playlists:list" => Ok(Value::Array(
            list_json_dir(&p.playlists).into_iter().map(|(id, d)| json!({ "id": id, "name": d.get("name").cloned().unwrap_or(Value::Null) })).collect(),
        )),
        "playlists:get" => json_path(&p.playlists, arg.as_str().unwrap_or("")).map(|fp| read_json_safe(&fp).unwrap_or(Value::Null)),
        "playlists:save" => {
            let name = str_of(arg, "name");
            let id = id_or_new(arg, name);
            let to_save = json!({ "name": arg.get("name").cloned().unwrap_or(Value::Null), "items": arg.get("items").cloned().unwrap_or(json!([])) });
            json_path(&p.playlists, &id).and_then(|fp| write_json_atomic(&fp, &to_save, true)).map(|_| with_id(&id, &to_save))
        }
        "playlists:delete" => json_path(&p.playlists, arg.as_str().unwrap_or("")).map(|fp| {
            remove_file_quiet(&fp);
            json!(true)
        }),
        "playlists:exportFile" => export_playlist(app, st, arg.as_str().unwrap_or("")),
        "playlists:importFile" => import_playlist(app, st),

        // ---------------- projector themes ----------------
        "themes:list" => Ok(Value::Array(
            list_json_dir(&p.themes).into_iter().map(|(id, d)| json!({ "id": id, "name": d.get("name").cloned().unwrap_or(Value::Null) })).collect(),
        )),
        "themes:get" => json_path(&p.themes, arg.as_str().unwrap_or("")).map(|fp| {
            let mut data = read_json_safe(&fp).unwrap_or(Value::Null);
            // The background file may live in the backgrounds library or in Media.
            let bg = str_of(&data, "bgFile").to_string();
            if !bg.is_empty() {
                let in_lib = p.backgrounds.join(basename(&bg));
                let path = if in_lib.exists() { in_lib } else { p.media.join(basename(&bg)) };
                data["bgPath"] = json!(p2s(&path));
            }
            data
        }),
        "themes:delete" => json_path(&p.themes, arg.as_str().unwrap_or("")).map(|fp| {
            remove_file_quiet(&fp);
            json!(true)
        }),
        "themes:save" => {
            let id = id_or_new(arg, str_of(arg, "name"));
            let to_save = theme_fields(arg, false);
            json_path(&p.themes, &id).and_then(|fp| write_json_atomic(&fp, &to_save, true)).map(|_| with_id(&id, &to_save))
        }
        "themes:exportFile" => export_theme(app, st, arg.as_str().unwrap_or("")),
        "themes:importFile" => import_theme(app, st),

        // ---------------- presentations (stored slides) ----------------
        "presentations:list" => Ok(Value::Array(
            list_json_dir(&p.presentations)
                .into_iter()
                .map(|(id, d)| {
                    let count = d.get("slideCount").cloned().filter(|v| !v.is_null())
                        .unwrap_or_else(|| json!(d.get("slides").and_then(|s| s.as_array()).map(|a| a.len()).unwrap_or(0)));
                    json!({ "id": id, "title": d.get("title").cloned().unwrap_or(Value::Null), "slideCount": count, "collection": str_of(&d, "collection") })
                })
                .collect(),
        )),
        "presentations:setCollection" => {
            let id = str_of(arg, "id");
            json_path(&p.presentations, id).and_then(|fp| match read_json_safe(&fp) {
                None => Ok(Value::Null),
                Some(mut d) => {
                    d["collection"] = json!(str_of(arg, "collection"));
                    write_json_atomic(&fp, &d, true).map(|_| json!(true))
                }
            })
        }
        "presentations:get" => {
            let id = arg.as_str().unwrap_or("");
            if !is_safe_id(id) {
                Ok(Value::Null)
            } else {
                Ok(match read_json_safe(&p.presentations.join(format!("{id}.json"))) {
                    None => Value::Null,
                    Some(mut d) => {
                        let pdf = str_of(&d, "pdfFile").to_string();
                        if !pdf.is_empty() {
                            d["pdfPath"] = json!(p2s(&p.media.join(basename(&pdf))));
                        }
                        if let Some(slides) = d.get_mut("slides").and_then(|s| s.as_array_mut()) {
                            for s in slides.iter_mut() {
                                let img = str_of(s, "image").to_string();
                                if s.is_object() {
                                    s["imagePath"] = if img.is_empty() { Value::Null } else { json!(p2s(&p.media.join(basename(&img)))) };
                                }
                            }
                        }
                        d
                    }
                })
            }
        }
        "presentations:delete" => json_path(&p.presentations, arg.as_str().unwrap_or("")).map(|fp| {
            if let Some(d) = read_json_safe(&fp) {
                let pdf = str_of(&d, "pdfFile");
                if !pdf.is_empty() {
                    remove_file_quiet(&p.media.join(basename(pdf)));
                }
                for s in d.get("slides").and_then(|s| s.as_array()).cloned().unwrap_or_default() {
                    let img = str_of(&s, "image");
                    if !img.is_empty() {
                        remove_file_quiet(&p.media.join(basename(img)));
                    }
                }
            }
            remove_file_quiet(&fp);
            json!(true)
        }),

        // ---------------- backgrounds ----------------
        "backgrounds:list" => Ok(json!(scan_backgrounds(p))),
        "backgrounds:listAll" => {
            let lib = scan_backgrounds(p);
            let mut seen: HashSet<String> = lib.iter().map(|i| str_of(i, "file").to_string()).collect();
            let mut out = lib;
            for (_id, set) in list_json_dir(&p.announcements) {
                let title = set.get("title").cloned().unwrap_or(Value::Null);
                for f in set.get("images").and_then(|a| a.as_array()).cloned().unwrap_or_default() {
                    let Some(f) = f.as_str() else { continue };
                    if !is_media(f) || seen.contains(f) {
                        continue;
                    }
                    seen.insert(f.to_string());
                    out.push(json!({ "file": f, "type": kind(f), "path": p2s(&p.media.join(basename(f))), "source": "media", "setTitle": title }));
                }
            }
            Ok(json!(out))
        }
        "backgrounds:import" => {
            let files = dialogs::pick_files(app, &st.t("Додати фони (картинки та відео)"), &[(&st.t("Картинки та відео"), &MEDIA_EXT)]);
            let mut added = Vec::new();
            for src in files {
                match add_background(p, &src, &basename(&p2s(&src)), false, added.len()) {
                    Ok(v) => added.push(v),
                    Err(e) => return Some(Err(e)),
                }
            }
            Ok(json!(added))
        }
        "backgrounds:importPaths" => {
            let mut added = Vec::new();
            for item in incoming(arg) {
                if !is_media(&item.name) || !item.path.is_file() {
                    continue;
                }
                match add_background(p, &item.path, &item.name, item.temp, added.len()) {
                    Ok(mut v) => {
                        v["source"] = json!("library");
                        added.push(v)
                    }
                    Err(e) => eprintln!("Skipping dropped background {}: {e}", item.name),
                }
            }
            Ok(json!(added))
        }
        "backgrounds:delete" => {
            let f = basename(arg.as_str().unwrap_or(""));
            if !f.is_empty() {
                remove_file_quiet(&p.backgrounds.join(f));
            }
            Ok(json!(true))
        }
        "media:importBackground" => {
            match dialogs::pick_file(app, &st.t("Оберіть фон (картинка або відео)"), &[(&st.t("Картинки та відео"), &MEDIA_EXT)]) {
                None => Ok(Value::Null),
                Some(src) => {
                    let name = basename(&p2s(&src));
                    let ext = extname(&name);
                    let out = format!("{}-{}{}", slugify(&stem(&name)), stamp36(), ext);
                    fs::copy(&src, p.media.join(&out)).map_err(|e| e.to_string()).map(|_| {
                        json!({ "file": out, "type": kind(&out), "path": p2s(&p.media.join(&out)) })
                    })
                }
            }
        }

        // ---------------- live-output (stream) themes ----------------
        "streamThemes:list" => Ok(Value::Array(
            list_json_dir(&p.stream_themes)
                .into_iter()
                .map(|(id, d)| json!({ "id": id, "name": d.get("name").cloned().unwrap_or(Value::Null), "target": d.get("target").cloned().unwrap_or(Value::Null) }))
                .collect(),
        )),
        "streamThemes:get" => json_path(&p.stream_themes, arg.as_str().unwrap_or("")).map(|fp| read_json_safe(&fp).unwrap_or(Value::Null)),
        "streamThemes:save" => {
            let name = arg.get("name").and_then(|v| v.as_str()).filter(|s| !s.is_empty()).unwrap_or("theme");
            let id = id_or_new(arg, name);
            let mut data = arg.clone();
            if !data.is_object() {
                data = json!({});
            }
            data["id"] = json!(id);
            json_path(&p.stream_themes, &id).and_then(|fp| write_json_atomic(&fp, &data, true)).map(|_| data)
        }
        "streamThemes:delete" => json_path(&p.stream_themes, arg.as_str().unwrap_or("")).map(|fp| {
            remove_file_quiet(&fp);
            json!(true)
        }),
        "streamThemes:importFile" => import_stream_theme(app, st),
        "streamThemes:exportFile" => {
            let name = arg.get("name").and_then(|v| v.as_str()).filter(|s| !s.is_empty()).unwrap_or("theme");
            match dialogs::save_file(app, &st.t("Експортувати тему трансляції"), &format!("{}.json", safe_file_name(name)), &[("Bible Presenter Theme", &["json"])]) {
                None => Ok(Value::Null),
                Some(fp) => write_json_pretty(&fp, arg).map(|_| json!(p2s(&fp))),
            }
        }

        // ---------------- media sets ("announcements") ----------------
        "announcements:list" => Ok(Value::Array(
            list_json_dir(&p.announcements)
                .into_iter()
                .map(|(id, d)| json!({ "id": id, "title": d.get("title").cloned().unwrap_or(Value::Null), "imageCount": d.get("images").and_then(|a| a.as_array()).map(|a| a.len()).unwrap_or(0) }))
                .collect(),
        )),
        "announcements:get" => json_path(&p.announcements, arg.as_str().unwrap_or("")).map(|fp| match read_json_safe(&fp) {
            None => Value::Null,
            Some(mut d) => {
                let imgs: Vec<Value> = d.get("images").and_then(|a| a.as_array()).cloned().unwrap_or_default()
                    .into_iter()
                    .filter_map(|i| i.as_str().map(|s| json!({ "file": s, "path": p2s(&p.media.join(basename(s))) })))
                    .collect();
                d["images"] = json!(imgs);
                d
            }
        }),
        "announcements:delete" => {
            let id = arg.as_str().unwrap_or("");
            json_path(&p.announcements, id).map(|fp| {
                if let Some(d) = read_json_safe(&fp) {
                    let used = media_used_elsewhere(p, id);
                    for img in d.get("images").and_then(|a| a.as_array()).cloned().unwrap_or_default() {
                        if let Some(img) = img.as_str() {
                            if !used.contains(img) {
                                remove_file_quiet(&p.media.join(basename(img)));
                            }
                        }
                    }
                }
                remove_file_quiet(&fp);
                json!(true)
            })
        }
        "announcements:rename" => {
            let id = str_of(arg, "id");
            json_path(&p.announcements, id).and_then(|fp| match read_json_safe(&fp) {
                None => Ok(Value::Null),
                Some(mut d) => {
                    let t = str_of(arg, "title").trim().to_string();
                    if !t.is_empty() {
                        d["title"] = json!(t);
                    }
                    write_json_atomic(&fp, &d, true).map(|_| json!({ "id": id, "title": d.get("title").cloned().unwrap_or(Value::Null) }))
                }
            })
        }
        "announcements:removeImage" => {
            let id = str_of(arg, "id");
            let file = str_of(arg, "file");
            json_path(&p.announcements, id).and_then(|fp| {
                let Some(mut d) = read_json_safe(&fp) else { return Ok(Value::Null) };
                let Some(imgs) = d.get("images").and_then(|a| a.as_array()).cloned() else { return Ok(Value::Null) };
                let left: Vec<Value> = imgs.into_iter().filter(|i| i.as_str() != Some(file)).collect();
                d["images"] = json!(left);
                if !media_used_elsewhere(p, id).contains(file) && !file.is_empty() {
                    remove_file_quiet(&p.media.join(basename(file)));
                }
                if left.is_empty() {
                    remove_file_quiet(&fp);
                    let mut out = with_id(id, &d);
                    out["deleted"] = json!(true);
                    return Ok(out);
                }
                write_json_atomic(&fp, &d, true).map(|_| with_id(id, &d))
            })
        }
        "announcements:importImages" => {
            let files = dialogs::pick_files(
                app,
                &st.t("Імпорт медіа (об'яви) — картинки та відео"),
                &[(&st.t("Картинки та відео"), &MEDIA_EXT), (&st.t("Картинки"), &IMAGE_EXT), (&st.t("Відео"), &VIDEO_EXT)],
            );
            if files.is_empty() {
                Ok(Value::Null)
            } else {
                let items: Vec<Incoming> = files.into_iter().map(|f| Incoming { name: basename(&p2s(&f)), path: f, temp: false }).collect();
                add_media(st, items, arg.get("existingId").and_then(|v| v.as_str()), arg.get("defaultTitle").and_then(|v| v.as_str()), true)
            }
        }
        "announcements:importPaths" => {
            let items: Vec<Incoming> = incoming(arg.get("paths").unwrap_or(&Value::Null))
                .into_iter()
                .filter(|i| is_media(&i.name) && i.path.is_file())
                .collect();
            add_media(st, items, arg.get("existingId").and_then(|v| v.as_str()), arg.get("defaultTitle").and_then(|v| v.as_str()), false)
        }
        _ => return None,
    };
    Some(r)
}

fn with_id(id: &str, data: &Value) -> Value {
    let mut m = Map::new();
    m.insert("id".into(), json!(id));
    if let Some(o) = data.as_object() {
        for (k, v) in o {
            m.insert(k.clone(), v.clone());
        }
    }
    Value::Object(m)
}

fn id_or_new(arg: &Value, name: &str) -> String {
    match arg.get("id").and_then(|v| v.as_str()) {
        Some(id) if !id.is_empty() => id.to_string(),
        _ => format!("{}-{}", slugify(name), stamp36()),
    }
}

// ---- song collections ----
// A small registry of collection names, so an empty collection can be made
// ahead of time; names that only exist because a song uses them count too.
fn read_song_collections(p: &Paths) -> Vec<String> {
    read_json_safe(&p.song_collections)
        .and_then(|v| v.as_array().cloned())
        .map(|a| a.into_iter().filter_map(|x| x.as_str().map(String::from)).collect())
        .unwrap_or_default()
}
fn remember_collection(p: &Paths, name: &str) {
    if name.is_empty() {
        return;
    }
    let mut list = read_song_collections(p);
    if !list.iter().any(|x| x == name) {
        list.push(name.to_string());
        let _ = write_json_atomic(&p.song_collections, &list, true);
    }
}
fn all_song_collections(p: &Paths) -> Vec<String> {
    let mut seen = HashSet::new();
    let mut out = Vec::new();
    let derived = list_json_dir(&p.songs).into_iter().map(|(_, d)| str_of(&d, "collection").to_string());
    for c in read_song_collections(p).into_iter().chain(derived) {
        if !c.is_empty() && seen.insert(c.clone()) {
            out.push(c);
        }
    }
    out
}

/// Songs are autosaved while the operator types; the write is atomic.
pub fn save_song(p: &Paths, song: &Value) -> R {
    let id = id_or_new(song, str_of(song, "title"));
    let collection = str_of(song, "collection").to_string();
    let mut to_save = Map::new();
    if let Some(t) = song.get("title") {
        to_save.insert("title".into(), t.clone());
    }
    if let Some(s) = song.get("sections") {
        to_save.insert("sections".into(), s.clone());
    }
    to_save.insert("collection".into(), json!(collection));
    let to_save = Value::Object(to_save);
    remember_collection(p, &collection);
    let fp = json_path(&p.songs, &id)?;
    write_json_atomic(&fp, &to_save, true)?;
    Ok(with_id(&id, &to_save))
}

fn export_song(app: &AppHandle, st: &AppState, id: &str) -> R {
    let Some(data) = json_path(&st.paths.songs, id).ok().and_then(|fp| read_json_safe(&fp)) else { return Ok(Value::Null) };
    let title = data.get("title").and_then(|v| v.as_str()).filter(|s| !s.is_empty()).unwrap_or("song");
    let Some(fp) = dialogs::save_file(app, &st.t("Експортувати пісню"), &format!("{}.bpsong.json", safe_file_name(title)), &[("Bible Presenter Song", &["json"])]) else {
        return Ok(Value::Null);
    };
    let mut out = json!({ "format": "bible-presenter-song", "version": 1 });
    for (k, v) in data.as_object().cloned().unwrap_or_default() {
        out[k] = v;
    }
    write_json_pretty(&fp, &out)?;
    Ok(json!(p2s(&fp)))
}

fn import_song_files(app: &AppHandle, st: &AppState) -> R {
    let p = &st.paths;
    let files = dialogs::pick_files(app, &st.t("Імпортувати пісню (JSON)"), &[("Bible Presenter Song", &["json"])]);
    let mut imported = Vec::new();
    let mut failed = Vec::new();
    for fp in files {
        let name = basename(&p2s(&fp));
        let raw = fs::read_to_string(&fp).ok().and_then(|t| serde_json::from_str::<Value>(strip_bom(&t)).ok());
        // Only files that really carry song sections: a theme or playlist
        // picked by mistake used to become an empty song.
        let ok = raw.as_ref().and_then(|r| r.get("sections")).and_then(|s| s.as_array()).map(|a| {
            !a.is_empty() && a.iter().all(|sec| sec.is_object() && sec.get("slides").map(|x| x.is_array()).unwrap_or(false))
        }) == Some(true);
        if !ok {
            failed.push(name);
            continue;
        }
        let raw = raw.unwrap();
        let title = raw.get("title").and_then(|v| v.as_str()).filter(|s| !s.is_empty()).map(String::from).unwrap_or_else(|| name.trim_end_matches(".json").to_string());
        let id = format!("{}-{}-{}", slugify(&title), stamp36(), imported.len());
        let collection = str_of(&raw, "collection").to_string();
        let to_save = json!({ "title": title, "sections": raw.get("sections").cloned().unwrap_or(json!([])), "collection": collection });
        match json_path(&p.songs, &id).and_then(|f| write_json_atomic(&f, &to_save, true)) {
            Ok(_) => {
                remember_collection(p, &collection);
                imported.push(with_id(&id, &to_save));
            }
            Err(_) => failed.push(name),
        }
    }
    Ok(json!({ "songs": imported, "failed": failed }))
}

// ---- playlists ----
// Items reference songs by id, which won't exist on another computer, so the
// export carries the songs themselves.
fn export_playlist(app: &AppHandle, st: &AppState, id: &str) -> R {
    let p = &st.paths;
    let Some(data) = json_path(&p.playlists, id).ok().and_then(|fp| read_json_safe(&fp)) else { return Ok(Value::Null) };
    let name = data.get("name").and_then(|v| v.as_str()).filter(|s| !s.is_empty()).unwrap_or("playlist");
    let Some(fp) = dialogs::save_file(app, &st.t("Експортувати плейлист"), &format!("{}.bpplaylist.json", safe_file_name(name)), &[("Bible Presenter Playlist", &["json"])]) else {
        return Ok(Value::Null);
    };
    let mut songs = Map::new();
    for it in data.get("items").and_then(|a| a.as_array()).cloned().unwrap_or_default() {
        if str_of(&it, "type") == "song" {
            let sid = str_of(&it, "songId");
            if is_safe_id(sid) && !songs.contains_key(sid) {
                if let Some(song) = read_json_safe(&p.songs.join(format!("{sid}.json"))) {
                    songs.insert(sid.to_string(), song);
                }
            }
        }
    }
    let mut out = json!({ "format": "bible-presenter-playlist", "version": 2 });
    for (k, v) in data.as_object().cloned().unwrap_or_default() {
        out[k] = v;
    }
    out["songs"] = Value::Object(songs);
    write_json_pretty(&fp, &out)?;
    Ok(json!(p2s(&fp)))
}

fn import_playlist(app: &AppHandle, st: &AppState) -> R {
    let p = &st.paths;
    let Some(fp) = dialogs::pick_file(app, &st.t("Імпортувати плейлист (JSON)"), &[("Bible Presenter Playlist", &["json"])]) else {
        return Ok(Value::Null);
    };
    let text = fs::read_to_string(&fp).map_err(|e| e.to_string())?;
    let raw: Value = serde_json::from_str(strip_bom(&text)).map_err(|e| format!("JSON.parse: {e}"))?;
    let Some(items) = raw.get("items").and_then(|a| a.as_array()).cloned() else { return Err("WRONG_FILE_KIND".into()) };
    let name = raw.get("name").and_then(|v| v.as_str()).filter(|s| !s.is_empty()).map(String::from)
        .unwrap_or_else(|| basename(&p2s(&fp)).trim_end_matches(".json").to_string());
    let id = format!("{}-{}", slugify(&name), stamp36());
    // Songs that came inside the file and are not in this library yet are
    // added under the same id; an existing local copy is kept as it is.
    let mut added = 0;
    if let Some(songs) = raw.get("songs").and_then(|s| s.as_object()) {
        for (sid, song) in songs {
            if !is_safe_id(sid) {
                continue;
            }
            let sp = p.songs.join(format!("{sid}.json"));
            if !sp.exists() && write_json_atomic(&sp, song, true).is_ok() {
                added += 1;
            }
        }
    }
    let missing: Vec<Value> = items
        .iter()
        .filter(|it| {
            let t = str_of(it, "type");
            (t == "song" && !str_of(it, "songId").is_empty() && {
                let s = str_of(it, "songId");
                !is_safe_id(s) || !p.songs.join(format!("{s}.json")).exists()
            }) || (t == "presentation" && !str_of(it, "presId").is_empty() && {
                let s = str_of(it, "presId");
                !is_safe_id(s) || !p.presentations.join(format!("{s}.json")).exists()
            }) || (t == "announcement" && !str_of(it, "imagePath").is_empty() && !Path::new(str_of(it, "imagePath")).exists())
        })
        .map(|it| {
            let t = str_of(it, "title");
            json!(if t.is_empty() { str_of(it, "type") } else { t })
        })
        .collect();
    let to_save = json!({ "name": name, "items": items });
    write_json_atomic(&json_path(&p.playlists, &id)?, &to_save, true)?;
    let mut out = with_id(&id, &to_save);
    out["addedSongs"] = json!(added);
    out["missing"] = json!(missing);
    Ok(out)
}

// ---- projector themes ----
fn num_or(v: &Value, key: &str, d: f64) -> Value {
    match v.get(key) {
        Some(x) if !x.is_null() => x.clone(),
        _ => json!(d),
    }
}
fn theme_fields(t: &Value, imported: bool) -> Value {
    let or_null = |k: &str| t.get(k).cloned().unwrap_or(Value::Null);
    let truthy = |k: &str| t.get(k).map(|v| match v {
        Value::Bool(b) => *b,
        Value::Null => false,
        Value::Number(n) => n.as_f64().unwrap_or(0.0) != 0.0,
        Value::String(s) => !s.is_empty(),
        _ => true,
    }).unwrap_or(false);
    let s_or = |k: &str, d: &str| t.get(k).and_then(|v| v.as_str()).filter(|s| !s.is_empty()).unwrap_or(d).to_string();
    json!({
        "name": or_null("name"),
        "fontFamily": or_null("fontFamily"),
        "fontSize": or_null("fontSize"),
        "color": or_null("color"),
        "background": or_null("background"),
        "align": or_null("align"),
        "valign": or_null("valign"),
        "uppercase": truthy("uppercase"),
        "bold": truthy("bold"),
        "letterSpacing": num_or(t, "letterSpacing", 0.0),
        "lineHeight": num_or(t, "lineHeight", 1.3),
        "lineGap": num_or(t, "lineGap", 0.0),
        "shadow": t.get("shadow") != Some(&json!(false)),
        "target": s_or("target", "both"),
        "bgFile": if imported { Value::Null } else { t.get("bgFile").filter(|v| v.as_str().map(|s| !s.is_empty()).unwrap_or(false)).cloned().unwrap_or(Value::Null) },
        "bgType": t.get("bgType").filter(|v| v.as_str().map(|s| !s.is_empty()).unwrap_or(false)).cloned().unwrap_or(Value::Null),
        "bgFit": s_or("bgFit", "cover"),
    })
}

fn export_theme(app: &AppHandle, st: &AppState, id: &str) -> R {
    let p = &st.paths;
    let Some(data) = json_path(&p.themes, id).ok().and_then(|fp| read_json_safe(&fp)) else { return Ok(Value::Null) };
    let name = data.get("name").and_then(|v| v.as_str()).filter(|s| !s.is_empty()).unwrap_or("theme");
    let Some(fp) = dialogs::save_file(app, &st.t("Експортувати тему"), &format!("{}.bptheme.json", safe_file_name(name)), &[("Bible Presenter Theme", &["json"])]) else {
        return Ok(Value::Null);
    };
    let mut payload = json!({ "format": "bible-presenter-theme", "version": 1 });
    for (k, v) in data.as_object().cloned().unwrap_or_default() {
        payload[k] = v;
    }
    // The background travels as a file next to the theme JSON.
    let bg = str_of(&data, "bgFile").to_string();
    if !bg.is_empty() {
        let lib = p.backgrounds.join(basename(&bg));
        let src = if lib.exists() { lib } else { p.media.join(basename(&bg)) };
        if src.exists() {
            let out_name = format!("{}-bg{}", basename(&p2s(&fp)).trim_end_matches(".json"), extname(&bg));
            let out = fp.parent().map(|d| d.join(&out_name)).unwrap_or_else(|| PathBuf::from(&out_name));
            if fs::copy(&src, &out).is_ok() {
                payload["bgSidecar"] = json!(out_name);
            }
        }
    }
    write_json_pretty(&fp, &payload)?;
    Ok(json!(p2s(&fp)))
}

fn import_theme(app: &AppHandle, st: &AppState) -> R {
    let p = &st.paths;
    let Some(fp) = dialogs::pick_file(app, &st.t("Імпортувати тему (JSON)"), &[("Bible Presenter Theme", &["json"])]) else {
        return Ok(Value::Null);
    };
    let text = fs::read_to_string(&fp).map_err(|e| e.to_string())?;
    let raw: Value = serde_json::from_str(strip_bom(&text)).map_err(|e| format!("JSON.parse: {e}"))?;
    // A song or playlist picked by mistake must not turn into an empty theme.
    let o = raw.as_object();
    let looks_like_theme = o.map(|o| {
        !o.get("sections").map(|v| v.is_array()).unwrap_or(false)
            && !o.get("items").map(|v| v.is_array()).unwrap_or(false)
            && ["fontSize", "fontFamily", "color", "background"].iter().any(|k| o.contains_key(*k))
    }) == Some(true);
    if !looks_like_theme {
        return Err("WRONG_FILE_KIND".into());
    }
    let name = raw.get("name").and_then(|v| v.as_str()).filter(|s| !s.is_empty()).map(String::from)
        .unwrap_or_else(|| basename(&p2s(&fp)).trim_end_matches(".json").to_string());
    let id = format!("{}-{}", slugify(&name), stamp36());
    let mut with_name = raw.clone();
    with_name["name"] = json!(name);
    let mut to_save = theme_fields(&with_name, true);
    let sidecar = str_of(&raw, "bgSidecar");
    if !sidecar.is_empty() {
        let sp = fp.parent().map(|d| d.join(basename(sidecar))).unwrap_or_default();
        if sp.exists() {
            let dest = format!("{}-{}{}", slugify(&name), stamp36(), extname(sidecar));
            if fs::copy(&sp, p.backgrounds.join(&dest)).is_ok() {
                to_save["bgFile"] = json!(dest);
            }
        }
    }
    write_json_atomic(&json_path(&p.themes, &id)?, &to_save, true)?;
    Ok(with_id(&id, &to_save))
}

pub fn save_new_theme(p: &Paths, theme: &Value) -> R {
    let id = format!("{}-{}", slugify(str_of(theme, "name")), stamp36());
    write_json_atomic(&json_path(&p.themes, &id)?, theme, true)?;
    Ok(with_id(&id, theme))
}

fn import_stream_theme(app: &AppHandle, st: &AppState) -> R {
    let p = &st.paths;
    let Some(fp) = dialogs::pick_file(app, &st.t("Імпорт теми трансляції (JSON)"), &[("Bible Presenter Theme", &["json"])]) else {
        return Ok(Value::Null);
    };
    let text = fs::read_to_string(&fp).map_err(|e| e.to_string())?;
    let raw: Value = serde_json::from_str(strip_bom(&text)).map_err(|e| format!("JSON.parse: {e}"))?;
    let bad = !raw.is_object() || raw.get("sections").map(|v| v.is_array()).unwrap_or(false) || raw.get("items").map(|v| v.is_array()).unwrap_or(false);
    if bad {
        return Err("WRONG_FILE_KIND".into());
    }
    let target = if str_of(&raw, "target") == "bible" { "bible" } else { "song" };
    // Older exports carried a generic placeholder name; the file's own name is
    // what the operator actually chose then.
    const GENERIC: [&str; 5] = ["song theme", "bible theme", "verse theme", "theme", "untitled"];
    let inner = str_of(&raw, "name").trim().to_string();
    let file_base = basename(&p2s(&fp)).trim_end_matches(".json").trim().to_string();
    let mut name = if !inner.is_empty() && !GENERIC.contains(&inner.to_lowercase().as_str()) {
        inner.clone()
    } else if !file_base.is_empty() {
        file_base
    } else if !inner.is_empty() {
        inner
    } else {
        "Theme".into()
    };
    let taken: HashSet<String> = list_json_dir(&p.stream_themes)
        .into_iter()
        .filter(|(_, d)| str_of(d, "target") == target)
        .map(|(_, d)| str_of(&d, "name").to_string())
        .collect();
    if taken.contains(&name) {
        let mut n = 2;
        while taken.contains(&format!("{name} {n}")) {
            n += 1;
        }
        name = format!("{name} {n}");
    }
    let id = format!("{}-{}", slugify(&name), stamp36());
    let mut data = raw.clone();
    data["id"] = json!(id);
    data["name"] = json!(name);
    data["target"] = json!(target);
    write_json_atomic(&json_path(&p.stream_themes, &id)?, &data, true)?;
    Ok(data)
}

// ---- backgrounds ----
fn scan_backgrounds(p: &Paths) -> Vec<Value> {
    let Ok(rd) = fs::read_dir(&p.backgrounds) else { return vec![] };
    rd.filter_map(|e| e.ok())
        .filter_map(|e| e.file_name().into_string().ok())
        .filter(|f| is_media(f))
        .map(|f| json!({ "file": f, "type": kind(&f), "path": p2s(&p.backgrounds.join(&f)), "source": "library" }))
        .collect()
}

/// A file handed in by the page: a real path (from a dialog) or a dropped file
/// the bridge has already stored in the incoming folder.
pub struct Incoming {
    pub path: PathBuf,
    pub name: String,
    pub temp: bool,
}

pub fn incoming(list: &Value) -> Vec<Incoming> {
    list.as_array()
        .cloned()
        .unwrap_or_default()
        .into_iter()
        .filter_map(|x| match x {
            Value::String(s) => Some(Incoming { name: basename(&s), path: PathBuf::from(s), temp: false }),
            Value::Object(o) => {
                let path = o.get("path")?.as_str()?.to_string();
                let name = o.get("name").and_then(|v| v.as_str()).map(String::from).unwrap_or_else(|| basename(&path));
                Some(Incoming { path: PathBuf::from(path), name, temp: o.get("temp").and_then(|v| v.as_bool()).unwrap_or(false) })
            }
            _ => None,
        })
        .collect()
}

/// Copies (or, for a dropped file already in the data folder, moves) a file.
fn place(src: &Path, dest: &Path, temp: bool) -> Result<(), String> {
    if temp && fs::rename(src, dest).is_ok() {
        return Ok(());
    }
    fs::copy(src, dest).map(|_| ()).map_err(|e| e.to_string())?;
    if temp {
        remove_file_quiet(src);
    }
    Ok(())
}

fn add_background(p: &Paths, src: &Path, name: &str, temp: bool, n: usize) -> R {
    let ext = extname(name);
    let mut out = format!("{}{}", slugify(&stem(name)), ext);
    if p.backgrounds.join(&out).exists() {
        out = format!("{}-{}{}{}", slugify(&stem(name)), stamp36(), if n > 0 { n.to_string() } else { String::new() }, ext);
    }
    place(src, &p.backgrounds.join(&out), temp)?;
    Ok(json!({ "file": out, "type": kind(&out), "path": p2s(&p.backgrounds.join(&out)) }))
}

// ---- media sets ----
fn media_used_elsewhere(p: &Paths, id: &str) -> HashSet<String> {
    let mut used = HashSet::new();
    for (oid, d) in list_json_dir(&p.announcements) {
        if oid == id {
            continue;
        }
        for i in d.get("images").and_then(|a| a.as_array()).cloned().unwrap_or_default() {
            if let Some(s) = i.as_str() {
                used.insert(s.to_string());
            }
        }
    }
    used
}

fn default_set_title(st: &AppState) -> String {
    let now = chrono::Local::now();
    format!("{} {}", st.t("Об'яви"), now.format("%-d.%-m.%Y"))
}

fn add_media(st: &AppState, items: Vec<Incoming>, existing: Option<&str>, default_title: Option<&str>, from_dialog: bool) -> R {
    let p = &st.paths;
    let stamp = stamp36();
    let mut copied: Vec<String> = Vec::new();
    for (idx, it) in items.iter().enumerate() {
        let ext = extname(&it.name);
        let out = format!("{}-{}-{}{}", slugify(&stem(&it.name)), stamp, idx, ext);
        match place(&it.path, &p.media.join(&out), it.temp) {
            Ok(_) => copied.push(out),
            Err(e) => {
                if from_dialog {
                    return Err(e);
                }
                eprintln!("Skipping dropped media {}: {e}", it.name);
            }
        }
    }
    if copied.is_empty() {
        return Ok(Value::Null);
    }
    if let Some(id) = existing.filter(|s| !s.is_empty()) {
        if let Ok(fp) = json_path(&p.announcements, id) {
            if let Some(mut d) = read_json_safe(&fp) {
                let mut imgs = d.get("images").and_then(|a| a.as_array()).cloned().unwrap_or_default();
                imgs.extend(copied.iter().map(|c| json!(c)));
                d["images"] = json!(imgs);
                write_json_atomic(&fp, &d, true)?;
                return Ok(with_id(id, &d));
            }
        }
    }
    let title = default_title.filter(|s| !s.is_empty()).map(String::from).unwrap_or_else(|| default_set_title(st));
    let id = format!("{}-{}", slugify(&title), stamp);
    let to_save = json!({ "title": title, "images": copied });
    write_json_atomic(&json_path(&p.announcements, &id)?, &to_save, true)?;
    Ok(with_id(&id, &to_save))
}

/// Fingerprint used to skip songs already in the library on re-import.
pub fn song_fingerprint(song: &Value) -> String {
    fn norm(s: &str) -> String {
        s.to_lowercase().split_whitespace().collect::<Vec<_>>().join(" ")
    }
    let text = song
        .get("sections")
        .and_then(|a| a.as_array())
        .cloned()
        .unwrap_or_default()
        .iter()
        .map(|sec| {
            sec.get("slides").and_then(|a| a.as_array()).cloned().unwrap_or_default()
                .iter()
                .map(|s| norm(s.as_str().unwrap_or("")))
                .collect::<Vec<_>>()
                .join("|")
        })
        .collect::<Vec<_>>()
        .join("||");
    format!("{}##{}", norm(str_of(song, "title")), text)
}

pub fn library_fingerprints(p: &Paths) -> HashSet<String> {
    list_json_dir(&p.songs).into_iter().map(|(_, d)| song_fingerprint(&d)).collect()
}

pub fn register_collections(p: &Paths, names: &[String]) {
    let mut list = read_song_collections(p);
    let mut changed = false;
    for n in names {
        if !n.is_empty() && !list.contains(n) {
            list.push(n.clone());
            changed = true;
        }
    }
    if changed {
        let _ = write_json_atomic(&p.song_collections, &list, true);
    }
}
