//! Installed font families, for the theme editor's font list, and the font
//! files behind them.
//!
//! The real family name is read from each font's "name" table (file names are
//! useless on Windows: arialbd.ttf → "arialbd"). Only the tables that matter
//! are read, so scanning a system with many large fonts stays quick.
//!
//! Why the files too: picking a family by name leaves the matching to the web
//! view, and that goes wrong in ways the operator can't see — a variable font
//! (Google's Montserrat download) drawn at its default Thin instance, a font
//! installed while the app was open, a font the web view's own font list
//! doesn't include, or vMix on another computer that doesn't have the font at
//! all. So every page loads the chosen family from its own files (see
//! app/shared/fontfaces.js), and the system name is only the fallback.

use parking_lot::Mutex;
use std::collections::{BTreeSet, HashMap};
use std::sync::Arc;
use std::fs::File;
use std::io::{Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};

fn read_at(f: &mut File, pos: u64, len: usize) -> Vec<u8> {
    let mut buf = vec![0u8; len];
    if f.seek(SeekFrom::Start(pos)).is_err() {
        return vec![];
    }
    let mut got = 0;
    while got < len {
        match f.read(&mut buf[got..]) {
            Ok(0) | Err(_) => break,
            Ok(n) => got += n,
        }
    }
    buf.truncate(got);
    buf
}
fn u16be(b: &[u8], i: usize) -> Option<u16> {
    b.get(i..i + 2).map(|x| u16::from_be_bytes([x[0], x[1]]))
}
fn u32be(b: &[u8], i: usize) -> Option<u32> {
    b.get(i..i + 4).map(|x| u32::from_be_bytes([x[0], x[1], x[2], x[3]]))
}


/// One font file of a family, as the pages declare it in @font-face.
#[derive(Clone, Debug)]
pub struct Face {
    pub id: String,
    pub path: PathBuf,
    /// "400", or "100 900" for a variable font.
    pub weight: String,
    pub italic: bool,
    /// CSS font-stretch, "100%" for normal width.
    pub stretch: &'static str,
    variable: bool,
}

#[derive(Default)]
pub struct Catalog {
    /// Family names for the font list, sorted.
    pub families: Vec<String>,
    /// Which scripts each family can write (see `COVER_*`).
    pub cover: HashMap<String, u8>,
    faces: HashMap<String, Vec<Face>>,
    by_id: HashMap<String, PathBuf>,
}

pub const COVER_CYRILLIC: u8 = 1;
pub const COVER_UKRAINIAN: u8 = 2;
pub const COVER_GREEK: u8 = 4;
pub const COVER_LATIN_EXT: u8 = 8;

impl Catalog {
    pub fn faces(&self, family: &str) -> &[Face] {
        self.faces.get(family).map(|v| v.as_slice()).unwrap_or(&[])
    }
    /// A font file by the opaque id the pages were given — never by a path.
    pub fn file(&self, id: &str) -> Option<&PathBuf> {
        self.by_id.get(id)
    }
}

static CATALOG: Mutex<Option<Arc<Catalog>>> = Mutex::new(None);

/// The installed fonts, scanned once per run.
pub fn catalog() -> Arc<Catalog> {
    let mut c = CATALOG.lock();
    if c.is_none() {
        // Tests point the scan at their own fonts (debug builds only).
        let dirs = match std::env::var_os("BP_FONT_DIRS") {
            Some(d) if cfg!(debug_assertions) => std::env::split_paths(&d).collect(),
            _ => font_dirs(),
        };
        *c = Some(Arc::new(scan(&dirs)));
    }
    c.clone().unwrap_or_default()
}

#[cfg(test)]
pub fn use_for_tests(dirs: &[PathBuf]) {
    *CATALOG.lock() = Some(Arc::new(scan(dirs)));
}

struct Info {
    family: String,
    weight: u16,
    width: u16,
    italic: bool,
    wght: Option<(f32, f32)>,
    cover: u8,
}

fn table(dir: &[u8], tag: &[u8; 4]) -> Option<(u64, usize)> {
    for i in 0..dir.len() / 16 {
        if &dir[i * 16..i * 16 + 4] == tag {
            return Some((u32be(dir, i * 16 + 8)? as u64, u32be(dir, i * 16 + 12)? as usize));
        }
    }
    None
}

/// Every font in the file: one for .ttf/.otf, several for a collection
/// (.ttc). A collection often holds different families — "MS Gothic" and
/// "MS UI Gothic", "Cambria" and "Cambria Math", the PingFang set on a Mac —
/// and reading only the first left the others out of the font list.
fn read_infos(path: &Path) -> Vec<Info> {
    let Ok(mut f) = File::open(path) else { return vec![] };
    let head = read_at(&mut f, 0, 12);
    if head.len() < 12 {
        return vec![];
    }
    let mut covers = HashMap::new();
    if &head[0..4] != b"ttcf" {
        return read_info_at(&mut f, 0, &mut covers).into_iter().collect();
    }
    let count = (u32be(&head, 8).unwrap_or(0) as usize).min(64);
    let offsets = read_at(&mut f, 12, count * 4);
    (0..count).filter_map(|i| u32be(&offsets, i * 4)).filter_map(|o| read_info_at(&mut f, o as u64, &mut covers)).collect()
}

/// One font, starting at `offset` in the file. `covers` remembers character
/// maps already read: the fonts of a collection usually share one.
fn read_info_at(f: &mut File, offset: u64, covers: &mut HashMap<(u64, usize), u8>) -> Option<Info> {
    let sfnt = read_at(f, offset, 12);
    if sfnt.len() < 12 {
        return None;
    }
    let num_tables = u16be(&sfnt, 4)? as usize;
    if num_tables == 0 || num_tables > 200 {
        return None;
    }
    let dir = read_at(f, offset + 12, num_tables * 16);
    let (off, len) = table(&dir, b"name")?;
    if len == 0 || len > 1 << 20 {
        return None;
    }
    let buf = read_at(f, off, len);
    let (family, sub) = names(&buf)?;

    let mut weight = 400u16;
    let mut width = 5u16;
    let mut italic = false;
    if let Some((o, l)) = table(&dir, b"OS/2") {
        let os2 = read_at(f, o, l.min(128));
        if let (Some(w), Some(wd), Some(sel)) = (u16be(&os2, 4), u16be(&os2, 6), u16be(&os2, 62)) {
            // A few old fonts use 1–9 instead of 100–900.
            weight = if (1..10).contains(&w) { w * 100 } else { w.clamp(1, 1000) };
            width = wd.clamp(1, 9);
            italic = sel & 1 != 0 || sel & (1 << 9) != 0;
        }
    }
    let s = sub.to_lowercase();
    if s.contains("italic") || s.contains("oblique") {
        italic = true;
    }
    let mut wght = None;
    if let Some((o, l)) = table(&dir, b"fvar") {
        let fv = read_at(f, o, l.min(4096));
        if let (Some(axes_off), Some(count), Some(size)) = (u16be(&fv, 4), u16be(&fv, 8), u16be(&fv, 10)) {
            for i in 0..count as usize {
                let a = axes_off as usize + i * size as usize;
                if fv.get(a..a + 4) == Some(b"wght") {
                    let fx = |at: usize| u32be(&fv, at).map(|v| v as i32 as f32 / 65536.0);
                    if let (Some(lo), Some(hi)) = (fx(a + 4), fx(a + 12)) {
                        wght = Some((lo.clamp(1.0, 1000.0), hi.clamp(1.0, 1000.0)));
                    }
                }
            }
        }
    }
    let cover = table(&dir, b"cmap").map(|(o, l)| *covers.entry((o, l)).or_insert_with(|| cover_of(f, o, l))).unwrap_or(0);
    Some(Info { family, weight, width, italic, wght, cover })
}

/// (family, subfamily) from a "name" table. Several records per font
/// (Mac/Windows/Unicode × languages); browsers match the Windows-platform
/// family and the Mac record is often PostScript-y. Rank: Windows over
/// Unicode over Mac; typographic family (16) over family (1); English over
/// other languages.
fn names(buf: &[u8]) -> Option<(String, String)> {
    if buf.len() < 6 {
        return None;
    }
    let count = u16be(buf, 2)? as usize;
    let str_off = u16be(buf, 4)? as usize;
    let mut best: [(i32, String); 2] = [(-1, String::new()), (-1, String::new())];
    for i in 0..count {
        let rec = 6 + i * 12;
        if rec + 12 > buf.len() {
            break;
        }
        let platform = u16be(buf, rec)?;
        let lang = u16be(buf, rec + 4)?;
        let name_id = u16be(buf, rec + 6)?;
        let slot = match name_id {
            1 | 16 => 0,
            2 | 17 => 1,
            _ => continue,
        };
        let l = u16be(buf, rec + 8)? as usize;
        let o = str_off + u16be(buf, rec + 10)? as usize;
        if o + l > buf.len() {
            continue;
        }
        let val = match platform {
            3 | 0 => {
                let units: Vec<u16> = buf[o..o + l].chunks_exact(2).map(|c| u16::from_be_bytes([c[0], c[1]])).collect();
                String::from_utf16_lossy(&units).trim().to_string()
            }
            1 => buf[o..o + l].iter().map(|&b| b as char).collect::<String>().trim().to_string(),
            _ => continue,
        };
        if val.is_empty() {
            continue;
        }
        let plat = match platform {
            3 => 30,
            0 => 20,
            _ => 10,
        };
        let nm = if name_id >= 16 { 5 } else { 0 };
        let lg = if (platform == 3 && lang == 0x409) || (platform == 1 && lang == 0) { 2 } else { 0 };
        let score = plat + nm + lg;
        if score > best[slot].0 {
            best[slot] = (score, val);
        }
    }
    if best[0].0 < 0 {
        return None;
    }
    let [(_, fam), (_, sub)] = best;
    Some((fam, sub))
}

/// Which scripts the font can write, from its character map: letters a
/// family without them would take from another font, so text in that
/// language looks like a different typeface.
fn cover_of(f: &mut File, off: u64, len: usize) -> u8 {
    let head = read_at(f, off, 4 + 8 * 64);
    let n = u16be(&head, 2).unwrap_or(0) as usize;
    let mut pick: Option<(u32, u16)> = None;
    for i in 0..n.min(64) {
        let (Some(pl), Some(enc), Some(o)) = (u16be(&head, 4 + i * 8), u16be(&head, 6 + i * 8), u32be(&head, 8 + i * 8)) else { break };
        let rank = match (pl, enc) {
            (3, 10) | (0, 4) | (0, 6) => 3,
            (3, 1) | (0, 3) => 2,
            (0, _) => 1,
            _ => 0,
        };
        if rank > 0 && pick.map_or(true, |(_, r)| rank as u16 > r) {
            pick = Some((o, rank as u16));
        }
    }
    let Some((sub, _)) = pick else { return 0 };
    let sub_off = off + sub as u64;
    let h = read_at(f, sub_off, 12);
    let fmt = u16be(&h, 0).unwrap_or(0);
    let tlen = match fmt {
        4 => u16be(&h, 2).unwrap_or(0) as usize,
        12 => u32be(&h, 4).unwrap_or(0) as usize,
        _ => 0,
    };
    if tlen == 0 || tlen > 4 << 20 || tlen > len {
        return 0;
    }
    let t = read_at(f, sub_off, tlen);
    let has = |cp: u32| -> bool {
        match fmt {
            4 => {
                let segs = u16be(&t, 6).unwrap_or(0) as usize / 2;
                for s in 0..segs {
                    let end = u16be(&t, 14 + s * 2).unwrap_or(0) as u32;
                    if cp <= end {
                        let start = u16be(&t, 16 + segs * 2 + s * 2).unwrap_or(0xFFFF) as u32;
                        return cp >= start;
                    }
                }
                false
            }
            _ => {
                let groups = u32be(&t, 12).unwrap_or(0) as usize;
                (0..groups).any(|g| {
                    let b = 16 + g * 12;
                    matches!((u32be(&t, b), u32be(&t, b + 4)), (Some(a), Some(z)) if cp >= a && cp <= z)
                })
            }
        }
    };
    let all = |s: &str| s.chars().all(|c| has(c as u32));
    let mut m = 0;
    if all("АБЖЯабжя") {
        m |= COVER_CYRILLIC;
    }
    if all("ҐЄІЇґєії") {
        m |= COVER_UKRAINIAN;
    }
    if all("ΑΩΣαλω") {
        m |= COVER_GREEK;
    }
    if all("ąčęłřőşğėųž") {
        m |= COVER_LATIN_EXT;
    }
    m
}

fn stretch_css(width: u16) -> &'static str {
    ["50%", "62.5%", "75%", "87.5%", "100%", "112.5%", "125%", "150%", "200%"][(width.clamp(1, 9) - 1) as usize]
}

fn face_id(path: &Path) -> String {
    // FNV-1a of the path: stable while the file stays, says nothing about it.
    let mut h: u64 = 0xcbf29ce484222325;
    for b in path.to_string_lossy().as_bytes() {
        h ^= *b as u64;
        h = h.wrapping_mul(0x100000001b3);
    }
    format!("{h:016x}")
}

fn font_dirs() -> Vec<PathBuf> {
    let mut d = Vec::new();
    #[cfg(windows)]
    {
        let win = std::env::var_os("WINDIR").map(PathBuf::from).unwrap_or_else(|| PathBuf::from(r"C:\Windows"));
        d.push(win.join("Fonts"));
        if let Some(l) = std::env::var_os("LOCALAPPDATA") {
            d.push(PathBuf::from(l).join("Microsoft").join("Windows").join("Fonts"));
        }
    }
    #[cfg(target_os = "macos")]
    {
        d.push(PathBuf::from("/System/Library/Fonts"));
        d.push(PathBuf::from("/Library/Fonts"));
        if let Some(h) = dirs::home_dir() {
            d.push(h.join("Library").join("Fonts"));
        }
    }
    #[cfg(all(unix, not(target_os = "macos")))]
    {
        d.push(PathBuf::from("/usr/share/fonts"));
        d.push(PathBuf::from("/usr/local/share/fonts"));
        if let Some(h) = dirs::home_dir() {
            d.push(h.join(".fonts"));
            d.push(h.join(".local/share/fonts"));
        }
    }
    d
}

pub fn scan(dirs: &[PathBuf]) -> Catalog {
    let mut found: Vec<(PathBuf, Info)> = Vec::new();
    fn walk(dir: &Path, found: &mut Vec<(PathBuf, Info)>, depth: usize) {
        if depth > 8 {
            return;
        }
        let Ok(rd) = std::fs::read_dir(dir) else { return };
        let mut entries: Vec<_> = rd.filter_map(|e| e.ok()).collect();
        entries.sort_by_key(|e| e.file_name());
        for e in entries {
            let p = e.path();
            let Ok(ft) = e.file_type() else { continue };
            if ft.is_dir() {
                walk(&p, found, depth + 1);
                continue;
            }
            let ext = p.extension().map(|x| x.to_string_lossy().to_lowercase()).unwrap_or_default();
            if !matches!(ext.as_str(), "ttf" | "otf" | "ttc") {
                continue;
            }
            for info in read_infos(&p) {
                found.push((p.clone(), info));
            }
        }
    }
    for d in dirs {
        walk(d, &mut found, 0);
    }
    let mut cat = Catalog::default();
    let mut names = BTreeSet::new();
    for (path, info) in found {
        names.insert(info.family.clone());
        *cat.cover.entry(info.family.clone()).or_insert(0) |= info.cover;
        // Collections (.ttc) only for the list: web views don't load them as
        // web fonts reliably, and they're system fonts the web view knows.
        let ext = path.extension().map(|x| x.to_string_lossy().to_lowercase()).unwrap_or_default();
        if ext == "ttc" {
            continue;
        }
        let (weight, variable) = match info.wght {
            Some((lo, hi)) if hi > lo => (format!("{} {}", lo.round(), hi.round()), true),
            _ => (info.weight.to_string(), false),
        };
        let face = Face { id: face_id(&path), path, weight, italic: info.italic, stretch: stretch_css(info.width), variable };
        cat.faces.entry(info.family).or_default().push(face);
    }
    for list in cat.faces.values_mut() {
        // Fixed weights when the family has them (with a variable file of the
        // same family installed too, which one the browser picks is anyone's
        // guess); and one file per weight/style, the first found (.otf and
        // .ttf of the same font are often both installed).
        if list.iter().any(|f| !f.variable) {
            list.retain(|f| !f.variable);
        }
        let mut seen = BTreeSet::new();
        list.retain(|f| seen.insert((f.weight.clone(), f.italic, f.stretch)));
    }
    for f in cat.faces.values().flatten() {
        cat.by_id.insert(f.id.clone(), f.path.clone());
    }
    cat.families = names.into_iter().collect();
    cat
}
