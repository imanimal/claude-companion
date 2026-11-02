//! The tail of a Claude Code transcript (JSONL). The format is internal to Claude Code, so this only
//! looks for what the pill needs and tolerates anything else:
//!   {"type":"custom-title","customTitle":"…"}  (also "summary"/"ai-title") → the session title
//!   {"type":"assistant","message":{"content":[{"type":"text","text":"…"}]},"timestamp":"…"} → the newest chat update
//!   a user entry whose text starts "[Request interrupted by user" → the turn was stopped (no Stop hook fires)

use serde_json::Value;
use std::io::{Read, Seek, SeekFrom};
use std::path::Path;

use crate::sessions::{clean_text, truncate};

#[derive(Default, Debug)]
pub struct Tail {
    pub title: Option<String>,
    pub text: Option<(String, u64)>,
    pub interrupted_at: Option<u64>,
}

const WINDOW: u64 = 192 * 1024;

pub fn read_tail(path: &Path) -> Tail {
    let mut out = Tail::default();
    let Ok(mut f) = std::fs::File::open(path) else { return out };
    let len = f.metadata().map(|m| m.len()).unwrap_or(0);
    let start = len.saturating_sub(WINDOW);
    if f.seek(SeekFrom::Start(start)).is_err() {
        return out;
    }
    let mut buf = Vec::new();
    if f.take(WINDOW).read_to_end(&mut buf).is_err() {
        return out;
    }
    let text = String::from_utf8_lossy(&buf);
    let mut lines: Vec<&str> = text.split('\n').collect();
    if start > 0 && !lines.is_empty() {
        lines.remove(0); // cut mid-line
    }
    let mut seen_assistant_text = false;
    for line in lines.iter().rev() {
        let l = line.trim();
        if l.is_empty() {
            continue;
        }
        if out.title.is_none()
            && (l.contains("\"type\":\"custom-title\"") || l.contains("\"type\":\"ai-title\"") || l.contains("\"type\":\"summary\""))
        {
            if let Ok(v) = serde_json::from_str::<Value>(l) {
                let t = ["customTitle", "aiTitle", "title", "summary"].iter().find_map(|k| v[*k].as_str());
                if let Some(t) = t.map(str::trim).filter(|t| !t.is_empty()) {
                    out.title = Some(truncate(t, 80));
                }
            }
        } else if !seen_assistant_text && l.contains("\"type\":\"assistant\"") {
            if let Ok(v) = serde_json::from_str::<Value>(l) {
                let txt = content_text(&v["message"]["content"]);
                if !txt.is_empty() {
                    seen_assistant_text = true;
                    let at = v["timestamp"].as_str().and_then(parse_iso_ms).unwrap_or(0);
                    out.text = Some((truncate(&clean_text(&txt), 240), at));
                }
            }
        } else if !seen_assistant_text && out.interrupted_at.is_none() && l.contains("[Request interrupted by user") {
            if let Ok(v) = serde_json::from_str::<Value>(l) {
                if v["type"] == "user" {
                    out.interrupted_at = v["timestamp"].as_str().and_then(parse_iso_ms);
                }
            }
        }
        if out.title.is_some() && seen_assistant_text {
            break;
        }
    }
    out
}

fn content_text(c: &Value) -> String {
    match c {
        Value::String(s) => s.clone(),
        Value::Array(a) => a
            .iter()
            .filter(|b| b["type"] == "text")
            .filter_map(|b| b["text"].as_str())
            .collect::<Vec<_>>()
            .join(" "),
        _ => String::new(),
    }
}

/// "2026-11-01T12:31:30.781Z" → Unix ms (UTC only; that's what Claude Code writes).
pub fn parse_iso_ms(s: &str) -> Option<u64> {
    let b = s.as_bytes();
    if b.len() < 19 {
        return None;
    }
    let n = |a: usize, z: usize| s.get(a..z)?.parse::<i64>().ok();
    let (y, mo, d, h, mi, se) = (n(0, 4)?, n(5, 7)?, n(8, 10)?, n(11, 13)?, n(14, 16)?, n(17, 19)?);
    let ms = if b.get(19) == Some(&b'.') {
        let frac: String = s[20..].chars().take_while(|c| c.is_ascii_digit()).take(3).collect();
        format!("{frac:0<3}").parse::<i64>().ok()?
    } else {
        0
    };
    // days from civil (Howard Hinnant)
    let y2 = if mo <= 2 { y - 1 } else { y };
    let era = y2.div_euclid(400);
    let yoe = y2 - era * 400;
    let doy = (153 * (mo + if mo > 2 { -3 } else { 9 }) + 2) / 5 + d - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    let days = era * 146097 + doe - 719468;
    u64::try_from(((days * 24 + h) * 60 + mi) * 60_000 + se * 1000 + ms).ok()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn iso_times() {
        assert_eq!(parse_iso_ms("1970-01-01T00:00:00Z"), Some(0));
        assert_eq!(parse_iso_ms("2026-11-01T12:31:30.781Z"), Some(1_793_536_290_781));
    }

    #[test]
    fn reads_title_and_last_text() {
        let dir = std::env::temp_dir().join(format!("cc-tail-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let p = dir.join("t.jsonl");
        let lines = [
            r#"{"type":"custom-title","customTitle":"Old title","sessionId":"x"}"#,
            r#"{"type":"assistant","message":{"content":[{"type":"text","text":"First **answer**"}]},"timestamp":"2026-11-01T12:00:00.000Z"}"#,
            r#"{"type":"custom-title","customTitle":"Claude companion app","sessionId":"x"}"#,
            r#"{"type":"assistant","message":{"content":[{"type":"tool_use","name":"Bash","input":{}}]},"timestamp":"2026-11-01T12:00:05.000Z"}"#,
            r#"{"type":"assistant","message":{"content":[{"type":"text","text":"Moving on to the editor."}]},"timestamp":"2026-11-01T12:00:09.000Z"}"#,
        ];
        std::fs::write(&p, lines.join("\n")).unwrap();
        let t = read_tail(&p);
        assert_eq!(t.title.as_deref(), Some("Claude companion app"));
        let (text, at) = t.text.unwrap();
        assert_eq!(text, "Moving on to the editor.");
        assert_eq!(at, parse_iso_ms("2026-11-01T12:00:09.000Z").unwrap());
        assert!(t.interrupted_at.is_none());
        std::fs::remove_dir_all(&dir).ok();
    }
}
