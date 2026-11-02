//! Collegiapp countdowns: the pet's second island, for when no Claude chat needs it. Collegiapp (a sibling
//! app) keeps everything in one JSON snapshot, `collegiapp.json` in its app data dir, rewritten atomically on
//! every change. This reads that file (again only when it changes) and picks what is worth a pill now:
//! - a class, office hours, event or ticket, from [`CLASS_LEAD`] before it starts until it ends;
//! - work with a due time (assignments, exams, quizzes, labs, …), from [`DUE_LEAD`] before it is due.
//!
//! Done, dropped, deleted, snoozed and excluded-course items are skipped, like in Collegiapp, and so is
//! anything dismissed from the pet (settings `countdownsHidden`, keyed by id and time, so a moved class or
//! deadline comes back). Soonest first, at most [`MAX`]. The pet queues these behind every Claude chat and
//! ticks the clocks itself, so this only runs every [`TICK`]. It works whether or not Collegiapp is open, and
//! nothing is ever written back.

use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use std::path::PathBuf;
use std::time::{Duration, SystemTime};

pub const TICK: Duration = Duration::from_secs(15);
const MIN: i64 = 60_000;
pub const CLASS_LEAD: i64 = 60 * MIN;
pub const DUE_LEAD: i64 = 24 * 60 * MIN;
pub const MAX: usize = 4;
/// Collegiapp's bundle identifier (its tauri.conf.json), which names its app data dir.
const IDENT: &str = "io.github.imanimal.collegiapp";
const FILE: &str = "collegiapp.json";

/// Collegiapp's store: `COLLEGIAPP_DATA` if set (as Collegiapp itself reads it), else its app data dir,
/// e.g. `%APPDATA%\io.github.imanimal.collegiapp\collegiapp.json`.
pub fn data_path() -> Option<PathBuf> {
    if let Some(d) = std::env::var_os("COLLEGIAPP_DATA").filter(|d| !d.is_empty()) {
        return Some(PathBuf::from(d).join(FILE));
    }
    let base = if cfg!(windows) {
        std::env::var_os("APPDATA").map(PathBuf::from)
    } else if cfg!(target_os = "macos") {
        Some(crate::pets::home().join("Library/Application Support"))
    } else {
        std::env::var_os("XDG_DATA_HOME")
            .map(PathBuf::from)
            .or_else(|| Some(crate::pets::home().join(".local/share")))
    };
    base.map(|b| b.join(IDENT).join(FILE))
}

/// The installed app, where Collegiapp's installer puts it. Launching it again brings up the running copy.
pub fn app_path() -> Option<PathBuf> {
    let mut at = Vec::new();
    if cfg!(windows) {
        if let Some(d) = std::env::var_os("LOCALAPPDATA") {
            at.push(PathBuf::from(d).join("Collegiapp").join("collegiapp.exe"));
        }
    } else if cfg!(target_os = "macos") {
        at.push(PathBuf::from("/Applications/Collegiapp.app"));
        at.push(crate::pets::home().join("Applications/Collegiapp.app"));
    }
    at.into_iter().find(|p| p.exists())
}

// Only the fields used here; serde skips the rest of Collegiapp's model (crates/collegiapp-core/src/model.rs).
#[derive(Deserialize, Default)]
struct Snapshot {
    #[serde(default)]
    courses: Vec<Course>,
    #[serde(default)]
    items: Vec<Item>,
}

#[derive(Deserialize)]
struct Course {
    id: String,
    #[serde(default)]
    code: String,
    #[serde(default)]
    color: u8,
    #[serde(default = "yes")]
    included: bool,
}

fn yes() -> bool {
    true
}

#[derive(Deserialize)]
struct Item {
    id: String,
    title: String,
    #[serde(default)]
    kind: String,
    #[serde(default)]
    status: String,
    #[serde(default)]
    course_id: Option<String>,
    /// The due time, or the start for scheduled kinds.
    #[serde(default)]
    due: Option<DateTime<Utc>>,
    #[serde(default)]
    end: Option<DateTime<Utc>>,
    #[serde(default)]
    location: Option<String>,
    #[serde(default)]
    snoozed_until: Option<DateTime<Utc>>,
    #[serde(default)]
    deleted: bool,
    #[serde(default)]
    source: Source,
}

#[derive(Deserialize, Default)]
struct Source {
    #[serde(default)]
    url: Option<String>,
}

#[derive(Clone, Copy, Serialize, PartialEq, Eq, Debug)]
#[serde(rename_all = "lowercase")]
pub enum Group {
    /// Something to attend: counts down to the start, then to the end.
    Class,
    /// Something to hand in: counts down to the due time.
    Due,
}

/// One pill's worth. Times are unix ms; the pet works out the clock and the phase from them every second.
#[derive(Clone, Serialize, PartialEq, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Countdown {
    pub id: String,
    /// "<id>@<at>", what a dismissal remembers.
    pub key: String,
    pub title: String,
    /// Collegiapp's kind: "class", "assignment", "exam", …
    pub kind: String,
    pub group: Group,
    /// The course code ("CMPSC 154") and its palette index (1–6), as Collegiapp shows them.
    pub course: Option<String>,
    pub color: Option<u8>,
    pub location: Option<String>,
    /// When the pill appeared (`at` minus the lead), for the progress line.
    pub from: i64,
    /// The start, or the due time.
    pub at: i64,
    pub end: Option<i64>,
    /// The item's page (Canvas, …): a click opens it when Collegiapp isn't installed.
    #[serde(skip)]
    pub url: Option<String>,
}

/// Collegiapp's scheduled kinds (`ItemKind::is_scheduled`); everything else is work with a due time.
fn scheduled(kind: &str) -> bool {
    matches!(kind, "class" | "office_hours" | "event" | "ticket")
}

/// A course's palette index: its own (1–6), else a hash of its id, like Collegiapp's `course_color`.
fn course_color(c: &Course) -> u8 {
    if (1..=6).contains(&c.color) {
        return c.color;
    }
    let h = c.id.encode_utf16().fold(0u32, |h, u| h.wrapping_mul(31).wrapping_add(u32::from(u)));
    1 + (h % 6) as u8
}

fn pick(s: &Snapshot, now: i64, hidden: &[String]) -> Vec<Countdown> {
    let course = |id: &Option<String>| id.as_ref().and_then(|id| s.courses.iter().find(|c| &c.id == id));
    let mut v: Vec<(i64, Countdown)> = s
        .items
        .iter()
        .filter_map(|it| {
            let c = course(&it.course_id);
            if it.deleted || matches!(it.status.as_str(), "done" | "dropped") || c.is_some_and(|c| !c.included) {
                return None;
            }
            if it.snoozed_until.is_some_and(|t| t.timestamp_millis() > now) {
                return None;
            }
            let at = it.due?.timestamp_millis();
            let end = it.end.map(|e| e.timestamp_millis()).filter(|&e| e > at);
            let group = if scheduled(&it.kind) { Group::Class } else { Group::Due };
            let lead = if group == Group::Class { CLASS_LEAD } else { DUE_LEAD };
            let over = end.unwrap_or(at);
            if now >= over || at - now > lead {
                return None;
            }
            let key = format!("{}@{at}", it.id);
            if hidden.contains(&key) {
                return None;
            }
            // soonest first: the start (or due time), or the end once it is on
            let next = if now >= at { over } else { at };
            Some((
                next,
                Countdown {
                    id: it.id.clone(),
                    key,
                    title: it.title.clone(),
                    kind: if it.kind.is_empty() { "task".into() } else { it.kind.clone() },
                    group,
                    course: c.map(|c| c.code.clone()).filter(|c| !c.is_empty()),
                    color: c.map(course_color),
                    location: it.location.clone().filter(|l| !l.trim().is_empty()),
                    from: at - lead,
                    at,
                    end,
                    url: it.source.url.clone().filter(|u| u.starts_with("https://")),
                },
            ))
        })
        .collect();
    v.sort_by(|a, b| a.0.cmp(&b.0).then_with(|| a.1.title.cmp(&b.1.title)));
    v.into_iter().take(MAX).map(|(_, c)| c).collect()
}

/// Drops dismissals for things long over (a day past their start, so a dismissed class stays hidden to its end).
pub fn prune(hidden: &mut Vec<String>, now: i64) {
    hidden.retain(|k| {
        k.rsplit_once('@').and_then(|(_, t)| t.parse::<i64>().ok()).is_some_and(|t| t > now - 24 * 60 * MIN)
    });
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Status {
    pub path: String,
    pub found: bool,
    pub error: String,
    pub shown: usize,
}

/// Settings' "Preview": a class 25 minutes out and a lab due in 40 (amber already), for [`PREVIEW`] from `t0`.
fn samples(t0: i64) -> Vec<Countdown> {
    let one = |id: &str, title: &str, kind: &str, group, course: &str, color, location: Option<&str>, at: i64, end: Option<i64>| {
        let lead = if group == Group::Class { CLASS_LEAD } else { DUE_LEAD };
        Countdown {
            id: id.into(),
            key: format!("{id}@{at}"),
            title: title.into(),
            kind: kind.into(),
            group,
            course: Some(course.into()),
            color: Some(color),
            location: location.map(Into::into),
            from: at - lead,
            at,
            end,
            url: None,
        }
    };
    vec![
        one("preview-class", "CMPSC 130A Lecture", "class", Group::Class, "CMPSC 130A", 3, Some("Phelps 3526"), t0 + 25 * MIN, Some(t0 + 100 * MIN)),
        one("preview-lab", "Lab 3: PyRTL ALU", "lab", Group::Due, "CMPSC 154", 2, None, t0 + 40 * MIN, None),
    ]
}

pub const PREVIEW: i64 = MIN;

#[derive(Default)]
pub struct Reader {
    path: Option<PathBuf>,
    /// mtime and length of the last read, so an unchanged file isn't parsed again
    stamp: Option<(SystemTime, u64)>,
    snap: Option<Snapshot>,
    error: String,
    shown: Vec<Countdown>,
    /// when Settings' preview started (samples show for [`PREVIEW`])
    preview: Option<i64>,
}

impl Reader {
    /// Re-reads the store if it changed, then picks again. True when the pills changed.
    pub fn refresh(&mut self, now: i64, on: bool, hidden: &[String]) -> bool {
        let mut next = if on {
            self.load();
            self.snap.as_ref().map(|s| pick(s, now, hidden)).unwrap_or_default()
        } else {
            Vec::new()
        };
        match self.preview {
            Some(t0) if now < t0 + PREVIEW => next.extend(samples(t0).into_iter().filter(|c| !hidden.contains(&c.key))),
            _ => self.preview = None,
        }
        if next == self.shown {
            return false;
        }
        self.shown = next;
        true
    }

    fn load(&mut self) {
        if self.path.is_none() {
            self.path = data_path();
        }
        let Some(path) = &self.path else { return };
        let stamp = std::fs::metadata(path).ok().and_then(|m| Some((m.modified().ok()?, m.len())));
        if stamp.is_none() {
            // not installed yet, or the data was removed
            self.stamp = None;
            self.snap = None;
            self.error.clear();
            return;
        }
        if stamp == self.stamp {
            return;
        }
        // Collegiapp writes a temp file and renames it over, so a read never sees half a file; a failed read
        // keeps the last good snapshot and tries again next tick
        match std::fs::read(path).map_err(|e| e.to_string()).and_then(|b| serde_json::from_slice(&b).map_err(|e| e.to_string())) {
            Ok(s) => {
                self.snap = Some(s);
                self.stamp = stamp;
                self.error.clear();
            }
            Err(e) => self.error = e,
        }
    }

    pub fn list(&self) -> Vec<Countdown> {
        self.shown.clone()
    }

    pub fn start_preview(&mut self, now: i64) {
        self.preview = Some(now);
    }

    pub fn url(&self, id: &str) -> Option<String> {
        self.shown.iter().find(|c| c.id == id).and_then(|c| c.url.clone())
    }

    pub fn status(&self) -> Status {
        let path = self.path.clone().or_else(data_path);
        Status {
            path: path.as_ref().map(|p| p.to_string_lossy().to_string()).unwrap_or_default(),
            found: path.is_some_and(|p| p.exists()),
            error: self.error.clone(),
            shown: self.shown.len(),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    // 2026-10-28T20:00:00Z
    const NOW: i64 = 1_793_217_600_000;

    fn iso(ms: i64) -> String {
        DateTime::<Utc>::from_timestamp_millis(ms).unwrap().to_rfc3339()
    }

    fn snap(items: serde_json::Value) -> Snapshot {
        serde_json::from_value(serde_json::json!({
            "version": 1,
            "device_id": "d",
            "courses": [
                { "id": "cmpsc130a-f26", "code": "CMPSC 130A", "color": 0 },
                { "id": "cmpsc154-f26", "code": "CMPSC 154", "color": 2 },
                { "id": "old", "code": "CMPSC 16", "included": false }
            ],
            "items": items,
            "views": []
        }))
        .unwrap()
    }

    fn item(id: &str, kind: &str, due: i64, end: Option<i64>) -> serde_json::Value {
        let mut v = serde_json::json!({
            "id": id, "title": id, "kind": kind, "status": "todo", "due": iso(due),
            "created_at": iso(0), "updated_at": iso(0), "interrupt": "none", "tags": [], "links": []
        });
        if let Some(e) = end {
            v["end"] = iso(e).into();
        }
        v
    }

    fn ids(v: &[Countdown]) -> Vec<&str> {
        v.iter().map(|c| c.id.as_str()).collect()
    }

    #[test]
    fn classes_show_an_hour_ahead_until_they_end() {
        let s = snap(serde_json::json!([
            item("soon", "class", NOW + 45 * MIN, Some(NOW + 120 * MIN)),
            item("later", "class", NOW + 61 * MIN, Some(NOW + 120 * MIN)),
            item("on", "class", NOW - 30 * MIN, Some(NOW + 45 * MIN)),
            item("over", "class", NOW - 90 * MIN, Some(NOW - MIN)),
        ]));
        let v = pick(&s, NOW, &[]);
        // the class that is on ends in 45 min, the next one starts in 45: tie, then by title
        assert_eq!(ids(&v), ["on", "soon"]);
        assert_eq!(v[1].group, Group::Class);
        assert_eq!(v[1].from, NOW + 45 * MIN - CLASS_LEAD);
        assert_eq!(v[0].end, Some(NOW + 45 * MIN));
    }

    #[test]
    fn work_shows_a_day_ahead_until_it_is_due() {
        let s = snap(serde_json::json!([
            item("hw", "assignment", NOW + 20 * 60 * MIN, None),
            item("exam", "exam", NOW + 3 * 60 * MIN, Some(NOW + 5 * 60 * MIN)),
            item("next week", "assignment", NOW + 7 * 24 * 60 * MIN, None),
            item("late", "assignment", NOW - MIN, None),
        ]));
        let v = pick(&s, NOW, &[]);
        assert_eq!(ids(&v), ["exam", "hw"]);
        assert!(v.iter().all(|c| c.group == Group::Due));
        assert_eq!(v[1].from, NOW + 20 * 60 * MIN - DUE_LEAD);
    }

    #[test]
    fn skips_what_collegiapp_hides() {
        let mut done = item("done", "assignment", NOW + MIN, None);
        done["status"] = "done".into();
        let mut gone = item("gone", "assignment", NOW + MIN, None);
        gone["deleted"] = true.into();
        let mut snoozed = item("snoozed", "assignment", NOW + MIN, None);
        snoozed["snoozed_until"] = iso(NOW + 60 * MIN).into();
        let mut excluded = item("excluded", "class", NOW + MIN, Some(NOW + 60 * MIN));
        excluded["course_id"] = "old".into();
        let undated = serde_json::json!({ "id": "undated", "title": "t", "created_at": iso(0), "updated_at": iso(0) });
        let s = snap(serde_json::json!([done, gone, snoozed, excluded, undated, item("ok", "quiz", NOW + MIN, None)]));
        assert_eq!(ids(&pick(&s, NOW, &[])), ["ok"]);
    }

    #[test]
    fn dismissed_until_it_moves() {
        let s = snap(serde_json::json!([item("hw", "assignment", NOW + 60 * MIN, None)]));
        let key = format!("hw@{}", NOW + 60 * MIN);
        assert!(pick(&s, NOW, &[key.clone()]).is_empty());
        let moved = snap(serde_json::json!([item("hw", "assignment", NOW + 90 * MIN, None)]));
        assert_eq!(ids(&pick(&moved, NOW, &[key])), ["hw"]);
    }

    #[test]
    fn names_the_course_like_collegiapp() {
        let mut lab = item("lab", "lab", NOW + MIN, None);
        lab["course_id"] = "cmpsc154-f26".into();
        lab["location"] = "  ".into();
        let mut lec = item("lec", "class", NOW + 2 * MIN, Some(NOW + 60 * MIN));
        lec["course_id"] = "cmpsc130a-f26".into();
        lec["location"] = "Phelps 3526".into();
        lec["source"] = serde_json::json!({ "adapter": "gcal", "url": "https://calendar.google.com/x" });
        let v = pick(&snap(serde_json::json!([lab, lec])), NOW, &[]);
        assert_eq!((v[0].course.as_deref(), v[0].color, v[0].location.as_deref()), (Some("CMPSC 154"), Some(2), None));
        // ui/js/store.js: hue("cmpsc130a-f26") === 3
        assert_eq!((v[1].course.as_deref(), v[1].color), (Some("CMPSC 130A"), Some(3)));
        assert_eq!(v[1].location.as_deref(), Some("Phelps 3526"));
        assert_eq!(v[1].url.as_deref(), Some("https://calendar.google.com/x"));
    }

    #[test]
    fn keeps_the_soonest_few() {
        let items: Vec<_> = (0..6).map(|i| item(&format!("hw{i}"), "assignment", NOW + (6 - i) * 60 * MIN, None)).collect();
        let v = pick(&snap(items.into()), NOW, &[]);
        assert_eq!(ids(&v), ["hw5", "hw4", "hw3", "hw2"]);
    }

    #[test]
    fn prunes_old_dismissals() {
        let mut h = vec![format!("a@{}", NOW - 25 * 60 * MIN), format!("b@{}", NOW - 60 * MIN), "junk".into()];
        prune(&mut h, NOW);
        assert_eq!(h, [format!("b@{}", NOW - 60 * MIN)]);
    }

    #[test]
    fn reads_the_file_once_per_change() {
        let dir = std::env::temp_dir().join(format!("cc-collegiapp-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join(FILE);
        let mut r = Reader { path: Some(path.clone()), ..Default::default() };
        assert!(!r.refresh(NOW, true, &[]), "no file, nothing to show");
        assert!(!r.status().found);
        let body = serde_json::json!({ "items": [item("hw", "assignment", NOW + MIN, None)] });
        std::fs::write(&path, body.to_string()).unwrap();
        assert!(r.refresh(NOW, true, &[]));
        assert_eq!(ids(&r.list()), ["hw"]);
        assert!(!r.refresh(NOW, true, &[]), "unchanged");
        assert!(r.refresh(NOW, false, &[]), "turned off");
        assert!(r.list().is_empty());
        std::fs::write(&path, "{ half").unwrap();
        assert!(r.refresh(NOW, true, &[]), "a bad read keeps the last snapshot");
        assert_eq!(ids(&r.list()), ["hw"]);
        assert!(!r.status().error.is_empty());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn previews_for_a_minute_even_when_off() {
        let mut r = Reader { path: Some(std::env::temp_dir().join("cc-collegiapp-none").join(FILE)), ..Default::default() };
        r.start_preview(NOW);
        assert!(r.refresh(NOW, false, &[]));
        assert_eq!(ids(&r.list()), ["preview-class", "preview-lab"]);
        assert!(!r.refresh(NOW + 30_000, false, &[]), "the same samples, so no event");
        assert!(r.refresh(NOW + PREVIEW, false, &[]));
        assert!(r.list().is_empty());
    }
}
