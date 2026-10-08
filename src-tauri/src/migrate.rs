//! Settings kept by the 2.x (Electron) versions in the page's localStorage —
//! interface language, live-output port, the last playlist, stage display
//! options — are read from Chromium's LevelDB store once and handed to the new
//! page before it starts, so an update does not reset them.

use std::collections::BTreeMap;
use std::path::Path;

fn latin1(b: &[u8]) -> String {
    b.iter().map(|&c| c as char).collect()
}
fn utf16le(b: &[u8]) -> String {
    let units: Vec<u16> = b.chunks_exact(2).map(|c| u16::from_le_bytes([c[0], c[1]])).collect();
    String::from_utf16_lossy(&units)
}
// Chromium prefixes each string with its encoding: 1 = Latin-1, 0 = UTF-16.
fn decode(b: &[u8]) -> Option<String> {
    match b.first()? {
        1 => Some(latin1(&b[1..])),
        0 => Some(utf16le(&b[1..])),
        _ => None,
    }
}

pub fn read_electron_local_storage(root: &Path) -> BTreeMap<String, String> {
    let mut out = BTreeMap::new();
    let src = root.join("Local Storage").join("leveldb");
    if !src.is_dir() {
        return out;
    }
    // Work on a copy: opening the store may write to it.
    let tmp = std::env::temp_dir().join(format!("bp-ls-{}", crate::store::random_hex(6)));
    if std::fs::create_dir_all(&tmp).is_err() {
        return out;
    }
    if let Ok(rd) = std::fs::read_dir(&src) {
        for e in rd.filter_map(|e| e.ok()) {
            if e.file_name() != "LOCK" {
                let _ = std::fs::copy(e.path(), tmp.join(e.file_name()));
            }
        }
    }
    let opts = rusty_leveldb::Options { create_if_missing: false, ..Default::default() };
    if let Ok(mut db) = rusty_leveldb::DB::open(&tmp, opts) {
        if let Ok(mut it) = db.new_iter() {
            use rusty_leveldb::LdbIterator;
            while let Some((k, v)) = it.next() {
                // "_" + origin + "\0" + encoded key
                if k.first() != Some(&b'_') {
                    continue;
                }
                let Some(nul) = k.iter().position(|&c| c == 0) else { continue };
                let origin = &k[1..nul];
                if origin != b"file://" {
                    continue;
                }
                if let (Some(key), Some(val)) = (decode(&k[nul + 1..]), decode(&v)) {
                    if !key.is_empty() {
                        out.insert(key, val);
                    }
                }
            }
        }
    }
    let _ = std::fs::remove_dir_all(&tmp);
    out
}

/// A script that copies the old settings into the new page's storage on the
/// first start; keys the new page already has are left alone.
pub fn init_script(root: &Path) -> Option<String> {
    let map = read_electron_local_storage(root);
    if map.is_empty() {
        return None;
    }
    let data = serde_json::to_string(&map).ok()?;
    Some(format!(
        "(function(){{try{{if(localStorage.getItem('__bpMigrated'))return;var d={data};for(var k in d){{if(localStorage.getItem(k)===null)localStorage.setItem(k,d[k]);}}localStorage.setItem('__bpMigrated','1');}}catch(e){{}}}})();"
    ))
}
