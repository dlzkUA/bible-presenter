//! Installed font families, for the theme editor's font list. The real family
//! name is read from each font's "name" table (file names are useless on
//! Windows: arialbd.ttf → "arialbd"). Only the few kilobytes that matter are
//! read, so scanning a system with many large fonts stays quick.

use std::collections::BTreeSet;
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

pub fn read_font_family(path: &Path) -> Option<String> {
    let mut f = File::open(path).ok()?;
    let head = read_at(&mut f, 0, 16);
    if head.len() < 12 {
        return None;
    }
    let mut offset = 0u64;
    if &head[0..4] == b"ttcf" {
        offset = u32be(&head, 12)? as u64; // first font of a collection
    }
    let sfnt = read_at(&mut f, offset, 12);
    if sfnt.len() < 12 {
        return None;
    }
    let num_tables = u16be(&sfnt, 4)? as usize;
    if num_tables == 0 || num_tables > 200 {
        return None;
    }
    let dir = read_at(&mut f, offset + 12, num_tables * 16);
    let mut name_off = None;
    for i in 0..num_tables {
        if (i + 1) * 16 > dir.len() {
            break;
        }
        if &dir[i * 16..i * 16 + 4] == b"name" {
            name_off = Some((u32be(&dir, i * 16 + 8)?, u32be(&dir, i * 16 + 12)?));
            break;
        }
    }
    let (off, len) = name_off?;
    if len == 0 || len > 1 << 20 {
        return None;
    }
    let buf = read_at(&mut f, off as u64, len as usize);
    if buf.len() < 6 {
        return None;
    }
    let count = u16be(&buf, 2)? as usize;
    let str_off = u16be(&buf, 4)? as usize;
    // Several records per font (Mac/Windows/Unicode × languages). Browsers
    // match the Windows-platform family; the Mac record is often PostScript-y.
    // Rank: Windows over Unicode over Mac; typographic family (16) over family
    // (1); English over other languages.
    let mut best: Option<String> = None;
    let mut best_score = -1;
    for i in 0..count {
        let rec = 6 + i * 12;
        if rec + 12 > buf.len() {
            break;
        }
        let platform = u16be(&buf, rec)?;
        let lang = u16be(&buf, rec + 4)?;
        let name_id = u16be(&buf, rec + 6)?;
        if name_id != 1 && name_id != 16 {
            continue;
        }
        let l = u16be(&buf, rec + 8)? as usize;
        let o = str_off + u16be(&buf, rec + 10)? as usize;
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
        let plat = match platform { 3 => 30, 0 => 20, _ => 10 };
        let nm = if name_id == 16 { 5 } else { 0 };
        let lg = if (platform == 3 && lang == 0x409) || (platform == 1 && lang == 0) { 2 } else { 0 };
        let score = plat + nm + lg;
        if score > best_score {
            best_score = score;
            best = Some(val);
        }
    }
    best
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

pub fn scan_installed_fonts() -> Vec<String> {
    let mut names = BTreeSet::new();
    fn walk(dir: &Path, names: &mut BTreeSet<String>, depth: usize) {
        if depth > 8 {
            return;
        }
        let Ok(rd) = std::fs::read_dir(dir) else { return };
        for e in rd.filter_map(|e| e.ok()) {
            let p = e.path();
            let Ok(ft) = e.file_type() else { continue };
            if ft.is_dir() {
                walk(&p, names, depth + 1);
                continue;
            }
            let ext = p.extension().map(|x| x.to_string_lossy().to_lowercase()).unwrap_or_default();
            if !matches!(ext.as_str(), "ttf" | "otf" | "ttc") {
                continue;
            }
            if let Some(fam) = read_font_family(&p) {
                names.insert(fam);
            }
        }
    }
    for d in font_dirs() {
        walk(&d, &mut names, 0);
    }
    names.into_iter().collect()
}
