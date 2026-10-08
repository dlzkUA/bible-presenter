//! ProPresenter keeps slide text as RTF in which every non-ASCII character is
//! escaped as \uN? (a decimal code point plus one fallback character). This
//! walks the control words and groups and rebuilds plain text, with \par and
//! \line as line breaks.

pub fn rtf_to_text(rtf: &str) -> String {
    let c: Vec<char> = rtf.chars().collect();
    let len = c.len();
    let mut out: Vec<u16> = Vec::new();
    let mut i = 0;
    let mut depth: i32 = 0;
    let mut skip: i32 = 0;
    let mut pending_star = false;
    let push = |out: &mut Vec<u16>, ch: char| {
        let mut b = [0u16; 2];
        out.extend_from_slice(ch.encode_utf16(&mut b));
    };

    while i < len {
        let ch = c[i];
        if ch == '{' {
            depth += 1;
            i += 1;
            continue;
        }
        if ch == '}' {
            if skip != 0 && depth == skip {
                skip = 0;
            }
            depth -= 1;
            i += 1;
            continue;
        }
        if ch == '\\' && i + 1 < len && c[i + 1] == '*' {
            pending_star = true;
            i += 2;
            continue;
        }
        if ch == '\\' {
            i += 1;
            // \uN: only when the 'u' is directly followed by a digit or minus;
            // \uc1, \ul0, \ulnone are other control words.
            if i < len && c[i] == 'u' && i + 1 < len && (c[i + 1].is_ascii_digit() || c[i + 1] == '-') {
                i += 1;
                let mut num = String::new();
                if c[i] == '-' {
                    num.push('-');
                    i += 1;
                }
                while i < len && c[i].is_ascii_digit() {
                    num.push(c[i]);
                    i += 1;
                }
                let mut code: i64 = num.parse().unwrap_or(0);
                if code < 0 {
                    code += 65536;
                }
                if skip == 0 {
                    out.push(code as u16);
                }
                if i < len && c[i] == ' ' {
                    i += 1;
                }
                // One fallback character follows (\uc1).
                if i < len {
                    i += 1;
                }
                continue;
            }
            // \'hh: one byte in the Windows code page.
            if i < len && c[i] == '\'' {
                let hex: String = c.iter().skip(i + 1).take(2).collect();
                if let Ok(b) = u8::from_str_radix(&hex, 16) {
                    if skip == 0 {
                        push(&mut out, cp1252(b));
                    }
                    i += 3;
                    continue;
                }
            }
            // Control symbols for literal characters.
            if i < len && (c[i] == '\\' || c[i] == '{' || c[i] == '}') {
                if skip == 0 {
                    push(&mut out, c[i]);
                }
                i += 1;
                continue;
            }
            let mut word = String::new();
            while i < len && c[i].is_ascii_alphabetic() {
                word.push(c[i]);
                i += 1;
            }
            while i < len && (c[i].is_ascii_digit() || c[i] == '-') {
                i += 1;
            }
            if i < len && c[i] == ' ' {
                i += 1;
            }
            if pending_star {
                skip = depth;
                pending_star = false;
            }
            match word.as_str() {
                "par" | "line" => {
                    if skip == 0 {
                        out.push('\n' as u16);
                    }
                }
                "fonttbl" | "colortbl" | "expandedcolortbl" | "listtable" | "listoverridetable" | "stylesheet" | "info" | "pict" => {
                    skip = depth;
                }
                "tab" => {
                    if skip == 0 {
                        out.push(' ' as u16);
                    }
                }
                _ => {}
            }
            continue;
        }
        if skip == 0 {
            push(&mut out, ch);
        }
        i += 1;
    }

    String::from_utf16_lossy(&out)
        .replace('\r', "")
        .split('\n')
        .map(|l| l.trim())
        .filter(|l| !l.is_empty())
        .collect::<Vec<_>>()
        .join("\n")
}

fn cp1252(b: u8) -> char {
    const HIGH: [u16; 32] = [
        0x20AC, 0x81, 0x201A, 0x0192, 0x201E, 0x2026, 0x2020, 0x2021, 0x02C6, 0x2030, 0x0160, 0x2039, 0x0152, 0x8D, 0x017D, 0x8F,
        0x90, 0x2018, 0x2019, 0x201C, 0x201D, 0x2022, 0x2013, 0x2014, 0x02DC, 0x2122, 0x0161, 0x203A, 0x0153, 0x9D, 0x017E, 0x0178,
    ];
    if (0x80..0xA0).contains(&b) {
        char::from_u32(HIGH[(b - 0x80) as usize] as u32).unwrap_or('?')
    } else {
        b as char
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn basic() {
        // Built with B (a backslash) so no tool can mistake the escapes.
        const B: char = '\\';
        let u = |n: i32| format!("{B}u{n}?");
        let rtf = format!(
            "{{{B}rtf1{B}ansi{B}ansicpg1252{{{B}fonttbl{B}f0{B}fnil Helvetica;}}{{{B}colortbl;{B}red255;}}{{{B}*{B}expandedcolortbl;;}}{B}pard{B}f0{B}fs120 {B}uc1{}{}{} {}{}{}{B}par Second line{B}line third}}",
            u(1042), u(1110), u(1076), u(1053), u(1077), u(1073)
        );
        assert_eq!(rtf_to_text(&rtf), "Від Неб\nSecond line\nthird");
        assert_eq!(rtf_to_text(r"{\rtf1 caf\'e9 \u-10179?\u-8704?}"), "café 😀");
    }
}
