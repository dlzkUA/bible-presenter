use prost::Message;

fn main() {
    // ProPresenter's file formats are protobuf. Their schema is compiled here
    // (in Rust, no protoc needed) into a descriptor set the app decodes with.
    println!("cargo:rerun-if-changed=proto");
    let fds = protox::compile(["presentation.proto", "template.proto"], ["proto"]).expect("ProPresenter proto files");
    let out = std::path::PathBuf::from(std::env::var("OUT_DIR").unwrap()).join("propresenter.bin");
    std::fs::write(out, fds.encode_to_vec()).unwrap();

    // Shown in Settings next to the version.
    let date = std::env::var("BP_BUILD_DATE").unwrap_or_else(|_| {
        let secs = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0);
        civil_date(secs / 86400)
    });
    println!("cargo:rustc-env=BP_BUILD_DATE={date}");
    println!("cargo:rerun-if-env-changed=BP_BUILD_DATE");

    tauri_build::build();
}

// Days since 1970-01-01 → YYYY-MM-DD (Howard Hinnant's algorithm).
fn civil_date(days: u64) -> String {
    let z = days as i64 + 719468;
    let era = z.div_euclid(146097);
    let doe = z - era * 146097;
    let yoe = (doe - doe / 1460 + doe / 36524 - doe / 146096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    format!("{:04}-{:02}-{:02}", if m <= 2 { y + 1 } else { y }, m, d)
}
