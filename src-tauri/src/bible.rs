//! Bible translations: listing, reading, searching, the online catalogue and
//! importing Zefania / OSIS / <bible><book number> XML.

use crate::dialogs;
use crate::state::AppState;
use crate::store::*;
use once_cell::sync::Lazy;
use regex::{Regex, RegexBuilder};
use serde::{Deserialize, Deserializer, Serialize};
use serde_json::{json, Map, Value};
use sha1::{Digest, Sha1};
use std::collections::{HashMap, HashSet};
use std::fs;
use std::path::Path;
use std::sync::Arc;
use tauri::AppHandle;

const RAW_BASE: &str = "https://raw.githubusercontent.com/Beblia/Holy-Bible-XML-Format/master/";
const BUNDLED_CATALOG: &str = include_str!("../data/bible-catalog.json");
const CANON_JSON: &str = include_str!("../data/canonical-books.json");

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct Book {
    #[serde(rename = "canonicalId")]
    pub canonical_id: u32,
    pub osis: String,
    #[serde(default)]
    pub name: String,
    #[serde(deserialize_with = "de_chapters")]
    pub chapters: Vec<Vec<String>>,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct Translation {
    pub id: String,
    #[serde(default)]
    pub name: String,
    pub books: Map<String, Value>,
    #[serde(rename = "hasOwnNames", default)]
    pub has_own_names: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub language: Option<String>,
    #[serde(rename = "sourceFile", default, skip_serializing_if = "Option::is_none")]
    pub source_file: Option<String>,
    #[serde(flatten)]
    pub extra: Map<String, Value>,
    /// Parsed books, sorted in canonical order (not stored).
    #[serde(skip)]
    pub parsed: Vec<Book>,
}

// Older files can hold nulls where a verse or chapter was missing.
fn de_chapters<'de, D: Deserializer<'de>>(d: D) -> Result<Vec<Vec<String>>, D::Error> {
    let raw: Vec<Option<Vec<Option<String>>>> = Deserialize::deserialize(d)?;
    Ok(raw.into_iter().map(|c| c.unwrap_or_default().into_iter().map(|v| v.unwrap_or_default()).collect()).collect())
}

impl Translation {
    fn book(&self, osis: &str) -> Option<&Book> {
        self.parsed.iter().find(|b| b.osis == osis)
    }
}

type R = Result<Value, String>;

// ---------------------------------------------------------------- canon
struct Canon {
    osis: Vec<String>,
    names: HashMap<String, Vec<String>>,
}
static CANON: Lazy<Canon> = Lazy::new(|| {
    let v: Value = serde_json::from_str(CANON_JSON).expect("canonical books");
    let osis = v["osis"].as_array().unwrap().iter().map(|x| x.as_str().unwrap().to_string()).collect();
    let names = v["names"]
        .as_object()
        .unwrap()
        .iter()
        .map(|(k, s)| (k.clone(), s.as_str().unwrap().split(',').map(|x| x.trim().to_string()).collect()))
        .collect();
    Canon { osis, names }
});

pub struct CanonBook {
    pub osis: String,
    pub canonical_id: u32,
    pub name: String,
}

pub fn canonical_books(lang: &str) -> Vec<CanonBook> {
    let en = &CANON.names["en"];
    let names = CANON.names.get(lang).unwrap_or(en);
    CANON
        .osis
        .iter()
        .enumerate()
        .map(|(i, o)| CanonBook {
            osis: o.clone(),
            canonical_id: i as u32 + 1,
            name: names.get(i).filter(|s| !s.is_empty()).unwrap_or(&en[i]).clone(),
        })
        .collect()
}

// ---------------------------------------------------------------- loading
#[derive(Deserialize)]
struct Head {
    id: Option<String>,
    name: Option<Value>,
    books: Option<HashMap<String, serde::de::IgnoredAny>>,
    #[serde(rename = "sourceFile")]
    source_file: Option<String>,
}

/// Only imported translations: the app ships without Bible text.
pub fn list_translations(p: &Paths) -> Vec<Value> {
    let mut out = Vec::new();
    let Ok(rd) = fs::read_dir(&p.bibles) else { return out };
    let mut files: Vec<_> = rd.filter_map(|e| e.ok()).map(|e| e.path()).filter(|f| f.extension().map(|x| x == "json").unwrap_or(false)).collect();
    files.sort();
    for f in files {
        let Ok(text) = fs::read_to_string(&f) else { continue };
        // Only the head of the file is decoded; the verses are skipped.
        let Ok(h) = serde_json::from_str::<Head>(strip_bom(&text)) else { continue };
        let (Some(id), Some(books)) = (h.id, h.books) else { continue };
        if id.is_empty() {
            continue;
        }
        out.push(json!({ "id": id, "name": h.name.unwrap_or(Value::Null), "books": books.len(), "user": true, "sourceFile": h.source_file }));
    }
    out
}

pub fn load_translation(st: &AppState, id: &str) -> Result<Arc<Translation>, String> {
    if let Some(t) = st.bible_cache.lock().get(id) {
        return Ok(t.clone());
    }
    let fp = json_path(&st.paths.bibles, id)?;
    let text = fs::read_to_string(&fp).map_err(|e| format!("ENOENT: {e}"))?;
    let mut t: Translation = serde_json::from_str(strip_bom(&text)).map_err(|e| format!("JSON.parse: {e}"))?;
    let mut books: Vec<Book> = t.books.values().filter_map(|b| serde_json::from_value(b.clone()).ok()).collect();
    books.sort_by_key(|b| b.canonical_id);
    t.parsed = books;
    t.books = Map::new(); // the parsed copy is all that is needed from here on
    let t = Arc::new(t);
    st.bible_cache.lock().insert(id.to_string(), t.clone());
    Ok(t)
}

fn forget(st: &AppState, id: &str) {
    st.bible_cache.lock().remove(id);
    st.name_lang_cache.lock().remove(id);
}

// ---------------------------------------------------------------- book names
// Book names follow the language of the translation, not the interface.
fn catalog_lang_code(lang: &str) -> Option<&'static str> {
    Some(match lang.to_lowercase().as_str() {
        "english" => "en", "ukrainian" => "uk", "russian" => "ru", "spanish" => "es", "portuguese" => "pt",
        "french" => "fr", "german" => "de", "polish" => "pl", "czech" => "cs", "slovakian" | "slovak" => "sk",
        "romanian" => "ro", "bulgarian" => "bg", "serbian" => "sr", "croatian" => "hr", "hungarian" => "hu",
        "italian" => "it", "dutch" => "nl", "swedish" => "sv", "danish" => "da", "norwegian" => "nb",
        "finnish" => "fi", "estonian" => "et", "latvian" => "lv", "lithuanian" => "lt", "greek" => "el",
        "turkish" => "tr", "indonesian" => "id",
        _ => return None,
    })
}

fn catalog_value(p: &Paths) -> Value {
    if p.user_catalog.exists() {
        if let Some(v) = read_json_safe(&p.user_catalog) {
            return v;
        }
    }
    serde_json::from_str(BUNDLED_CATALOG).unwrap_or(json!({ "items": [] }))
}

fn translation_name_lang(st: &AppState, t: &Translation) -> Option<String> {
    if let Some(c) = st.name_lang_cache.lock().get(&t.id) {
        return c.clone();
    }
    let mut code: Option<String> = t.language.as_deref().and_then(catalog_lang_code).map(String::from);
    if code.is_none() {
        if let Some(sf) = &t.source_file {
            // Downloaded before the language was stored: look it up.
            let cat = catalog_value(&st.paths);
            if let Some(item) = cat["items"].as_array().and_then(|a| a.iter().find(|i| str_of(i, "file") == sf)) {
                let first = str_of(item, "lang").split_whitespace().next().unwrap_or("");
                code = catalog_lang_code(first).map(String::from);
            }
        }
    }
    if code.is_none() {
        code = detect_text_lang(t).map(String::from);
    }
    st.name_lang_cache.lock().insert(t.id.clone(), code.clone());
    code
}

static RE_GREEK: Lazy<Regex> = Lazy::new(|| Regex::new(r"[\x{0370}-\x{03ff}\x{1f00}-\x{1fff}]").unwrap());
static RE_CYR: Lazy<Regex> = Lazy::new(|| Regex::new(r"[а-яё]").unwrap());
static RE_OTHER_SCRIPT: Lazy<Regex> =
    Lazy::new(|| Regex::new(r#"[^\x{0000}-\x{024f}\s\d.,;:!?'"()\-–—«»„“”’]"#).unwrap());
static RE_LATIN_EXT: Lazy<Regex> = Lazy::new(|| Regex::new(r"[\x{1e00}-\x{1eff}]").unwrap());

/// For translations imported from a file: guess the language from the text of
/// Genesis and John. None when it is not one we have book names for.
pub fn detect_text_lang(t: &Translation) -> Option<&'static str> {
    let books = &t.parsed;
    let pick: Vec<&Book> = books.iter().take(3).chain(books.iter().skip(42).take(2)).collect();
    let sample = pick
        .iter()
        .map(|b| b.chapters.first().map(|c| c.iter().take(8).cloned().collect::<Vec<_>>().join(" ")).unwrap_or_default())
        .collect::<Vec<_>>()
        .join(" ")
        .to_lowercase();
    if RE_GREEK.is_match(&sample) {
        return Some("el");
    }
    if RE_CYR.is_match(&sample) {
        if sample.contains(['і', 'ї', 'є', 'ґ']) {
            return Some("uk");
        }
        if sample.contains(['ј', 'љ', 'њ', 'ћ', 'ђ', 'џ']) {
            return Some("sr");
        }
        if sample.contains(['ы', 'э']) {
            return Some("ru");
        }
        return Some(if sample.matches('ъ').count() > 5 { "bg" } else { "ru" });
    }
    if RE_OTHER_SCRIPT.is_match(&RE_LATIN_EXT.replace_all(&sample, "")) {
        return None;
    }
    let tokens: Vec<&str> = sample.split(|c: char| c.is_whitespace() || ",.;:".contains(c)).filter(|s| !s.is_empty()).collect();
    let score = |words: &[&str]| tokens.iter().filter(|t| words.contains(t)).count();
    let cand: [(&str, &[&str]); 22] = [
        ("en", &["the", "and", "of", "god", "that"]),
        ("es", &["el", "y", "dios", "de", "que", "los"]),
        ("pt", &["o", "e", "deus", "do", "da", "não"]),
        ("fr", &["le", "et", "dieu", "de", "les", "est"]),
        ("de", &["und", "der", "die", "gott", "das"]),
        ("it", &["e", "il", "di", "dio", "che", "la"]),
        ("pl", &["i", "w", "bóg", "się", "nie", "na"]),
        ("cs", &["a", "bůh", "se", "na", "je", "v"]),
        ("sk", &["a", "boh", "sa", "na", "je", "v"]),
        ("ro", &["și", "dumnezeu", "în", "a", "de", "pe"]),
        ("hr", &["i", "bog", "je", "se", "u", "na"]),
        ("hu", &["és", "isten", "a", "az", "hogy"]),
        ("nl", &["en", "de", "god", "het", "van"]),
        ("sv", &["och", "gud", "i", "att", "som"]),
        ("da", &["og", "gud", "i", "at", "som"]),
        ("nb", &["og", "gud", "i", "at", "som", "jeg"]),
        ("fi", &["ja", "jumala", "on", "se", "hän"]),
        ("et", &["ja", "jumal", "on", "see", "ta"]),
        ("lv", &["un", "dievs", "ir", "tas", "uz"]),
        ("lt", &["ir", "dievas", "yra", "jis", "į"]),
        ("tr", &["ve", "tanrı", "bir", "bu", "için"]),
        ("id", &["dan", "allah", "itu", "yang", "tuhan"]),
    ];
    let mut best = None;
    let mut top = 2; // a few hits are needed before a guess is trusted
    for (code, words) in cand {
        let v = score(words);
        if v > top {
            top = v;
            best = Some(code);
        }
    }
    best
}

fn local_book_name(st: &AppState, t: &Translation, b: &Book) -> String {
    if t.has_own_names {
        return b.name.clone();
    }
    match translation_name_lang(st, t) {
        None => b.name.clone(),
        Some(code) => canonical_books(&code)
            .get(b.canonical_id as usize - 1)
            .map(|c| c.name.clone())
            .unwrap_or_else(|| b.name.clone()),
    }
}

// ---------------------------------------------------------------- handlers
pub fn handle(app: &AppHandle, st: &AppState, ch: &str, arg: &Value) -> Option<R> {
    let p = &st.paths;
    let r = match ch {
        "bible:listTranslations" => Ok(json!(list_translations(p))),
        "bible:getVerse" => (|| {
            let t = load_translation(st, str_of(arg, "translationId"))?;
            let Some(b) = t.book(str_of(arg, "osis")) else { return Ok(Value::Null) };
            let c = arg["chapter"].as_u64().unwrap_or(0) as usize;
            let v = arg["verse"].as_u64().unwrap_or(0) as usize;
            if c == 0 || v == 0 {
                return Ok(Value::Null);
            }
            let Some(text) = b.chapters.get(c - 1).and_then(|ch| ch.get(v - 1)) else { return Ok(Value::Null) };
            Ok(json!({ "translationName": t.name, "bookName": local_book_name(st, &t, b), "chapter": c, "verse": v, "text": text }))
        })(),
        "bible:searchText" => search(st, arg),
        "bible:getBookList" => load_translation(st, str_of(arg, "translationId")).map(|t| {
            json!(t.parsed.iter().map(|b| json!({ "osis": b.osis, "name": local_book_name(st, &t, b), "chapterCount": b.chapters.len() })).collect::<Vec<_>>())
        }),
        "bible:getChapterVerseCount" => load_translation(st, str_of(arg, "translationId")).map(|t| {
            let c = arg["chapter"].as_u64().unwrap_or(0) as usize;
            json!(t.book(str_of(arg, "osis")).and_then(|b| if c == 0 { None } else { b.chapters.get(c - 1) }).map(|ch| ch.len()).unwrap_or(0))
        }),
        "bible:catalog" => {
            let mut data = catalog_value(p);
            let installed: HashSet<String> = list_translations(p).iter().filter_map(|t| t["sourceFile"].as_str().map(String::from)).collect();
            if let Some(items) = data.get_mut("items").and_then(|i| i.as_array_mut()) {
                for i in items.iter_mut() {
                    let f = str_of(i, "file").to_string();
                    i["installed"] = json!(installed.contains(&f));
                }
            } else {
                data["items"] = json!([]);
            }
            Ok(data)
        }
        "bible:refreshCatalog" => refresh_catalog(p),
        "bible:download" => download(st, arg),
        "bible:importXml" => match dialogs::pick_file(app, &st.t("Імпорт перекладу Біблії (XML)"), &[("Bible XML", &["xml"])]) {
            None => Ok(Value::Null),
            Some(fp) => import_bible_xml(&fp, &canonical_books(arg.as_str().unwrap_or("en")), &p.bibles, None).map(|info| {
                forget(st, str_of(&info, "id"));
                info
            }),
        },
        _ => return None,
    };
    Some(r)
}

fn search_norm(s: &str) -> String {
    s.to_lowercase().replace(['\u{2018}', '\u{2019}', '\u{02BC}'], "'").replace('\u{0301}', "")
}

// Full-text search: most of the time the operator remembers a phrase, not
// where the verse is.
pub(crate) fn search(st: &AppState, arg: &Value) -> R {
    let q = str_of(arg, "query").trim().to_lowercase();
    if q.chars().count() < 2 {
        return Ok(json!([]));
    }
    let t = load_translation(st, str_of(arg, "translationId"))?;
    let cap = arg["limit"].as_u64().filter(|n| *n > 0).unwrap_or(200).clamp(1, 500) as usize;
    let needle = search_norm(&q);
    let mut out = Vec::new();
    for b in &t.parsed {
        let name = local_book_name(st, &t, b);
        for (c, ch) in b.chapters.iter().enumerate() {
            for (v, text) in ch.iter().enumerate() {
                if !text.is_empty() && search_norm(text).contains(&needle) {
                    out.push(json!({ "osis": b.osis, "bookName": name, "chapter": c + 1, "verse": v + 1, "text": text }));
                    if out.len() >= cap {
                        return Ok(json!(out));
                    }
                }
            }
        }
    }
    Ok(json!(out))
}

fn http_get(url: &str) -> Result<Vec<u8>, String> {
    let client = reqwest::blocking::Client::builder()
        .user_agent("BiblePresenter")
        .timeout(std::time::Duration::from_secs(45))
        .build()
        .map_err(|e| e.to_string())?;
    let res = client.get(url).send().map_err(|e| format!("net::ERR {e}"))?;
    if !res.status().is_success() {
        return Err(format!("HTTP {}", res.status().as_u16()));
    }
    res.bytes().map(|b| b.to_vec()).map_err(|e| format!("net::ERR {e}"))
}

/// Splits "EnglishKJV1611" the way the catalogue names its files:
/// "English", "KJV", "1611" (same rules as the earlier JavaScript version).
fn name_tokens(base: &str) -> Vec<String> {
    let c: Vec<char> = base.chars().collect();
    let mut out = Vec::new();
    let mut i = 0;
    while i < c.len() {
        if c[i].is_ascii_digit() {
            let s = i;
            while i < c.len() && c[i].is_ascii_digit() {
                i += 1;
            }
            out.push(c[s..i].iter().collect());
        } else if c[i].is_ascii_uppercase() {
            let s = i;
            let mut j = i;
            while j < c.len() && c[j].is_ascii_uppercase() {
                j += 1;
            }
            let run = j - s;
            let next_lower = j < c.len() && c[j].is_ascii_lowercase();
            if run == 1 {
                if next_lower {
                    let mut k = j;
                    while k < c.len() && c[k].is_ascii_lowercase() {
                        k += 1;
                    }
                    out.push(c[s..k].iter().collect());
                    i = k;
                } else {
                    i = j;
                }
            } else if !next_lower {
                out.push(c[s..j].iter().collect());
                i = j;
            } else {
                // "ABCdef": "AB" is an acronym, "Cdef" a word.
                if run >= 3 {
                    out.push(c[s..j - 1].iter().collect());
                }
                i = j - 1;
            }
        } else {
            i += 1;
        }
    }
    out
}

fn refresh_catalog(p: &Paths) -> R {
    let body = http_get("https://api.github.com/repos/Beblia/Holy-Bible-XML-Format/git/trees/master?recursive=1")?;
    let tree: Value = serde_json::from_slice(&body).map_err(|e| format!("JSON.parse: {e}"))?;
    let Some(entries) = tree.get("tree").and_then(|t| t.as_array()) else {
        return Err(str_of(&tree, "message").to_string()).map_err(|m| if m.is_empty() { "unexpected response".into() } else { m });
    };
    let items: Vec<Value> = entries
        .iter()
        .filter(|t| str_of(t, "type") == "blob" && str_of(t, "path").to_lowercase().ends_with(".xml") && !str_of(t, "path").contains('/'))
        .map(|t| {
            let path = str_of(t, "path");
            let base = &path[..path.len() - 4];
            let base = base.strip_suffix("Bible").unwrap_or(base);
            let mut toks = name_tokens(base);
            if toks.is_empty() {
                toks.push(base.to_string());
            }
            let lang = toks[0].clone();
            let edition = toks[1..].join(" ").trim().to_string();
            let name = if edition.is_empty() { lang.clone() } else { format!("{lang} {edition}") };
            json!({ "file": path, "lang": lang, "name": name.trim() })
        })
        .collect();
    let n = items.len();
    write_json_atomic(&p.user_catalog, &json!({ "source": "Beblia/Holy-Bible-XML-Format", "branch": "master", "items": items }), false)?;
    Ok(json!({ "count": n }))
}

fn encode_uri_component(s: &str) -> String {
    let mut out = String::new();
    for b in s.bytes() {
        let c = b as char;
        if c.is_ascii_alphanumeric() || "-_.!~*'()".contains(c) {
            out.push(c);
        } else {
            out.push_str(&format!("%{b:02X}"));
        }
    }
    out
}

fn download(st: &AppState, arg: &Value) -> R {
    let file = str_of(arg, "file").to_string();
    if file.is_empty() || file.contains(['/', '\\']) {
        return Err("BAD_ID".into());
    }
    let xml = http_get(&format!("{RAW_BASE}{}", encode_uri_component(&file)))?;
    let tmp = std::env::temp_dir().join(format!(
        "bp-{}-{}",
        now_ms(),
        file.chars().map(|c| if c.is_ascii_alphanumeric() || "_.-".contains(c) { c } else { '_' }).collect::<String>()
    ));
    fs::write(&tmp, &xml).map_err(|e| e.to_string())?;
    let lang = arg.get("lang").and_then(|v| v.as_str()).filter(|s| !s.is_empty()).unwrap_or("en");
    let res = import_bible_xml(&tmp, &canonical_books(lang), &st.paths.bibles, Some(&stem(&file)));
    remove_file_quiet(&tmp);
    let info = res?;
    let id = str_of(&info, "id").to_string();
    // Remember where it came from so the catalogue can show it as installed.
    let fp = st.paths.bibles.join(format!("{id}.json"));
    if let Some(mut data) = read_json_safe(&fp) {
        data["sourceFile"] = json!(file);
        if let Some(cl) = arg.get("catalogLang").and_then(|v| v.as_str()).filter(|s| !s.is_empty()) {
            data["language"] = json!(cl.split_whitespace().next().unwrap_or(cl));
        }
        write_json_atomic(&fp, &data, false)?;
    }
    forget(st, &id);
    Ok(info)
}

// ---------------------------------------------------------------- XML import
fn re(pat: &str) -> Regex {
    RegexBuilder::new(pat).case_insensitive(true).dot_matches_new_line(true).size_limit(1 << 26).build().unwrap()
}
static RE_NOTE: Lazy<Regex> = Lazy::new(|| re(r"<NOTE.*?</NOTE>"));
static RE_TAG: Lazy<Regex> = Lazy::new(|| re(r"<[^>]+>"));
static RE_CIRCLED: Lazy<Regex> = Lazy::new(|| Regex::new(r"[\x{24B6}-\x{24E9}\x{2460}-\x{2473}]").unwrap());
static RE_WS: Lazy<Regex> = Lazy::new(|| Regex::new(r"\s+").unwrap());
static RE_DEC: Lazy<Regex> = Lazy::new(|| Regex::new(r"&#(\d+);").unwrap());
static RE_HEX: Lazy<Regex> = Lazy::new(|| re(r"&#x([0-9a-f]+);"));

fn decode_entities(s: &str) -> String {
    let s = s.replace("&lt;", "<").replace("&gt;", ">").replace("&quot;", "\"").replace("&apos;", "'");
    let s = RE_DEC.replace_all(&s, |c: &regex::Captures| {
        c[1].parse::<u32>().ok().and_then(char::from_u32).map(String::from).unwrap_or_default()
    });
    let s = RE_HEX.replace_all(&s, |c: &regex::Captures| {
        u32::from_str_radix(&c[1], 16).ok().and_then(char::from_u32).map(String::from).unwrap_or_default()
    });
    s.replace("&amp;", "&")
}

fn strip_tags(s: &str) -> String {
    let s = RE_NOTE.replace_all(s, "");
    let s = RE_TAG.replace_all(&s, " ");
    let s = decode_entities(&s);
    let s = RE_CIRCLED.replace_all(&s, "");
    RE_WS.replace_all(&s, " ").trim().to_string()
}

fn put<T: Default + Clone>(v: &mut Vec<T>, idx: usize, val: T) {
    if v.len() <= idx {
        v.resize(idx + 1, T::default());
    }
    v[idx] = val;
}

static RE_Z_BOOK: Lazy<Regex> = Lazy::new(|| re(r"<BIBLEBOOK\b([^>]*)>(.*?)</BIBLEBOOK>"));
static RE_Z_BNUM: Lazy<Regex> = Lazy::new(|| re(r#"bnumber="(\d+)""#));
static RE_Z_BNAME: Lazy<Regex> = Lazy::new(|| re(r#"bname="([^"]*)""#));
static RE_Z_CH: Lazy<Regex> = Lazy::new(|| re(r#"<CHAPTER\b[^>]*cnumber="(\d+)"[^>]*>(.*?)</CHAPTER>"#));
static RE_Z_V: Lazy<Regex> = Lazy::new(|| re(r#"<VERS\b[^>]*vnumber="(\d+)"[^>]*>(.*?)</VERS>"#));
static RE_TITLE: Lazy<Regex> = Lazy::new(|| re(r"<title>(.*?)</title>"));
static RE_BIBLENAME: Lazy<Regex> = Lazy::new(|| re(r#"<XMLBIBLE\b[^>]*\bbiblename="([^"]+)""#));

struct ZBook {
    bnumber: usize,
    bname: String,
    chapters: Vec<Vec<String>>,
}

fn parse_zefania(xml: &str) -> (Vec<ZBook>, Option<String>) {
    let mut books = Vec::new();
    for bm in RE_Z_BOOK.captures_iter(xml) {
        let attrs = &bm[1];
        let body = &bm[2];
        let bnum: usize = RE_Z_BNUM.captures(attrs).and_then(|c| c[1].parse().ok()).unwrap_or(0);
        if bnum == 0 {
            continue;
        }
        let bname = RE_Z_BNAME.captures(attrs).map(|c| decode_entities(&c[1])).unwrap_or_default();
        let mut chapters: Vec<Vec<String>> = Vec::new();
        for cm in RE_Z_CH.captures_iter(body) {
            let cnum: usize = cm[1].parse().unwrap_or(0);
            if cnum == 0 {
                continue;
            }
            let mut verses: Vec<String> = Vec::new();
            for vm in RE_Z_V.captures_iter(&cm[2]) {
                let vn: usize = vm[1].parse().unwrap_or(0);
                if vn > 0 {
                    put(&mut verses, vn - 1, strip_tags(&vm[2]));
                }
            }
            put(&mut chapters, cnum - 1, verses);
        }
        books.push(ZBook { bnumber: bnum, bname, chapters });
    }
    // <INFORMATION><title> is the usual place; many files only carry the
    // name in the root element's biblename attribute.
    let title = RE_TITLE.captures(xml).map(|c| c[1].to_string()).or_else(|| RE_BIBLENAME.captures(xml).map(|c| c[1].to_string()));
    (books, title.map(|t| strip_tags(&t)))
}

static RE_O_VERSE: Lazy<Regex> = Lazy::new(|| re(r#"<verse\b[^>]*osisID="([A-Za-z0-9]+)\.(\d+)\.(\d+)"[^>]*/?>"#));
static RE_O_END: Lazy<Regex> = Lazy::new(|| re(r"<verse|</chapter|</div"));
static RE_O_TITLE: Lazy<Regex> = Lazy::new(|| re(r"<title[^>]*>(.*?)</title>"));

fn parse_osis(xml: &str) -> Option<(HashMap<String, Vec<Vec<String>>>, Option<String>)> {
    let mut by: HashMap<String, Vec<Vec<String>>> = HashMap::new();
    let mut found = 0;
    let mut pos = 0;
    while let Some(m) = RE_O_VERSE.captures_at(xml, pos) {
        let whole = m.get(0).unwrap();
        // The verse text runs up to the next verse tag or the end of the
        // chapter or division.
        let text = match RE_O_END.find_at(xml, whole.end()) {
            Some(e) => {
                pos = e.start();
                strip_tags(&xml[whole.end()..e.start()])
            }
            None => {
                pos = whole.end();
                String::new()
            }
        };
        if pos <= whole.start() {
            pos = whole.end();
        }
        if text.is_empty() {
            continue;
        }
        let (Ok(c), Ok(v)) = (m[2].parse::<usize>(), m[3].parse::<usize>()) else { continue };
        if c == 0 || v == 0 {
            continue;
        }
        found += 1;
        let chapters = by.entry(m[1].to_string()).or_default();
        if chapters.len() < c {
            chapters.resize(c, Vec::new());
        }
        put(&mut chapters[c - 1], v - 1, text);
    }
    if found == 0 {
        return None;
    }
    let title = RE_O_TITLE.captures(xml).map(|c| strip_tags(&c[1]));
    Some((by, title))
}

static RE_B_BOOK: Lazy<Regex> = Lazy::new(|| re(r#"<book\b[^>]*number="(\d+)"[^>]*>(.*?)</book>"#));
static RE_B_CH: Lazy<Regex> = Lazy::new(|| re(r#"<chapter\b[^>]*number="(\d+)"[^>]*>(.*?)</chapter>"#));
static RE_B_V: Lazy<Regex> = Lazy::new(|| re(r#"<verse\b[^>]*number="(\d+)"[^>]*>(.*?)</verse>"#));
static RE_B_TITLE: Lazy<Regex> = Lazy::new(|| re(r#"<bible\b[^>]*translation="([^"]+)""#));

// Format B: <bible translation="…"><testament><book number="1">
//             <chapter number="1"><verse number="1">text</verse>
fn parse_book_number(xml: &str) -> Option<(Vec<(usize, Vec<Vec<String>>)>, Option<String>)> {
    let mut out: Vec<(usize, Vec<Vec<String>>)> = Vec::new();
    for bm in RE_B_BOOK.captures_iter(xml) {
        let bnum: usize = bm[1].parse().unwrap_or(0);
        let mut chapters: Vec<Vec<String>> = Vec::new();
        for cm in RE_B_CH.captures_iter(&bm[2]) {
            let cn: usize = cm[1].parse().unwrap_or(0);
            if cn == 0 {
                continue;
            }
            let mut verses = Vec::new();
            for vm in RE_B_V.captures_iter(&cm[2]) {
                let vn: usize = vm[1].parse().unwrap_or(0);
                if vn > 0 {
                    put(&mut verses, vn - 1, strip_tags(&vm[2]));
                }
            }
            put(&mut chapters, cn - 1, verses);
        }
        if !chapters.is_empty() {
            if let Some(e) = out.iter_mut().find(|(n, _)| *n == bnum) {
                e.1 = chapters;
            } else {
                out.push((bnum, chapters));
            }
        }
    }
    if out.is_empty() {
        return None;
    }
    out.sort_by_key(|(n, _)| *n);
    let title = RE_B_TITLE.captures(xml).map(|c| decode_entities(&c[1]));
    Some((out, title))
}

static RE_IS_Z: Lazy<Regex> = Lazy::new(|| re(r"<BIBLEBOOK\b"));
static RE_IS_B: Lazy<Regex> = Lazy::new(|| re(r"<book\b[^>]*number="));
static RE_IS_O: Lazy<Regex> = Lazy::new(|| re(r"<osis\b|<osisText\b"));

/// Imports a translation into the app's own format:
/// { id, name, books: { Gen: { canonicalId, osis, name, chapters: [[verse…]…] } } }.
/// `base_name` gives downloads a stable id (the catalogue file name rather
/// than the temp file the download was saved to).
pub fn import_bible_xml(xml_path: &Path, canon: &[CanonBook], out_dir: &Path, base_name: Option<&str>) -> R {
    let bytes = fs::read(xml_path).map_err(|e| e.to_string())?;
    let xml = String::from_utf8_lossy(&bytes);
    let base = base_name.map(String::from).unwrap_or_else(|| stem(&xml_path.to_string_lossy()));
    let mut books = Map::new();
    let mut title: Option<String> = None;
    let mut matched = 0usize;
    let mut own_names = 0usize;
    let add = |books: &mut Map<String, Value>, c: &CanonBook, name: String, chapters: Vec<Vec<String>>| {
        books.insert(c.osis.clone(), json!({ "canonicalId": c.canonical_id, "osis": c.osis, "name": name, "chapters": chapters }));
    };
    if RE_IS_Z.is_match(&xml) {
        let (zb, t) = parse_zefania(&xml);
        title = t;
        for b in zb {
            // Zefania bnumber is the canonical order 1..66; others are skipped.
            let Some(c) = canon.get(b.bnumber - 1) else { continue };
            if b.chapters.is_empty() {
                continue;
            }
            let own = b.bname.trim().to_string();
            if !own.is_empty() {
                own_names += 1;
            }
            add(&mut books, c, if own.is_empty() { c.name.clone() } else { own }, b.chapters);
            matched += 1;
        }
    } else if RE_IS_B.is_match(&xml) {
        if let Some((bn, t)) = parse_book_number(&xml) {
            title = t;
            for (num, chapters) in bn {
                let Some(c) = canon.get(num.wrapping_sub(1)) else { continue };
                if chapters.is_empty() {
                    continue;
                }
                add(&mut books, c, c.name.clone(), chapters);
                matched += 1;
            }
        }
    } else if RE_IS_O.is_match(&xml) {
        if let Some((by, t)) = parse_osis(&xml) {
            title = t;
            for c in canon {
                let Some(ch) = by.get(&c.osis) else { continue };
                if ch.is_empty() {
                    continue;
                }
                add(&mut books, c, c.name.clone(), ch.clone());
                matched += 1;
            }
        }
    }
    if matched < 1 {
        return Err("XML_UNRECOGNISED".into());
    }
    let name = title.filter(|t| !t.is_empty()).unwrap_or_else(|| base.clone());
    // The id comes from the file name. A Cyrillic name used to collapse to an
    // empty id, so a hash of the names is used then.
    let lower = base.to_lowercase();
    let mut slug = String::new();
    let mut dash = false;
    for ch in lower.chars() {
        if ch.is_ascii_lowercase() || ch.is_ascii_digit() {
            if dash && !slug.is_empty() {
                slug.push('-');
            }
            dash = false;
            slug.push(ch);
        } else {
            dash = true;
        }
    }
    let mut slug: String = slug.chars().take(40).collect();
    slug = slug.trim_end_matches('-').to_string();
    if slug.is_empty() {
        let mut h = Sha1::new();
        h.update(format!("{base}|{name}").as_bytes());
        slug = format!("bible-{}", &hex::encode(h.finalize())[..10]);
    }
    fs::create_dir_all(out_dir).map_err(|e| e.to_string())?;
    let mut id = format!("user-{slug}");
    let mut n = 2;
    loop {
        let fp = out_dir.join(format!("{id}.json"));
        if !fp.exists() {
            break;
        }
        // Re-importing the same translation replaces it; a different one gets its own id.
        let existing = read_json_safe(&fp);
        match existing {
            None => break,
            Some(e) if str_of(&e, "name") == name => break,
            _ => {}
        }
        id = format!("user-{slug}-{n}");
        n += 1;
    }
    // The file's own book names are used when it has them for nearly every book.
    let has_own = own_names > 0 && own_names >= (matched as f64 * 0.8).ceil() as usize;
    let data = json!({
        "id": id, "name": name, "books": books, "hasOwnNames": has_own,
        "meta": { "importedFrom": basename(&xml_path.to_string_lossy()), "importedAt": chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true) },
    });
    write_json_atomic(&out_dir.join(format!("{id}.json")), &data, false)?;
    Ok(json!({ "id": id, "name": name, "books": matched }))
}
