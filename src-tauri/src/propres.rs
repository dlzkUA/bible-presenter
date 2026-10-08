//! ProPresenter import: songs (.pro, one by one or a whole library folder)
//! and themes (.proTheme). Both are protobuf; the schema is compiled in at
//! build time and messages are decoded generically, then read as JSON.

use crate::dialogs;
use crate::library;
use crate::rtf::rtf_to_text;
use crate::state::AppState;
use crate::store::*;
use base64::Engine;
use once_cell::sync::Lazy;
use prost_reflect::{DescriptorPool, DynamicMessage, SerializeOptions};
use serde_json::{json, Value};
use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};
use tauri::AppHandle;

pub(crate) static POOL: Lazy<DescriptorPool> =
    Lazy::new(|| DescriptorPool::decode(&include_bytes!(concat!(env!("OUT_DIR"), "/propresenter.bin"))[..]).expect("ProPresenter schema"));

fn decode(type_name: &str, bytes: &[u8]) -> Result<Value, String> {
    let desc = POOL.get_message_by_name(type_name).ok_or("schema")?;
    let msg = DynamicMessage::decode(desc, bytes).map_err(|e| format!("PRO_INVALID: {e}"))?;
    let opts = SerializeOptions::new().skip_default_fields(true).stringify_64_bit_integers(true);
    let mut ser = serde_json::Serializer::new(Vec::new());
    msg.serialize_with_options(&mut ser, &opts).map_err(|e| e.to_string())?;
    serde_json::from_slice(&ser.into_inner()).map_err(|e| e.to_string())
}

fn arr(v: &Value, key: &str) -> Vec<Value> {
    v.get(key).and_then(|a| a.as_array()).cloned().unwrap_or_default()
}
fn uuid(v: &Value) -> String {
    v.get("string").and_then(|s| s.as_str()).unwrap_or("").to_string()
}

fn slide_text(cue: &Value) -> String {
    let actions = arr(cue, "actions");
    let action = actions
        .iter()
        .find(|a| a.get("type").and_then(|t| t.as_str()) == Some("ACTION_TYPE_PRESENTATION_SLIDE"))
        .or_else(|| actions.first());
    let Some(action) = action else { return String::new() };
    let elements = action.pointer("/slide/presentation/baseSlide/elements").and_then(|e| e.as_array()).cloned().unwrap_or_default();
    let mut chunks = Vec::new();
    for e in elements {
        let Some(b64) = e.pointer("/element/text/rtfData").and_then(|r| r.as_str()) else { continue };
        let Ok(bytes) = base64::engine::general_purpose::STANDARD.decode(b64) else { continue };
        let text = rtf_to_text(&String::from_utf8_lossy(&bytes));
        if !text.is_empty() {
            chunks.push(text);
        }
    }
    chunks.join("\n")
}

/// One .pro file → { title, sections: [{ name, slides }] }, in the order the
/// song is sung (its arrangement), so a repeated chorus is not lost.
pub fn import_pro_file(path: &Path) -> Result<Value, String> {
    let bytes = fs::read(path).map_err(|e| e.to_string())?;
    let obj = decode("rv.data.Presentation", &bytes)?;
    let mut cues: HashMap<String, Value> = HashMap::new();
    for c in arr(&obj, "cues") {
        let id = c.get("uuid").map(uuid).unwrap_or_default();
        if !id.is_empty() {
            cues.insert(id, c);
        }
    }
    let mut groups: Vec<Value> = Vec::new();
    let mut by_uuid: HashMap<String, usize> = HashMap::new();
    for cg in arr(&obj, "cueGroups") {
        let group = cg.get("group").cloned().unwrap_or(Value::Null);
        let name = group.get("name").and_then(|n| n.as_str()).filter(|s| !s.is_empty()).unwrap_or("Section").to_string();
        let slides: Vec<String> = arr(&cg, "cueIdentifiers")
            .iter()
            .filter_map(|ci| cues.get(&uuid(ci)))
            .map(slide_text)
            .filter(|t| !t.is_empty())
            .collect();
        let gid = group.get("uuid").map(uuid).unwrap_or_default();
        if !gid.is_empty() {
            by_uuid.insert(gid, groups.len());
        }
        groups.push(json!({ "name": name, "slides": slides }));
    }
    let arrangements = arr(&obj, "arrangements");
    let selected = obj.get("selectedArrangement").map(uuid).unwrap_or_default();
    let chosen = arrangements.iter().find(|a| a.get("uuid").map(uuid).as_deref() == Some(selected.as_str()) && !selected.is_empty()).or_else(|| arrangements.first());
    let mut sections: Vec<Value> = Vec::new();
    if let Some(a) = chosen {
        for gi in arr(a, "groupIdentifiers") {
            if let Some(&i) = by_uuid.get(&uuid(&gi)) {
                sections.push(groups[i].clone());
            }
        }
    }
    if sections.is_empty() {
        sections = groups;
    }
    let title = obj.get("name").and_then(|n| n.as_str()).filter(|s| !s.is_empty()).map(String::from).unwrap_or_else(|| stem(&path.to_string_lossy()));
    Ok(json!({ "title": title, "sections": sections }))
}

// ---- themes ----
// Colours are kept as #rrggbb: the theme editor's pickers only take that form.
// A fully transparent colour (media showing through) becomes black.
fn color_to_css(c: Option<&Value>, fallback: &str) -> String {
    let Some(c) = c.filter(|c| c.is_object()) else { return fallback.to_string() };
    let a = c.get("alpha").and_then(|v| v.as_f64()).unwrap_or(1.0);
    if a == 0.0 {
        return "#000000".into();
    }
    let h = |k: &str| {
        let v = c.get(k).and_then(|v| v.as_f64()).unwrap_or(0.0);
        format!("{:02x}", (v * 255.0).round().clamp(0.0, 255.0) as u8)
    };
    format!("#{}{}{}", h("red"), h("green"), h("blue"))
}

pub fn import_pro_theme(path: &Path) -> Result<Value, String> {
    let file = fs::File::open(path).map_err(|e| e.to_string())?;
    let mut zip = zip::ZipArchive::new(file).map_err(|_| "PROTHEME_INVALID: not a zip".to_string())?;
    let name = (0..zip.len())
        .filter_map(|i| zip.by_index(i).ok().map(|f| f.name().to_string()))
        .find(|n| n.ends_with("/Theme") || n == "Theme")
        .ok_or("PROTHEME_INVALID: theme entry not found")?;
    let mut buf = Vec::new();
    {
        use std::io::Read;
        zip.by_name(&name).map_err(|e| e.to_string())?.read_to_end(&mut buf).map_err(|e| e.to_string())?;
    }
    let obj = decode("rv.data.Template.Document", &buf)?;
    let slide = arr(&obj, "slides").into_iter().next().ok_or("PROTHEME_INVALID: no slides")?;
    let base = slide.get("baseSlide").cloned().unwrap_or(Value::Null);
    let text_el = arr(&base, "elements").into_iter().filter_map(|e| e.get("element").cloned()).find(|el| el.get("text").is_some());
    let mut theme = json!({
        "name": slide.get("name").and_then(|n| n.as_str()).filter(|s| !s.is_empty()).map(String::from).unwrap_or_else(|| stem(&path.to_string_lossy())),
        "fontFamily": "Georgia", "fontSize": 80, "color": "#ffffff", "uppercase": false, "bold": false,
        "align": "center", "valign": "center", "background": color_to_css(base.get("backgroundColor"), "#ffffff"),
        "letterSpacing": 0, "lineHeight": 1.3, "lineGap": 0, "italic": false, "shadow": true,
    });
    if let Some(el) = text_el {
        let text = &el["text"];
        let attrs = text.get("attributes").cloned().unwrap_or(json!({}));
        if let Some(font) = attrs.get("font") {
            // `family` is the display name CSS matches; `name` the PostScript one.
            let fam = font.get("family").and_then(|v| v.as_str()).filter(|s| !s.is_empty()).or_else(|| font.get("name").and_then(|v| v.as_str()));
            if let Some(f) = fam {
                theme["fontFamily"] = json!(f);
            }
            if let Some(sz) = font.get("size").and_then(|v| v.as_f64()).filter(|v| *v != 0.0) {
                theme["fontSize"] = json!(sz);
            }
            let face = font.get("face").and_then(|v| v.as_str()).filter(|s| !s.is_empty()).or_else(|| font.get("name").and_then(|v| v.as_str())).unwrap_or("").to_lowercase();
            if ["bold", "black", "heavy", "semibold", "demibold"].iter().any(|w| face.contains(w)) {
                theme["bold"] = json!(true);
            }
            if face.contains("italic") || face.contains("oblique") {
                theme["italic"] = json!(true);
            }
        }
        if attrs.get("textSolidFill").is_some() {
            theme["color"] = json!(color_to_css(attrs.get("textSolidFill"), "#ffffff"));
        }
        if attrs.get("capitalization").and_then(|v| v.as_str()) == Some("CAPITALIZATION_ALL_CAPS") {
            theme["uppercase"] = json!(true);
        }
        // Protobuf leaves out values equal to the first entry of a list
        // (LEFT, TOP): a missing alignment is "left", a missing vertical
        // alignment "top" — not "centre", as the earlier importer assumed.
        let ps = attrs.get("paragraphStyle").cloned().unwrap_or(json!({}));
        if attrs.get("paragraphStyle").is_some() {
            let a = ps.get("alignment").and_then(|v| v.as_str()).unwrap_or("ALIGNMENT_LEFT");
            theme["align"] = json!(match a { "ALIGNMENT_RIGHT" => "right", "ALIGNMENT_CENTER" => "center", _ => "left" });
        }
        if let Some(m) = ps.get("lineHeightMultiple").and_then(|v| v.as_f64()).filter(|v| *v != 0.0) {
            theme["lineHeight"] = json!(m);
        }
        if let Some(s) = ps.get("lineSpacing").and_then(|v| v.as_f64()).filter(|v| *v != 0.0) {
            theme["lineGap"] = json!(s / 100.0);
        }
        // Kerning is in points at the theme's size; stored relative to the size.
        if let Some(k) = attrs.get("kerning").and_then(|v| v.as_f64()).filter(|v| *v != 0.0 && v.is_finite()) {
            let size = theme["fontSize"].as_f64().unwrap_or(0.0);
            if size != 0.0 {
                theme["letterSpacing"] = json!(((k / size) * 1000.0).round() / 1000.0);
            }
        }
        if attrs.get("strokeColor").is_some() {
            if let Some(w) = attrs.get("strokeWidth").and_then(|v| v.as_f64()).filter(|v| *v != 0.0) {
                theme["outline"] = json!(true);
                theme["outlineColor"] = json!(color_to_css(attrs.get("strokeColor"), "#ffffff"));
                theme["outlineWidth"] = json!(w.abs());
            }
        }
        if el.pointer("/shadow/color").and_then(|c| c.as_object()).map(|o| !o.is_empty()).unwrap_or(false) {
            theme["shadow"] = json!(true);
        }
        let v = text.get("verticalAlignment").and_then(|v| v.as_str()).unwrap_or("VERTICAL_ALIGNMENT_TOP");
        theme["valign"] = json!(match v { "VERTICAL_ALIGNMENT_TOP" => "flex-start", "VERTICAL_ALIGNMENT_BOTTOM" => "flex-end", _ => "center" });
    }
    Ok(theme)
}

// ---- handlers ----
type R = Result<Value, String>;

pub fn handle(app: &AppHandle, st: &AppState, ch: &str, _arg: &Value) -> Option<R> {
    Some(match ch {
        "songs:importPro" => import_songs(app, st),
        "songs:importProLibrary" => import_library(app, st),
        "themes:importProTheme" => match dialogs::pick_file(app, &st.t("Імпорт теми ProPresenter (.proTheme)"), &[("ProPresenter Theme", &["proTheme"])]) {
            None => Ok(Value::Null),
            Some(fp) => import_pro_theme(&fp).and_then(|t| library::save_new_theme(&st.paths, &t)),
        },
        _ => return None,
    })
}

fn with_id(id: &str, v: &Value) -> Value {
    let mut out = json!({ "id": id });
    for (k, x) in v.as_object().cloned().unwrap_or_default() {
        out[k] = x;
    }
    out
}

/// A song already in the library (same title, same words) is not imported a
/// second time, so re-importing a library after adding a few songs is safe.
fn import_songs(app: &AppHandle, st: &AppState) -> R {
    let p = &st.paths;
    let files = dialogs::pick_files(app, &st.t("Імпорт пісні з ProPresenter (.pro)"), &[("ProPresenter Song", &["pro"])]);
    if files.is_empty() {
        return Ok(Value::Null);
    }
    let mut have = library::library_fingerprints(p);
    let mut imported: Vec<Value> = Vec::new();
    let (mut failed, mut skipped) = (0, 0);
    let mut existing: Option<Value> = None;
    for f in files {
        match import_pro_file(&f) {
            Ok(song) => {
                let fp = library::song_fingerprint(&song);
                if have.contains(&fp) {
                    skipped += 1;
                    if existing.is_none() {
                        existing = list_json_dir(&p.songs).into_iter().find(|(_, d)| library::song_fingerprint(d) == fp).map(|(id, d)| with_id(&id, &d));
                    }
                    continue;
                }
                have.insert(fp);
                let id = format!("{}-{}-{}", slugify(str_of(&song, "title")), stamp36(), imported.len());
                match json_path(&p.songs, &id).and_then(|path| write_json_atomic(&path, &song, true)) {
                    Ok(_) => imported.push(with_id(&id, &song)),
                    Err(_) => failed += 1,
                }
            }
            Err(e) => {
                eprintln!("Failed to import {}: {e}", f.display());
                failed += 1;
            }
        }
    }
    if imported.len() == 1 && failed == 0 && skipped == 0 {
        return Ok(imported.remove(0));
    }
    let first = imported.first().cloned().or(existing).unwrap_or(Value::Null);
    Ok(json!({ "batch": true, "count": imported.len(), "first": first, "failed": failed, "skipped": skipped }))
}

/// A whole ProPresenter library folder; the folder a song sits in becomes its
/// collection, so the library's structure is kept.
fn import_library(app: &AppHandle, st: &AppState) -> R {
    let p = &st.paths;
    let Some(root) = dialogs::pick_folder(app, &st.t("Оберіть теку бібліотеки ProPresenter")) else { return Ok(Value::Null) };
    let root_name = basename(&root.to_string_lossy());
    let mut files: Vec<(PathBuf, String)> = Vec::new();
    fn walk(dir: &Path, root_name: &str, out: &mut Vec<(PathBuf, String)>) {
        let Ok(rd) = fs::read_dir(dir) else { return };
        let mut entries: Vec<_> = rd.filter_map(|e| e.ok()).collect();
        entries.sort_by_key(|e| e.file_name());
        for e in entries {
            let path = e.path();
            if path.is_dir() {
                walk(&path, root_name, out);
            } else if path.extension().map(|x| x.to_string_lossy().eq_ignore_ascii_case("pro")).unwrap_or(false) {
                let parent = path.parent().map(|d| basename(&d.to_string_lossy())).unwrap_or_default();
                let coll = if parent == root_name { root_name.to_string() } else { parent };
                out.push((path, coll));
            }
        }
    }
    walk(&root, &root_name, &mut files);
    let mut have = library::library_fingerprints(p);
    let (mut ok, mut failed, mut skipped) = (0, 0, 0);
    let mut seen: Vec<String> = Vec::new();
    for (i, (f, coll)) in files.iter().enumerate() {
        match import_pro_file(f) {
            Ok(mut song) => {
                song["collection"] = json!(coll);
                let fp = library::song_fingerprint(&song);
                if !coll.is_empty() && !seen.contains(coll) {
                    seen.push(coll.clone());
                }
                if have.contains(&fp) {
                    skipped += 1;
                    continue;
                }
                have.insert(fp);
                let id = format!("{}-{}-{}", slugify(str_of(&song, "title")), stamp36(), i);
                if json_path(&p.songs, &id).and_then(|path| write_json_atomic(&path, &song, true)).is_ok() {
                    ok += 1;
                } else {
                    failed += 1;
                }
            }
            Err(e) => {
                eprintln!("Failed to import {}: {e}", f.display());
                failed += 1;
            }
        }
    }
    library::register_collections(p, &seen);
    Ok(json!({ "count": ok, "failed": failed, "skipped": skipped, "total": files.len(), "collections": seen }))
}
