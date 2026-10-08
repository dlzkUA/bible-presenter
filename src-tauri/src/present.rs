//! Presentations: .pptx goes through LibreOffice to PDF (which keeps the slides
//! exactly as designed); a PDF is used as it is. The control window then draws
//! every page with pdf.js and hands the pictures back here, one by one.

use crate::dialogs;
use crate::state::{AppState, PresJob};
use crate::store::*;
use serde_json::{json, Value};
use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::time::{Duration, Instant};
use tauri::AppHandle;
use unicode_normalization::UnicodeNormalization;

type R = Result<Value, String>;

pub fn find_soffice() -> String {
    let mut c: Vec<PathBuf> = Vec::new();
    #[cfg(windows)]
    {
        for var in ["ProgramFiles", "ProgramW6432", "ProgramFiles(x86)"] {
            if let Some(d) = std::env::var_os(var) {
                c.push(PathBuf::from(d).join("LibreOffice").join("program").join("soffice.exe"));
            }
        }
        c.push(PathBuf::from(r"C:\Program Files\LibreOffice\program\soffice.exe"));
        c.push(PathBuf::from(r"C:\Program Files (x86)\LibreOffice\program\soffice.exe"));
    }
    #[cfg(target_os = "macos")]
    {
        c.push(PathBuf::from("/Applications/LibreOffice.app/Contents/MacOS/soffice"));
        if let Some(h) = dirs::home_dir() {
            c.push(h.join("Applications/LibreOffice.app/Contents/MacOS/soffice"));
        }
    }
    #[cfg(all(unix, not(target_os = "macos")))]
    {
        for p in ["/usr/bin/soffice", "/usr/local/bin/soffice", "/snap/bin/libreoffice", "/usr/lib/libreoffice/program/soffice"] {
            c.push(PathBuf::from(p));
        }
    }
    c.into_iter().find(|p| p.exists()).map(|p| p.to_string_lossy().to_string()).unwrap_or_else(|| "soffice".into())
}

/// File names on disk are kept ASCII: Windows can hand back a Cyrillic name in
/// a different Unicode form than it was written in, and the slide "vanishes".
fn safe_base_name(path: &str) -> String {
    let base = stem(path);
    let ascii: String = base.nfkd().filter(|c| !('\u{300}'..='\u{36f}').contains(c)).collect();
    let mut out = String::new();
    let mut under = false;
    for ch in ascii.chars() {
        if ch.is_ascii_alphanumeric() {
            if under && !out.is_empty() {
                out.push('_');
            }
            under = false;
            out.push(ch);
        } else {
            under = true;
        }
    }
    let out: String = out.chars().take(50).collect();
    let out = out.trim_end_matches('_').to_string();
    if out.is_empty() { "slides".into() } else { out }
}

fn count_pptx_slides(path: &Path) -> Result<usize, String> {
    let f = fs::File::open(path).map_err(|e| e.to_string())?;
    let zip = zip::ZipArchive::new(f).map_err(|_| "PPTX_EMPTY".to_string())?;
    let re = regex::Regex::new(r"^ppt/slides/slide\d+\.xml$").unwrap();
    Ok(zip.file_names().filter(|n| re.is_match(n)).count())
}

fn temp_dir(prefix: &str) -> Result<PathBuf, String> {
    let d = std::env::temp_dir().join(format!("{prefix}{}", random_hex(6)));
    fs::create_dir_all(&d).map_err(|e| e.to_string())?;
    Ok(d)
}

fn run_soffice(bin: &str, args: &[String], timeout: Duration) -> Result<(), String> {
    let mut cmd = Command::new(bin);
    cmd.args(args).stdout(std::process::Stdio::null()).stderr(std::process::Stdio::null());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x0800_0000); // CREATE_NO_WINDOW: no console flashing up
    }
    let mut child = cmd.spawn().map_err(|e| if e.kind() == std::io::ErrorKind::NotFound { "LIBREOFFICE_MISSING".to_string() } else { e.to_string() })?;
    let start = Instant::now();
    loop {
        match child.try_wait() {
            Ok(Some(_)) => return Ok(()),
            Ok(None) => {
                if start.elapsed() > timeout {
                    let _ = child.kill();
                    let _ = child.wait();
                    return Err("LIBREOFFICE_TIMEOUT".into());
                }
                std::thread::sleep(Duration::from_millis(150));
            }
            Err(e) => return Err(e.to_string()),
        }
    }
}

fn prepare(app: &AppHandle, st: &AppState, labels: &Value) -> R {
    let title = labels.get("title").and_then(|v| v.as_str()).filter(|s| !s.is_empty()).map(String::from).unwrap_or_else(|| st.t("Імпорт презентації (.pptx, .pdf)"));
    let all = labels.get("all").and_then(|v| v.as_str()).filter(|s| !s.is_empty()).map(String::from).unwrap_or_else(|| st.t("Презентації"));
    let Some(file) = dialogs::pick_file(app, &title, &[(&all, &["pptx", "pdf"]), ("PowerPoint", &["pptx"]), ("PDF", &["pdf"])]) else {
        return Ok(Value::Null);
    };
    prepare_file(st, &file)
}

pub fn prepare_file(st: &AppState, file: &Path) -> R {
    let fname = file.to_string_lossy().to_string();
    let is_pdf = extname(&fname).eq_ignore_ascii_case(".pdf");
    let (pdf, cleanup, rendered_with) = if is_pdf {
        (file.to_path_buf(), vec![], "pdfjs")
    } else {
        if count_pptx_slides(file)? == 0 {
            return Err("PPTX_EMPTY".into());
        }
        let bin = find_soffice();
        // An isolated LibreOffice profile: without it the conversion silently
        // fails whenever LibreOffice is already open on the computer.
        let out_dir = temp_dir("bp-pptx-")?;
        let profile = temp_dir("bp-loprofile-")?;
        let profile_url = format!("file:///{}", profile.to_string_lossy().replace('\\', "/").trim_start_matches('/'));
        let args = vec![
            format!("-env:UserInstallation={profile_url}"),
            "--headless".into(),
            "--norestore".into(),
            "--convert-to".into(),
            "pdf".into(),
            "--outdir".into(),
            out_dir.to_string_lossy().to_string(),
            fname.clone(),
        ];
        let res = run_soffice(&bin, &args, Duration::from_secs(180));
        let _ = fs::remove_dir_all(&profile);
        if let Err(e) = res {
            let _ = fs::remove_dir_all(&out_dir);
            return Err(e);
        }
        let pdf = out_dir.join(format!("{}.pdf", stem(&fname)));
        if !pdf.exists() {
            let _ = fs::remove_dir_all(&out_dir);
            return Err("LIBREOFFICE_NO_PDF".into());
        }
        (pdf, vec![out_dir], "libreoffice-pdfjs")
    };
    let id = random_hex(8);
    let base_name = safe_base_name(&fname);
    let stamp = stamp36();
    st.jobs.lock().insert(
        id.clone(),
        PresJob { pdf, cleanup, title: stem(&fname), rendered_with, written: vec![] },
    );
    Ok(json!({ "id": id, "baseName": base_name, "stamp": stamp }))
}

fn finish_job(st: &AppState, id: &str) -> Option<PresJob> {
    let job = st.jobs.lock().remove(id)?;
    for d in &job.cleanup {
        let _ = fs::remove_dir_all(d);
    }
    Some(job)
}

pub fn handle(app: &AppHandle, st: &AppState, ch: &str, arg: &Value) -> Option<R> {
    Some(match ch {
        "presentations:prepare" => prepare(app, st, arg),
        "presentations:finish" => (|| {
            let id = str_of(arg, "id");
            let job = finish_job(st, id).ok_or("PDF_UNREADABLE: job")?;
            let slides: Vec<Value> = arg.get("slides").and_then(|s| s.as_array()).cloned().unwrap_or_default()
                .into_iter()
                .filter(|s| job.written.iter().any(|w| w == str_of(s, "image")))
                .map(|s| json!({ "image": str_of(&s, "image") }))
                .collect();
            if slides.is_empty() {
                return Err("PDF_EMPTY".into());
            }
            let presentation = json!({ "title": job.title, "slides": slides, "slideCount": slides.len(), "renderedWith": job.rendered_with });
            let pid = format!("{}-{}", slugify(&job.title), stamp36());
            write_json_atomic(&json_path(&st.paths.presentations, &pid)?, &presentation, true)?;
            let mut out = json!({ "id": pid });
            for (k, v) in presentation.as_object().cloned().unwrap_or_default() {
                out[k] = v;
            }
            Ok(out)
        })(),
        // A page that failed half-way must not leave the earlier pages behind.
        "presentations:abort" => {
            if let Some(job) = finish_job(st, str_of(arg, "id")) {
                for w in job.written {
                    remove_file_quiet(&st.paths.media.join(w));
                }
            }
            Ok(json!(true))
        }
        "system:checkLibreOffice" => {
            let bin = find_soffice();
            let found = bin != "soffice" && Path::new(&bin).exists();
            Ok(json!({ "found": found, "bin": bin }))
        }
        _ => return None,
    })
}

/// The PDF of a job, for pdf.js in the control window.
pub fn job_pdf(st: &AppState, id: &str) -> Result<Vec<u8>, String> {
    let pdf = st.jobs.lock().get(id).map(|j| j.pdf.clone()).ok_or("PDF_UNREADABLE: job")?;
    fs::read(pdf).map_err(|e| format!("PDF_UNREADABLE: {e}"))
}

/// One drawn page, as PNG, saved into the media folder.
pub fn job_slide(st: &AppState, id: &str, name: &str, png: &[u8]) -> Result<(), String> {
    let ok_name = !name.is_empty()
        && name.len() < 200
        && name.ends_with(".png")
        && name.chars().all(|c| c.is_ascii_alphanumeric() || "_-.".contains(c))
        && !name.starts_with('.');
    if !ok_name || png.len() < 8 || &png[1..4] != b"PNG" {
        return Err("PDF_UNREADABLE: bad page".into());
    }
    let mut jobs = st.jobs.lock();
    let job = jobs.get_mut(id).ok_or("PDF_UNREADABLE: job")?;
    fs::write(st.paths.media.join(name), png).map_err(|e| e.to_string())?;
    job.written.push(name.to_string());
    Ok(())
}
