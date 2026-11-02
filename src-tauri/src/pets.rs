//! Codex pets on disk, read and written in Codex's own format so both apps share one library:
//!   $CODEX_HOME/pets/<id>/pet.json      {"id","displayName","description","spritesheetPath", …}
//!   $CODEX_HOME/pets/<id>/spritesheet.* PNG or WebP, 1536×1872 (v1: 8×9 cells) or 1536×2288 (v2: 8×11)
//! Unknown manifest fields (spriteVersionNumber, rowFrames, kind, other editors' keys) are kept on save.
//! Our own extras live under "claudeCompanion" (per-frame timing), which Codex ignores.
//! The first save of a pet in a run copies the originals to <id>/.companion-backup/<unix time>/.

use serde::Serialize;
use serde_json::{json, Value};
use std::path::{Path, PathBuf};
use std::time::UNIX_EPOCH;

pub fn codex_home() -> PathBuf {
    if let Some(h) = std::env::var_os("CODEX_HOME").filter(|h| !h.is_empty()) {
        return PathBuf::from(h);
    }
    home().join(".codex")
}

pub fn home() -> PathBuf {
    std::env::var_os(if cfg!(windows) { "USERPROFILE" } else { "HOME" })
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from("."))
}

pub fn pets_dir() -> PathBuf {
    codex_home().join("pets")
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct PetInfo {
    pub id: String,
    pub display_name: String,
    pub description: String,
    /// spritesheet file name inside the pet folder
    pub sheet: String,
    /// changes when the sheet is rewritten (cache key for the pet:// URL)
    pub stamp: u64,
    pub width: u32,
    pub height: u32,
    pub folder: String,
    pub manifest: Value,
}

/// A folder name is a pet id only if it is one plain path segment.
pub fn valid_id(id: &str) -> bool {
    !id.is_empty()
        && id.len() <= 80
        && id != "."
        && id != ".."
        && id.chars().all(|c| c.is_alphanumeric() || matches!(c, '-' | '_' | '.' | ' '))
}

fn valid_file(name: &str) -> bool {
    valid_id(name) && !name.starts_with('.')
}

pub fn list() -> Vec<PetInfo> {
    let mut out = Vec::new();
    let Ok(rd) = std::fs::read_dir(pets_dir()) else { return out };
    for e in rd.flatten() {
        let id = e.file_name().to_string_lossy().to_string();
        if !valid_id(&id) || id.starts_with('.') {
            continue;
        }
        if let Some(p) = read(&id) {
            out.push(p);
        }
    }
    out.sort_by(|a, b| a.display_name.to_lowercase().cmp(&b.display_name.to_lowercase()));
    out
}

pub fn read(id: &str) -> Option<PetInfo> {
    if !valid_id(id) {
        return None;
    }
    let folder = pets_dir().join(id);
    let manifest: Value = serde_json::from_str(&std::fs::read_to_string(folder.join("pet.json")).ok()?).ok()?;
    let sheet = manifest["spritesheetPath"]
        .as_str()
        .map(|s| s.trim_start_matches("./").to_string())
        .filter(|s| valid_file(s) && folder.join(s).is_file())
        .or_else(|| {
            ["spritesheet.webp", "spritesheet.png"].iter().map(|s| s.to_string()).find(|s| folder.join(s).is_file())
        })?;
    let path = folder.join(&sheet);
    let (width, height) = image_size(&path).unwrap_or((0, 0));
    let stamp = std::fs::metadata(&path)
        .and_then(|m| m.modified())
        .ok()
        .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0);
    Some(PetInfo {
        id: id.to_string(),
        display_name: manifest["displayName"].as_str().unwrap_or(id).to_string(),
        description: manifest["description"].as_str().unwrap_or("").to_string(),
        sheet,
        stamp,
        width,
        height,
        folder: folder.to_string_lossy().to_string(),
        manifest,
    })
}

/// The pixel size from the file header (PNG IHDR, WebP VP8X / VP8L / VP8).
pub fn image_size(path: &Path) -> Option<(u32, u32)> {
    use std::io::Read;
    let mut b = [0u8; 32];
    std::fs::File::open(path).ok()?.read_exact(&mut b).ok()?;
    image_size_of(&b)
}

pub fn image_size_of(b: &[u8]) -> Option<(u32, u32)> {
    let u32be = |i: usize| u32::from_be_bytes([b[i], b[i + 1], b[i + 2], b[i + 3]]);
    let u24le = |i: usize| b[i] as u32 | (b[i + 1] as u32) << 8 | (b[i + 2] as u32) << 16;
    if b.len() >= 24 && &b[..8] == b"\x89PNG\r\n\x1a\n" {
        return Some((u32be(16), u32be(20)));
    }
    if b.len() >= 30 && &b[..4] == b"RIFF" && &b[8..12] == b"WEBP" {
        return match &b[12..16] {
            b"VP8X" => Some((1 + u24le(24), 1 + u24le(27))),
            b"VP8L" => {
                let bits = u32::from_le_bytes([b[21], b[22], b[23], b[24]]);
                Some(((bits & 0x3FFF) + 1, ((bits >> 14) & 0x3FFF) + 1))
            }
            b"VP8 " => Some((
                u16::from_le_bytes([b[26], b[27]]) as u32 & 0x3FFF,
                u16::from_le_bytes([b[28], b[29]]) as u32 & 0x3FFF,
            )),
            _ => None,
        };
    }
    None
}

fn now_secs() -> u64 {
    std::time::SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0)
}

fn write_atomic(path: &Path, bytes: &[u8]) -> std::io::Result<()> {
    let tmp = path.with_extension("companion-tmp");
    std::fs::write(&tmp, bytes)?;
    std::fs::rename(&tmp, path)
}

fn backup(folder: &Path, sheet: &str) -> std::io::Result<()> {
    let dir = folder.join(".companion-backup").join(now_secs().to_string());
    std::fs::create_dir_all(&dir)?;
    for f in ["pet.json", sheet] {
        let src = folder.join(f);
        if src.is_file() {
            std::fs::copy(&src, dir.join(f))?;
        }
    }
    Ok(())
}

/// Writes an edited pet: the sheet as spritesheet.png and the manifest (pointing at it).
/// `backup_first` copies the current files aside before anything is overwritten.
pub fn save(id: &str, manifest: &Value, png: &[u8], backup_first: bool) -> Result<PetInfo, String> {
    let cur = read(id).ok_or("That pet folder is gone")?;
    if image_size_of(png).is_none() {
        return Err("The spritesheet isn't a PNG".into());
    }
    let folder = pets_dir().join(id);
    if backup_first {
        backup(&folder, &cur.sheet).map_err(|e| format!("Couldn't back up the pet: {e}"))?;
    }
    let mut m = manifest.clone();
    if !m.is_object() {
        m = json!({});
    }
    m["id"] = json!(id);
    m["spritesheetPath"] = json!("spritesheet.png");
    write_atomic(&folder.join("spritesheet.png"), png).map_err(|e| e.to_string())?;
    let text = serde_json::to_string_pretty(&m).map_err(|e| e.to_string())? + "\n";
    write_atomic(&folder.join("pet.json"), text.as_bytes()).map_err(|e| e.to_string())?;
    if cur.sheet != "spritesheet.png" {
        // the old sheet is in the backup (or the user said not to keep one); Codex reads spritesheetPath
        let _ = std::fs::remove_file(folder.join(&cur.sheet));
    }
    read(id).ok_or_else(|| "Saved, but the pet couldn't be read back".into())
}

pub fn slug(name: &str) -> String {
    let mut s = String::new();
    for c in name.trim().to_lowercase().chars() {
        if c.is_alphanumeric() {
            s.push(c);
        } else if !s.ends_with('-') {
            s.push('-');
        }
    }
    let s = s.trim_matches('-').chars().take(48).collect::<String>();
    if s.is_empty() { "pet".into() } else { s }
}

/// A new pet folder (import or "save as copy"). Returns its info.
pub fn create(name: &str, manifest: &Value, sheet: &[u8], ext: &str) -> Result<PetInfo, String> {
    if image_size_of(sheet).is_none() {
        return Err("That file isn't a PNG or WebP image".into());
    }
    let root = pets_dir();
    std::fs::create_dir_all(&root).map_err(|e| e.to_string())?;
    let base = slug(name);
    let mut id = base.clone();
    let mut n = 2;
    while root.join(&id).exists() {
        id = format!("{base}-{n}");
        n += 1;
    }
    let folder = root.join(&id);
    std::fs::create_dir_all(&folder).map_err(|e| e.to_string())?;
    let file = if ext == "webp" { "spritesheet.webp" } else { "spritesheet.png" };
    let mut m = if manifest.is_object() { manifest.clone() } else { json!({}) };
    m["id"] = json!(id);
    if m["displayName"].as_str().map_or(true, str::is_empty) {
        m["displayName"] = json!(name.trim());
    }
    if m["description"].as_str().is_none() {
        m["description"] = json!("");
    }
    m["spritesheetPath"] = json!(file);
    std::fs::write(folder.join(file), sheet).map_err(|e| e.to_string())?;
    let text = serde_json::to_string_pretty(&m).map_err(|e| e.to_string())? + "\n";
    std::fs::write(folder.join("pet.json"), text).map_err(|e| e.to_string())?;
    read(&id).ok_or_else(|| "Created, but the pet couldn't be read back".into())
}

/// Serves `pet://localhost/<id>/<file>` (http://pet.localhost/… on Windows) from the pets dir.
pub fn serve(path: &str) -> (u16, &'static str, Vec<u8>) {
    let parts: Vec<String> = path
        .trim_start_matches('/')
        .split('?')
        .next()
        .unwrap_or("")
        .split('/')
        .map(crate::sessions::form_decode)
        .collect();
    let [id, file] = parts.as_slice() else { return (404, "text/plain", b"not found".to_vec()) };
    if !valid_id(id) || !valid_file(file) {
        return (400, "text/plain", b"bad path".to_vec());
    }
    let mime = match file.rsplit('.').next().unwrap_or("").to_ascii_lowercase().as_str() {
        "png" => "image/png",
        "webp" => "image/webp",
        "json" => "application/json",
        _ => "application/octet-stream",
    };
    match std::fs::read(pets_dir().join(id).join(file)) {
        Ok(b) => (200, mime, b),
        Err(_) => (404, "text/plain", b"not found".to_vec()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ids_and_slugs() {
        assert!(valid_id("casual-scarlet"));
        assert!(!valid_id("../x"));
        assert!(!valid_id("a/b"));
        assert_eq!(slug("Casual Scarlet (copy)"), "casual-scarlet-copy");
        assert_eq!(slug("简杜"), "简杜");
    }

    #[test]
    fn png_size() {
        let mut b = b"\x89PNG\r\n\x1a\n\0\0\0\rIHDR".to_vec();
        b.extend_from_slice(&1536u32.to_be_bytes());
        b.extend_from_slice(&2288u32.to_be_bytes());
        b.extend_from_slice(&[8, 6, 0, 0, 0, 0, 0, 0]);
        assert_eq!(image_size_of(&b), Some((1536, 2288)));
    }
}
