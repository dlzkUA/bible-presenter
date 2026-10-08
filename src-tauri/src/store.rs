//! Where the data lives, and the small helpers every part of the app uses to
//! read and write it safely.

use serde::Serialize;
use serde_json::Value;
use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

/// All data folders. The root is the same folder the 2.x (Electron) versions
/// used — `%APPDATA%\BiblePresenter` on Windows,
/// `~/Library/Application Support/BiblePresenter` on macOS — so songs,
/// translations and playlists carry straight over.
#[derive(Clone, Debug)]
pub struct Paths {
    pub root: PathBuf,
    pub songs: PathBuf,
    pub themes: PathBuf,
    pub stream_themes: PathBuf,
    pub song_collections: PathBuf,
    pub backgrounds: PathBuf,
    pub presentations: PathBuf,
    pub announcements: PathBuf,
    pub media: PathBuf,
    pub playlists: PathBuf,
    pub bibles: PathBuf,
    pub user_catalog: PathBuf,
    pub uploads: PathBuf,
    pub remote: PathBuf,
}

impl Paths {
    pub fn new() -> Paths {
        let base = std::env::var_os("BP_DATA_DIR")
            .map(PathBuf::from)
            .unwrap_or_else(|| dirs::config_dir().unwrap_or_else(|| PathBuf::from(".")).join("BiblePresenter"));
        Paths::at(base)
    }

    pub fn at(root: PathBuf) -> Paths {
        let p = Paths {
            songs: root.join("songs"),
            themes: root.join("themes"),
            stream_themes: root.join("stream-themes"),
            song_collections: root.join("song-collections.json"),
            backgrounds: root.join("backgrounds"),
            presentations: root.join("presentations"),
            announcements: root.join("announcements"),
            media: root.join("media"),
            playlists: root.join("playlists"),
            bibles: root.join("bibles"),
            user_catalog: root.join("bible-catalog.json"),
            uploads: root.join(".incoming"),
            remote: root.join("remote.json"),
            root,
        };
        for d in [&p.songs, &p.themes, &p.stream_themes, &p.backgrounds, &p.presentations,
                  &p.announcements, &p.media, &p.playlists, &p.bibles] {
            let _ = fs::create_dir_all(d);
        }
        // Leftovers of an interrupted drop from the previous session.
        let _ = fs::remove_dir_all(&p.uploads);
        p
    }
}

/// Ids name files inside the data folders. They come from the interface and
/// from imported files (a playlist made elsewhere), so they are checked: an id
/// like "../../something" must never reach outside its folder.
pub fn safe_id(id: &str) -> Result<&str, String> {
    let ok = !id.is_empty()
        && id.chars().count() <= 160
        && id != "."
        && id != ".."
        && id.chars().all(|c| c.is_alphanumeric() || c == '_' || c == '.' || c == '-');
    // JavaScript's \w is ASCII-only; keep the same rule.
    if ok && id.is_ascii() { Ok(id) } else { Err("BAD_ID".into()) }
}

pub fn is_safe_id(id: &str) -> bool {
    safe_id(id).is_ok()
}

pub fn json_path(dir: &Path, id: &str) -> Result<PathBuf, String> {
    Ok(dir.join(format!("{}.json", safe_id(id)?)))
}

/// Every data file is written to a temp file first and then renamed over the
/// old one, so a crash or power cut mid-write can't leave a half-written file.
pub fn write_json_atomic<T: Serialize + ?Sized>(fp: &Path, data: &T, pretty: bool) -> Result<(), String> {
    let text = if pretty { serde_json::to_string_pretty(data) } else { serde_json::to_string(data) }
        .map_err(|e| e.to_string())?;
    let mut tmp = fp.as_os_str().to_owned();
    tmp.push(".tmp");
    let tmp = PathBuf::from(tmp);
    {
        let mut f = fs::File::create(&tmp).map_err(|e| e.to_string())?;
        f.write_all(text.as_bytes()).map_err(|e| e.to_string())?;
        let _ = f.sync_all();
    }
    fs::rename(&tmp, fp).map_err(|e| e.to_string())
}

/// Writes a user-chosen export file (pretty JSON, no atomic rename needed).
pub fn write_json_pretty(fp: &Path, data: &Value) -> Result<(), String> {
    let text = serde_json::to_string_pretty(data).map_err(|e| e.to_string())?;
    fs::write(fp, text).map_err(|e| e.to_string())
}

/// Reads a single JSON file, returning None on missing or corrupt rather than
/// failing.
pub fn read_json_safe(fp: &Path) -> Option<Value> {
    let text = fs::read_to_string(fp).ok()?;
    match serde_json::from_str::<Value>(strip_bom(&text)) {
        Ok(v) => Some(v),
        Err(e) => {
            eprintln!("Could not read JSON {}: {}", fp.display(), e);
            None
        }
    }
}

pub fn strip_bom(s: &str) -> &str {
    s.strip_prefix('\u{feff}').unwrap_or(s)
}

/// Reads every .json in a directory. A single corrupt or half-written file is
/// skipped instead of failing, so one bad song can't empty the whole list.
pub fn list_json_dir(dir: &Path) -> Vec<(String, Value)> {
    let mut out = Vec::new();
    let Ok(rd) = fs::read_dir(dir) else { return out };
    let mut names: Vec<String> = rd
        .filter_map(|e| e.ok())
        .filter_map(|e| e.file_name().into_string().ok())
        .filter(|n| n.ends_with(".json"))
        .collect();
    names.sort();
    for n in names {
        if let Some(v) = read_json_safe(&dir.join(&n)) {
            out.push((n.trim_end_matches(".json").to_string(), v));
        }
    }
    out
}

pub fn now_ms() -> u128 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_millis()).unwrap_or(0)
}

/// Date.now().toString(36) — the time stamp used in generated ids and file
/// names, kept identical so names look the same as before.
pub fn stamp36() -> String {
    to_base36(now_ms())
}

pub fn to_base36(mut n: u128) -> String {
    const DIGITS: &[u8] = b"0123456789abcdefghijklmnopqrstuvwxyz";
    if n == 0 {
        return "0".into();
    }
    let mut out = Vec::new();
    while n > 0 {
        out.push(DIGITS[(n % 36) as usize]);
        n /= 36;
    }
    out.reverse();
    String::from_utf8(out).unwrap()
}

/// Transliterate Cyrillic → Latin so generated file names are pure ASCII.
/// Windows can store a Cyrillic file name in one Unicode form and return it in
/// another, making the file appear to vanish on restart.
pub fn translit(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for ch in s.chars() {
        let lower: String = ch.to_lowercase().collect();
        let mapped = match lower.as_str() {
            "а" => Some("a"), "б" => Some("b"), "в" => Some("v"), "г" => Some("h"), "ґ" => Some("g"),
            "д" => Some("d"), "е" => Some("e"), "є" => Some("ie"), "ж" => Some("zh"), "з" => Some("z"),
            "и" => Some("y"), "і" => Some("i"), "ї" => Some("i"), "й" => Some("i"), "к" => Some("k"),
            "л" => Some("l"), "м" => Some("m"), "н" => Some("n"), "о" => Some("o"), "п" => Some("p"),
            "р" => Some("r"), "с" => Some("s"), "т" => Some("t"), "у" => Some("u"), "ф" => Some("f"),
            "х" => Some("kh"), "ц" => Some("ts"), "ч" => Some("ch"), "ш" => Some("sh"), "щ" => Some("shch"),
            "ь" => Some(""), "ю" => Some("iu"), "я" => Some("ia"), "ы" => Some("y"), "э" => Some("e"),
            "ё" => Some("e"), "ъ" => Some(""),
            _ => None,
        };
        match mapped {
            Some(m) => {
                if lower == ch.to_string() {
                    out.push_str(m);
                } else {
                    let mut cs = m.chars();
                    if let Some(f) = cs.next() {
                        out.extend(f.to_uppercase());
                        out.push_str(cs.as_str());
                    }
                }
            }
            None => out.push(ch),
        }
    }
    out
}

pub fn slugify(s: &str) -> String {
    let ascii = translit(s).to_lowercase();
    let mut slug = String::new();
    let mut dash = false;
    for c in ascii.chars() {
        if c.is_ascii_lowercase() || c.is_ascii_digit() {
            if dash && !slug.is_empty() {
                slug.push('-');
            }
            dash = false;
            slug.push(c);
        } else {
            dash = true;
        }
    }
    let slug: String = slug.chars().take(60).collect();
    let slug = slug.trim_end_matches('-').to_string();
    if slug.is_empty() { "item".into() } else { slug }
}

/// Characters Windows does not allow in file names, for suggested export names.
pub fn safe_file_name(s: &str) -> String {
    let mut out = String::new();
    let mut last_bad = false;
    for c in s.chars() {
        if "\\/:*?\"<>|".contains(c) {
            if !last_bad {
                out.push('_');
            }
            last_bad = true;
        } else {
            out.push(c);
            last_bad = false;
        }
    }
    out
}

/// Extension with the dot, as Node's path.extname: "a.b.mp4" → ".mp4".
pub fn extname(name: &str) -> String {
    let base = basename(name);
    match base.rfind('.') {
        Some(i) if i > 0 => base[i..].to_string(),
        _ => String::new(),
    }
}

/// Last path component, accepting both separators.
pub fn basename(p: &str) -> String {
    p.rsplit(['/', '\\']).next().unwrap_or(p).to_string()
}

/// File name without its extension.
pub fn stem(p: &str) -> String {
    let b = basename(p);
    let e = extname(&b);
    b[..b.len() - e.len()].to_string()
}

pub fn str_of<'a>(v: &'a Value, key: &str) -> &'a str {
    v.get(key).and_then(|x| x.as_str()).unwrap_or("")
}

pub fn random_hex(bytes: usize) -> String {
    let mut buf = vec![0u8; bytes];
    let _ = getrandom::fill(&mut buf);
    hex::encode(buf)
}

pub fn remove_file_quiet(p: &Path) {
    let _ = fs::remove_file(p);
}

#[cfg(test)]
mod tests {
    use super::*;
    // Ids end up in file paths and in the phone remote's URLs: this is the
    // guard against "../" reaching outside the data folder.
    #[test]
    fn ids_cannot_leave_the_data_folder() {
        assert!(is_safe_id("amazing-grace-mabc1"));
        for bad in ["../x", "..", "a/b", "a\\b", "пісня", ""] {
            assert!(!is_safe_id(bad), "{bad}");
        }
    }
}
