//! Codex's cloud pets. Codex keeps the pets made with its Pets plugin in the ChatGPT account, not in
//! `~/.codex/pets`, so they never reach the shared folder on their own. With settings `codexSync` on, this
//! pulls them in from files Codex already keeps on this computer, with no network and no sign-in:
//! - the list: `cloud-pet-artwork-cache` in `$CODEX_HOME/.codex-global-state.json`, each pet's id, sheet
//!   version and spritesheet URL (new art gets a new URL);
//! - the sheet: the newest complete response for that URL in Codex's HTTP cache (Chromium's blockfile cache
//!   on Windows, its simple cache elsewhere);
//! - the name and description: the Pets tools' results in Codex's session logs (`$CODEX_HOME/sessions`),
//!   searched only in logs written since the pet was made (a pet id starts with its unix time in hex).
//!
//! Settings `codexPets` remembers each cloud pet's folder here and the art it was pulled with. A pet that is
//! already here is linked, not copied. When its sheet (or a backup) is that very art, it keeps its own,
//! which may be an edit. When it's linked by Codex's own migration map or by name (the newest cloud pet
//! first), Codex's art comes over. New art replaces the sheet, backed up first like an edit, and so does a
//! pet card's "Update from Codex" (an empty `art`). A pulled pet deleted here stays deleted, and nothing is
//! ever written to Codex's files.

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::{BTreeMap, HashMap, HashSet};
use std::io::{BufRead, Read};
use std::path::{Path, PathBuf};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use crate::pets;

pub const TICK: Duration = Duration::from_secs(30);
/// Pets whose name isn't in any log (made in ChatGPT, or the logs are gone).
const UNNAMED: &str = "Codex pet";

/// A cloud pet here: its folder and the art (the spritesheet URL without its signature) it was pulled with.
#[derive(Clone, Serialize, Deserialize, Debug, Default, PartialEq)]
pub struct Link {
    pub pet: String,
    pub art: String,
}

/// The latest pull, for Settings and the toast.
#[derive(Serialize, Clone, Default, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Status {
    /// Codex's state file, and whether it's there
    pub path: String,
    pub found: bool,
    /// the pets in the Codex account
    pub cloud: usize,
    /// those whose art isn't in Codex's cache yet; they come over once Codex has shown them
    pub waiting: usize,
    /// the pets this pull added or redrew, by name and by folder
    pub pulled: Vec<String>,
    #[serde(skip)]
    pub ids: Vec<String>,
    pub error: Option<String>,
}

/// When to pull: Codex's state changed, a pet is still waiting for its art, or the user asked.
#[derive(Default)]
pub struct Reader {
    seen: Option<Option<SystemTime>>,
    retry: bool,
}

impl Reader {
    pub fn due(&mut self, now: bool) -> bool {
        let t = std::fs::metadata(state_path()).and_then(|m| m.modified()).ok();
        let due = now || self.retry || self.seen != Some(t);
        self.seen = Some(t);
        due
    }

    pub fn pull(&mut self, links: &mut BTreeMap<String, Link>) -> Status {
        let st = pull(links);
        self.retry = st.waiting > 0 || st.error.is_some();
        st
    }
}

pub fn state_path() -> PathBuf {
    pets::codex_home().join(".codex-global-state.json")
}

struct Cloud {
    id: String,
    version: u64,
    art: String,
}

/// A pet id's unix time: `pet_` and 8 hex digits.
fn made(id: &str) -> Option<u64> {
    u64::from_str_radix(id.strip_prefix("pet_")?.get(..8)?, 16).ok()
}

fn cloud_pets(state: &Value) -> Vec<Cloud> {
    let list = state["electron-persisted-atom-state"]["cloud-pet-artwork-cache"]["pets"].as_array();
    list.map(|a| {
        a.iter()
            .filter_map(|p| {
                let url = p["spritesheetUrl"].as_str()?;
                Some(Cloud {
                    id: p["id"].as_str()?.to_string(),
                    version: p["spriteVersionNumber"].as_u64().unwrap_or(1),
                    art: url.split('?').next().unwrap_or(url).to_string(),
                })
            })
            .collect()
    })
    .unwrap_or_default()
}

/// Codex's own move of its local pets into the account: cloud id → the folder it came from.
fn migrated(state: &Value) -> HashMap<String, String> {
    let mut out = HashMap::new();
    let accounts = state["electron-persisted-atom-state"]["migrated-cloud-pet-ids-v1"].as_object();
    for m in accounts.into_iter().flat_map(|a| a.values()).filter_map(Value::as_object) {
        for (local, cloud) in m {
            if let (Some(dir), Some(c)) = (local.strip_prefix("custom:"), cloud.as_str()) {
                out.insert(c.to_string(), dir.to_string());
            }
        }
    }
    out
}

/// Brings Codex's cloud pets into the pets folder; `links` is settings `codexPets`, updated in place.
pub fn pull(links: &mut BTreeMap<String, Link>) -> Status {
    let path = state_path();
    let mut st = Status { path: path.to_string_lossy().to_string(), ..Default::default() };
    let Ok(text) = std::fs::read_to_string(&path) else { return st };
    st.found = true;
    let state: Value = match serde_json::from_str(&text) {
        Ok(v) => v,
        Err(e) => {
            st.error = Some(format!("Codex's state file didn't parse ({e})"));
            return st;
        }
    };
    let mut cloud = cloud_pets(&state);
    st.cloud = cloud.len();
    // newest first, so of two pets with one name the newer claims the one already here
    cloud.sort_by_key(|c| std::cmp::Reverse(made(&c.id)));
    let todo: Vec<&Cloud> = cloud.iter().filter(|c| links.get(&c.id).map_or(true, |l| l.art != c.art)).collect();
    if todo.is_empty() {
        return st;
    }
    let sheets = cached(&todo.iter().map(|c| c.art.clone()).collect());
    let moved = migrated(&state);
    let here = pets::list();
    // names for the new pets that can come over now (a pet still waiting for its art waits whole, so a retry
    // doesn't read the logs again)
    let fresh: HashSet<String> = todo
        .iter()
        .filter(|c| !links.contains_key(&c.id) && sheets.contains_key(&c.art))
        .filter(|c| !moved.get(&c.id).is_some_and(|dir| here.iter().any(|p| &p.id == dir)))
        .map(|c| c.id.clone())
        .collect();
    let names = names(&fresh, fresh.iter().filter_map(|id| made(id)).min().unwrap_or(0));
    let mut claimed: HashSet<String> = links.values().map(|l| l.pet.clone()).collect();

    for c in todo {
        let sheet = sheets.get(&c.art).map(Vec::as_slice);
        if !links.contains_key(&c.id) {
            let free = |p: &&pets::PetInfo| !claimed.contains(&p.id);
            // this very art, kept or edited here (a backup of it): nothing to pull
            if let Some(p) = sheet.and_then(|b| here.iter().filter(free).find(|p| holds(p, b))) {
                claimed.insert(p.id.clone());
                links.insert(c.id.clone(), Link { pet: p.id.clone(), art: c.art.clone() });
                continue;
            }
            let name = names.get(&c.id);
            let same = moved.get(&c.id).and_then(|dir| here.iter().filter(free).find(|p| &p.id == dir)).or_else(|| {
                let n = name?.0.to_lowercase();
                here.iter().filter(free).find(|p| p.display_name.trim().to_lowercase() == n)
            });
            if let Some(p) = same {
                // Codex's migration or the same name: an older copy, maybe, so Codex's art comes over below
                claimed.insert(p.id.clone());
                links.insert(c.id.clone(), Link { pet: p.id.clone(), art: String::new() });
            } else {
                let Some(b) = sheet else {
                    st.waiting += 1;
                    continue;
                };
                let (n, d) = name.cloned().unwrap_or_else(|| (UNNAMED.to_string(), String::new()));
                let m = json!({ "displayName": n, "description": d, "spriteVersionNumber": c.version });
                match pets::create(&n, &m, b, pets::sheet_ext(b).unwrap_or("png")) {
                    Ok(p) => {
                        claimed.insert(p.id.clone());
                        links.insert(c.id.clone(), Link { pet: p.id.clone(), art: c.art.clone() });
                        st.pulled.push(p.display_name);
                        st.ids.push(p.id);
                    }
                    Err(e) => st.error = Some(e),
                }
                continue;
            }
        }
        // art this pet doesn't have yet; a pulled pet deleted here stays deleted
        let Some(l) = links.get(&c.id).cloned() else { continue };
        if let Some(p) = pets::read(&l.pet) {
            let Some(b) = sheet else {
                st.waiting += 1;
                continue;
            };
            if std::fs::read(Path::new(&p.folder).join(&p.sheet)).ok().as_deref() != Some(b) {
                let mut m = p.manifest.clone();
                m["spriteVersionNumber"] = json!(c.version);
                if let Err(e) = pets::save(&p.id, &m, b, true) {
                    st.error = Some(e);
                    continue;
                }
                st.pulled.push(p.display_name.clone());
                st.ids.push(p.id.clone());
            }
        }
        links.insert(c.id.clone(), Link { pet: l.pet, art: c.art.clone() });
    }
    st
}

/// Whether this pet's sheet, or one of its backups, is exactly `b` (a pet copied by hand from Codex's cache).
fn holds(p: &pets::PetInfo, b: &[u8]) -> bool {
    let dir = Path::new(&p.folder);
    let mut files = vec![dir.join(&p.sheet)];
    for e in std::fs::read_dir(dir.join(".companion-backup")).into_iter().flatten().flatten() {
        files.extend(std::fs::read_dir(e.path()).into_iter().flatten().flatten().map(|f| f.path()));
    }
    files.iter().any(|f| {
        f.file_name().is_some_and(|n| n.to_string_lossy().starts_with("spritesheet."))
            && std::fs::metadata(f).is_ok_and(|m| m.len() == b.len() as u64)
            && std::fs::read(f).is_ok_and(|x| x == b)
    })
}

// ───────── Codex's HTTP cache ─────────

/// Codex's cache folders: the Microsoft Store app's (Windows keeps its AppData inside the package), then a
/// plain install's.
fn cache_dirs() -> Vec<PathBuf> {
    let mut roots = Vec::new();
    if cfg!(windows) {
        if let Some(local) = std::env::var_os("LOCALAPPDATA").map(PathBuf::from) {
            for e in std::fs::read_dir(local.join("Packages")).into_iter().flatten().flatten() {
                if e.file_name().to_string_lossy().starts_with("OpenAI.Codex_") {
                    roots.push(e.path().join("LocalCache").join("Roaming").join("Codex"));
                }
            }
        }
        if let Some(d) = std::env::var_os("APPDATA") {
            roots.push(PathBuf::from(d).join("Codex"));
        }
    } else if cfg!(target_os = "macos") {
        roots.push(pets::home().join("Library/Application Support/Codex"));
    } else {
        let config = std::env::var_os("XDG_CONFIG_HOME").map(PathBuf::from);
        roots.push(config.unwrap_or_else(|| pets::home().join(".config")).join("Codex"));
    }
    roots
        .into_iter()
        .flat_map(|r| [r.join("web/Codex/Default/Cache/Cache_Data"), r.join("Cache/Cache_Data")])
        .filter(|d| d.is_dir())
        .collect()
}

/// The newest complete body cached for each URL in `want` (URLs without their query).
fn cached(want: &HashSet<String>) -> HashMap<String, Vec<u8>> {
    let mut best: HashMap<String, (u64, Vec<u8>)> = HashMap::new();
    for dir in cache_dirs() {
        if dir.join("data_1").is_file() {
            blockfile(&dir, want, &mut best);
        } else {
            simple(&dir, want, &mut best);
        }
    }
    best.into_iter().map(|(k, (_, b))| (k, b)).collect()
}

/// The URL in a cache key ("1/0/_dk_<site> <site> <url>"), without its query.
fn art_of(key: &str) -> Option<&str> {
    let url = &key[key.find("https://")?..];
    url.split('?').next()
}

/// A whole image: a PNG through its IEND chunk, or a WebP as long as its RIFF header says.
fn complete(b: &[u8]) -> bool {
    if pets::sheet_ext(b) == Some("png") {
        return b.len() > 12 && &b[b.len() - 8..b.len() - 4] == b"IEND";
    }
    pets::sheet_ext(b) == Some("webp") && le(b, 4, 4) as usize + 8 == b.len()
}

/// A little-endian integer of `n` bytes at `at` (0 past the end).
fn le(b: &[u8], at: usize, n: usize) -> u64 {
    b.get(at..at + n).map_or(0, |s| s.iter().rev().fold(0, |v, &x| v << 8 | x as u64))
}

fn offer(best: &mut HashMap<String, (u64, Vec<u8>)>, art: &str, time: u64, body: Option<Vec<u8>>) {
    if let Some(b) = body.filter(|b| complete(b)) {
        if best.get(art).map_or(true, |(t, _)| time > *t) {
            best.insert(art.to_string(), (time, b));
        }
    }
}

const BLOCK_MAGIC: u64 = 0xC104_CAC3;
const BLOCK_HEADER: usize = 8192;
/// Chromium's base::Time counts microseconds from 1601; this many of them lie before 1970.
const WIN_EPOCH_US: u64 = 11_644_473_600_000_000;

/// Chromium's blockfile cache: entries are 256-byte `EntryStore` blocks in the data_N files that hold such
/// blocks (the key inline from byte 96, or elsewhere when long), and a body is stream 1, kept in an f_ file
/// or in blocks of another data_N file.
fn blockfile(dir: &Path, want: &HashSet<String>, best: &mut HashMap<String, (u64, Vec<u8>)>) {
    let mut data: HashMap<u64, Vec<u8>> = HashMap::new();
    for n in 0..16 {
        match std::fs::read(dir.join(format!("data_{n}"))) {
            Ok(b) if le(&b, 0, 4) == BLOCK_MAGIC => {
                data.insert(n, b);
            }
            _ => {}
        }
    }
    let read = |addr: u64, len: usize| -> Option<Vec<u8>> {
        if addr & 0x8000_0000 == 0 {
            return None;
        }
        if (addr >> 28) & 7 == 0 {
            let b = std::fs::read(dir.join(format!("f_{:06x}", addr & 0x0FFF_FFFF))).ok()?;
            return b.get(..len).map(<[u8]>::to_vec);
        }
        let size = match (addr >> 28) & 7 {
            1 => 36,
            2 => 256,
            3 => 1024,
            4 => 4096,
            _ => return None,
        };
        let at = BLOCK_HEADER + (addr & 0xFFFF) as usize * size;
        data.get(&((addr >> 16) & 0xFF))?.get(at..at + len).map(<[u8]>::to_vec)
    };
    for file in data.values().filter(|f| le(f, 12, 4) == 256) {
        for at in (BLOCK_HEADER..file.len().saturating_sub(255)).step_by(256) {
            let (state, key_len, long_key) = (le(file, at + 20, 4), le(file, at + 32, 4) as usize, le(file, at + 36, 4));
            if state != 0 || key_len == 0 || key_len > 8192 {
                continue;
            }
            let key = if long_key != 0 { read(long_key, key_len) } else { file.get(at + 96..at + 96 + key_len).map(<[u8]>::to_vec) };
            let Some(key) = key.and_then(|k| String::from_utf8(k).ok()) else { continue };
            let Some(art) = art_of(&key).filter(|a| want.contains(*a)) else { continue };
            let time = le(file, at + 24, 8).saturating_sub(WIN_EPOCH_US) / 1000;
            if best.get(art).is_some_and(|(t, _)| *t >= time) {
                continue;
            }
            offer(best, art, time, read(le(file, at + 60, 4), le(file, at + 44, 4) as usize));
        }
    }
}

const SIMPLE_MAGIC: u64 = 0xfcfb_6d1b_a772_5c30;
const SIMPLE_EOF: u64 = 0xf4fa_6f45_970d_41d8;

/// Chromium's simple cache: one `<hash>_0` file per entry, holding a 24-byte header (magic, version, key
/// length, key hash), the key, stream 1 (the body) and its 24-byte end record (magic, flags, crc, size), then
/// stream 0, the key's SHA-256 when flag 2 says so, and stream 0's end record.
fn simple(dir: &Path, want: &HashSet<String>, best: &mut HashMap<String, (u64, Vec<u8>)>) {
    for e in std::fs::read_dir(dir).into_iter().flatten().flatten() {
        if !e.file_name().to_string_lossy().ends_with("_0") {
            continue;
        }
        let Ok(mut f) = std::fs::File::open(e.path()) else { continue };
        let mut head = [0u8; 24];
        if f.read_exact(&mut head).is_err() || le(&head, 0, 8) != SIMPLE_MAGIC {
            continue;
        }
        let mut key = vec![0u8; (le(&head, 12, 4) as usize).min(8192)];
        if f.read_exact(&mut key).is_err() {
            continue;
        }
        let Some(art) = std::str::from_utf8(&key).ok().and_then(art_of).filter(|a| want.contains(*a)) else { continue };
        let time = e.metadata().and_then(|m| m.modified()).map(ms).unwrap_or(0);
        let mut rest = Vec::new();
        if f.read_to_end(&mut rest).is_ok() {
            offer(best, art, time, simple_body(&rest));
        }
    }
}

/// Stream 1 of a simple cache entry, given the file after its header and key.
fn simple_body(b: &[u8]) -> Option<Vec<u8>> {
    let end0 = b.len().checked_sub(24)?;
    let sha = if le(b, end0 + 8, 4) & 2 != 0 { 32 } else { 0 };
    let end1 = end0.checked_sub(le(b, end0 + 16, 4) as usize + sha + 24)?;
    let ok = le(b, end0, 8) == SIMPLE_EOF && le(b, end1, 8) == SIMPLE_EOF && le(b, end1 + 16, 4) as usize == end1;
    ok.then(|| b[..end1].to_vec())
}

fn ms(t: SystemTime) -> u64 {
    t.duration_since(UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or(0)
}

// ───────── names from Codex's session logs ─────────

/// The name and description of each pet in `want`, from the newest log that has them; only logs written
/// since `since` (unix s, give or take an hour) are read.
fn names(want: &HashSet<String>, since: u64) -> HashMap<String, (String, String)> {
    let mut out = HashMap::new();
    if want.is_empty() {
        return out;
    }
    let mut logs = Vec::new();
    for d in ["sessions", "archived_sessions"] {
        find_logs(&pets::codex_home().join(d), since.saturating_sub(3600) * 1000, &mut logs);
    }
    logs.sort_by(|a, b| b.0.cmp(&a.0));
    for (_, path) in logs {
        let left: HashSet<String> = want.iter().filter(|id| !out.contains_key(*id)).cloned().collect();
        if left.is_empty() {
            break;
        }
        let Ok(f) = std::fs::File::open(&path) else { continue };
        let (mut r, mut line, mut found) = (std::io::BufReader::new(f), Vec::new(), HashMap::new());
        while r.read_until(b'\n', &mut line).unwrap_or(0) > 0 {
            if let Ok(s) = std::str::from_utf8(&line) {
                if s.contains("pet_") && left.iter().any(|id| s.contains(id.as_str())) {
                    if let Ok(v) = serde_json::from_str::<Value>(s) {
                        find_names(&v, &left, &mut found);
                    }
                }
            }
            line.clear();
        }
        out.extend(found);
    }
    out
}

fn find_logs(dir: &Path, since_ms: u64, out: &mut Vec<(u64, PathBuf)>) {
    for e in std::fs::read_dir(dir).into_iter().flatten().flatten() {
        let (path, Ok(meta)) = (e.path(), e.metadata()) else { continue };
        if meta.is_dir() {
            find_logs(&path, since_ms, out);
        } else if path.extension().is_some_and(|x| x == "jsonl") {
            let t = meta.modified().map(ms).unwrap_or(0);
            if t >= since_ms {
                out.push((t, path));
            }
        }
    }
}

/// `{"id": "pet_…", "name": …, "description": …}` anywhere in a log line, including the tool results that
/// the line keeps as JSON text (sometimes after a line of plain text). The last one in the line wins.
fn find_names(v: &Value, want: &HashSet<String>, out: &mut HashMap<String, (String, String)>) {
    match v {
        Value::Object(m) => {
            if let (Some(id), Some(name)) = (m.get("id").and_then(Value::as_str), m.get("name").and_then(Value::as_str)) {
                if want.contains(id) && !name.trim().is_empty() {
                    let desc = m.get("description").and_then(Value::as_str).unwrap_or("");
                    out.insert(id.to_string(), (name.trim().to_string(), desc.to_string()));
                }
            }
            m.values().for_each(|x| find_names(x, want, out));
        }
        Value::Array(a) => a.iter().for_each(|x| find_names(x, want, out)),
        Value::String(s) if s.contains("pet_") => {
            if let (Some(a), Some(b)) = (s.find('{'), s.rfind('}')) {
                if let Ok(inner) = serde_json::from_str::<Value>(s.get(a..=b).unwrap_or("")) {
                    find_names(&inner, want, out);
                }
            }
        }
        _ => {}
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const IEND: [u8; 12] = [0, 0, 0, 0, b'I', b'E', b'N', b'D', 0xAE, 0x42, 0x60, 0x82];

    fn png(fill: u8) -> Vec<u8> {
        let mut b = b"\x89PNG\r\n\x1a\n\0\0\0\rIHDR".to_vec();
        b.extend_from_slice(&1536u32.to_be_bytes());
        b.extend_from_slice(&2288u32.to_be_bytes());
        b.extend_from_slice(&[8, 6, 0, 0, 0, fill, fill, fill, fill]);
        b.extend_from_slice(&IEND);
        b
    }

    fn temp(name: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("cc-codex-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&d);
        std::fs::create_dir_all(&d).unwrap();
        d
    }

    fn put(b: &mut [u8], at: usize, v: u64, n: usize) {
        b[at..at + n].copy_from_slice(&v.to_le_bytes()[..n]);
    }

    const URL: &str = "https://sdmntprwestus.oaiusercontent.com/files/00000000-6030/raw";

    #[test]
    fn ids_carry_their_time() {
        assert_eq!(made("pet_6ae7eb0d50588191b0ca63fd2e0ff1dc"), Some(1_793_583_885));
        assert_eq!(made("codex"), None);
        assert_eq!(art_of(&format!("1/0/_dk_app://- app://- {URL}?se=2026&sig=x")), Some(URL));
    }

    #[test]
    fn state_lists_pets_and_migrations() {
        let state = json!({ "electron-persisted-atom-state": {
            "cloud-pet-artwork-cache": { "pets": [
                { "id": "pet_6ae7eb0d", "spriteVersionNumber": 2, "spritesheetUrl": format!("{URL}?sig=1") },
                { "id": "pet_6abc3ca6" },
            ] },
            "migrated-cloud-pet-ids-v1": { "[\"acct\",\"user\"]": { "custom:codette": "pet_6abdc901" } },
        } });
        let pets = cloud_pets(&state);
        assert_eq!(pets.len(), 1);
        assert_eq!((pets[0].id.as_str(), pets[0].version, pets[0].art.as_str()), ("pet_6ae7eb0d", 2, URL));
        assert_eq!(migrated(&state).get("pet_6abdc901").map(String::as_str), Some("codette"));
    }

    #[test]
    fn blockfile_keeps_the_newest_whole_body() {
        let dir = temp("blockfile");
        let mut d1 = vec![0u8; BLOCK_HEADER + 256 * 4];
        put(&mut d1, 0, BLOCK_MAGIC, 4);
        put(&mut d1, 12, 256, 4);
        // three entries for one URL: an old whole body, a newer cut-off one, and a newer whole one inline in data_1
        let entry = |d1: &mut Vec<u8>, block: usize, time: u64, body_addr: u64, body_len: usize| {
            let at = BLOCK_HEADER + block * 256;
            let key = format!("1/0/_dk_app://- app://- {URL}?sig={block}");
            put(d1, at + 24, WIN_EPOCH_US + time * 1000, 8);
            put(d1, at + 32, key.len() as u64, 4);
            put(d1, at + 44, body_len as u64, 4);
            put(d1, at + 60, body_addr, 4);
            d1[at + 96..at + 96 + key.len()].copy_from_slice(key.as_bytes());
        };
        let old = png(1);
        std::fs::write(dir.join("f_000001"), &old).unwrap();
        entry(&mut d1, 0, 1000, 0x8000_0001, old.len());
        let cut = png(2);
        std::fs::write(dir.join("f_000002"), &cut[..cut.len() - 6]).unwrap();
        entry(&mut d1, 1, 2000, 0x8000_0002, cut.len());
        let new = png(3);
        d1[BLOCK_HEADER + 3 * 256..][..new.len()].copy_from_slice(&new);
        entry(&mut d1, 2, 3000, 0xA001_0003, new.len());
        std::fs::write(dir.join("data_1"), &d1).unwrap();
        let mut best = HashMap::new();
        blockfile(&dir, &HashSet::from([URL.to_string()]), &mut best);
        assert_eq!(best.get(URL).map(|(t, b)| (*t, b.clone())), Some((3000, new)));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn simple_cache_body() {
        let dir = temp("simple");
        let key = format!("1/0/_dk_app://- app://- {URL}?sig=1");
        let body = png(4);
        let mut f = vec![0u8; 24];
        put(&mut f, 0, SIMPLE_MAGIC, 8);
        put(&mut f, 12, key.len() as u64, 4);
        f.extend_from_slice(key.as_bytes());
        f.extend_from_slice(&body);
        let eof = |size: usize, flags: u64| {
            let mut e = vec![0u8; 24];
            put(&mut e, 0, SIMPLE_EOF, 8);
            put(&mut e, 8, flags, 4);
            put(&mut e, 16, size as u64, 4);
            e
        };
        f.extend(eof(body.len(), 0));
        f.extend_from_slice(b"HTTP/1.1 200");
        f.extend_from_slice(&[7u8; 32]);
        f.extend(eof(12, 2));
        std::fs::write(dir.join("0123456789abcdef_0"), &f).unwrap();
        let mut best = HashMap::new();
        simple(&dir, &HashSet::from([URL.to_string()]), &mut best);
        assert_eq!(best.get(URL).map(|(_, b)| b.clone()), Some(body));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn names_from_tool_results() {
        let result = json!({ "content": [], "structuredContent": { "pet": {
            "id": "pet_6ae7eb0d", "name": "Klukai", "description": "A calm, seated Klukai with her rifle." } } });
        let line = json!({ "type": "response_item", "payload": { "type": "custom_tool_call_output", "output": [
            { "type": "input_text", "text": "Script completed\nOutput:\n" },
            { "type": "input_text", "text": format!("Output:\n{result}") },
        ] } });
        let mut out = HashMap::new();
        find_names(&line, &HashSet::from(["pet_6ae7eb0d".to_string()]), &mut out);
        assert_eq!(out.get("pet_6ae7eb0d"), Some(&("Klukai".into(), "A calm, seated Klukai with her rifle.".into())));
    }
}
