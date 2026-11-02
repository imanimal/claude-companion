//! Claude sessions as the pet sees them: one entry per Claude Code session, fed by hook events
//! (bridge.rs), Claude's own progress estimates and the session transcript (transcript.rs).
//!
//! States are Codex's five, with its priority (what needs you first):
//!   waiting (Needs input) > failed (Blocked) > review (Ready) > running (Running) > idle (hidden).
//! Hook events drive them:
//!   UserPromptSubmit → running, a new turn (progress resets)
//!   PreToolUse → running; the subtitle becomes the tool activity, or the plan step
//!   PermissionRequest, Notification(permission_prompt | elicitation_dialog) → waiting
//!   PostToolUse(Failure), PermissionDenied → back to running if it was waiting
//!   Stop → review with the last assistant message; StopFailure → failed; SessionEnd → gone
//! The list goes: sessions that need you (needs input, then blocked), the ones still working with the most
//! progressed first (no estimate sorts last), then finished ones at the back, newest first. The pet's own
//! animation follows the most urgent session.
//! Progress is Claude's estimate when it sent one this turn (`curl …/p -d p=40 -d "t=…"`, read from the
//! PreToolUse command or the request itself), else the plan (update_plan / TodoWrite) done/total.
//! Chats the Claude desktop app started also carry its own id for the chat (`host_session_id`, added by the
//! bridge), so a click opens that chat (`chat_url`); terminal chats open the app.

use serde::Serialize;
use serde_json::Value;
use std::collections::HashMap;
use std::path::Path;

use crate::transcript;

pub const PORT: u16 = 47811;
const MIN: u64 = 60_000;

#[derive(Clone, Copy, Serialize, PartialEq, Eq, Debug)]
#[serde(rename_all = "lowercase")]
pub enum Status {
    Running,
    Waiting,
    Failed,
    Review,
    Idle,
}

#[derive(Clone, Debug, Default)]
struct Plan {
    /// (step, 0 pending · 1 in progress · 2 done)
    items: Vec<(String, u8)>,
}

impl Plan {
    fn set(&mut self, items: &[Value], key: &str) {
        self.items = items
            .iter()
            .map(|it| {
                let st = match it["status"].as_str().unwrap_or("") {
                    "completed" => 2,
                    "in_progress" => 1,
                    _ => 0,
                };
                (it[key].as_str().unwrap_or("").to_string(), st)
            })
            .collect();
    }
    fn advance(&mut self) {
        if let Some(i) = self.items.iter().position(|x| x.1 == 1) {
            self.items[i].1 = 2;
        }
        if let Some(n) = self.items.iter_mut().find(|x| x.1 == 0) {
            n.1 = 1;
        }
    }
    fn update_plan(&mut self, input: &Value) {
        if let Some(items) = input["items"].as_array() {
            self.set(items, "content");
            return;
        }
        if input["advance"].as_bool() == Some(true) {
            self.advance();
        }
        if let Some(done) = input["done"].as_array() {
            for n in done.iter().filter_map(Value::as_u64) {
                if let Some(x) = self.items.get_mut((n as usize).wrapping_sub(1)) {
                    x.1 = 2;
                }
            }
        }
        if let Some(n) = input["start"].as_u64() {
            for x in self.items.iter_mut().filter(|x| x.1 == 1) {
                x.1 = 0;
            }
            if let Some(x) = self.items.get_mut((n as usize).wrapping_sub(1)) {
                x.1 = 1;
            }
        }
    }
    fn progress(&self) -> Option<u8> {
        if self.items.is_empty() {
            return None;
        }
        let done = self.items.iter().filter(|x| x.1 == 2).count() as f64;
        let half = self.items.iter().filter(|x| x.1 == 1).count() as f64 * 0.4;
        Some((((done + half) / self.items.len() as f64) * 100.0).round().min(95.0) as u8)
    }
    fn current(&self) -> Option<&str> {
        self.items.iter().find(|x| x.1 == 1).map(|x| x.0.as_str()).filter(|s| !s.is_empty())
    }
}

#[derive(Clone, Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Session {
    pub id: String,
    pub title: String,
    pub cwd: String,
    pub status: Status,
    /// What the pill's second line shows: the latest chat update, or what Claude is doing.
    pub subtitle: String,
    pub progress: Option<u8>,
    /// Claude's own short label for the current phase (from its progress call).
    pub step: Option<String>,
    pub turn_started_at: u64,
    pub updated_at: u64,
    /// The desktop app's id for this chat (`local_…`) when the app started it; None for terminal chats.
    pub host_session: Option<String>,
    #[serde(skip)]
    transcript: Option<String>,
    #[serde(skip)]
    transcript_len: u64,
    #[serde(skip)]
    title_explicit: bool,
    #[serde(skip)]
    prompt_title: String,
    #[serde(skip)]
    estimate: Option<(u8, u64)>,
    #[serde(skip)]
    plan: Plan,
    #[serde(skip)]
    tool_at: u64,
    #[serde(skip)]
    text_at: u64,
    #[serde(skip)]
    stopped_at: u64,
}

impl Session {
    /// Where it goes in the list: 0 needs input, 1 blocked, 2 working, 3 done.
    fn group(&self) -> u8 {
        match self.status {
            Status::Waiting => 0,
            Status::Failed => 1,
            Status::Running | Status::Idle => 2,
            Status::Review => 3,
        }
    }

    /// Progress for ordering within a group; no estimate is -1.
    fn completion(&self) -> i16 {
        self.progress.map_or(-1, i16::from)
    }

    fn new(id: &str, now: u64) -> Self {
        Session {
            id: id.to_string(),
            title: String::new(),
            cwd: String::new(),
            status: Status::Idle,
            subtitle: String::new(),
            progress: None,
            step: None,
            turn_started_at: now,
            updated_at: now,
            host_session: None,
            transcript: None,
            transcript_len: 0,
            title_explicit: false,
            prompt_title: String::new(),
            estimate: None,
            plan: Plan::default(),
            tool_at: 0,
            text_at: 0,
            stopped_at: 0,
        }
    }

    fn refresh_progress(&mut self) {
        self.progress = match self.status {
            Status::Review => Some(100),
            _ => match self.estimate {
                Some((p, at)) if at >= self.turn_started_at => Some(p),
                _ => self.plan.progress(),
            },
        };
    }

    fn fallback_title(&self) -> String {
        if !self.prompt_title.is_empty() {
            return self.prompt_title.clone();
        }
        Path::new(&self.cwd)
            .file_name()
            .map(|s| s.to_string_lossy().to_string())
            .unwrap_or_else(|| "Claude".into())
    }

    /// Re-read the transcript tail: the session title, the newest assistant text, an interrupt.
    fn rescan(&mut self, now: u64) -> bool {
        let Some(path) = self.transcript.clone() else { return false };
        let len = std::fs::metadata(&path).map(|m| m.len()).unwrap_or(0);
        if len == self.transcript_len {
            return false;
        }
        self.transcript_len = len;
        let tail = transcript::read_tail(Path::new(&path));
        let mut changed = false;
        if !self.title_explicit {
            if let Some(t) = tail.title.filter(|t| *t != self.title) {
                self.title = t;
                changed = true;
            }
        }
        if let Some((text, at)) = tail.text {
            if at >= self.turn_started_at && at > self.text_at && self.status == Status::Running {
                self.text_at = at;
                if at >= self.tool_at {
                    self.subtitle = text;
                    changed = true;
                }
            }
        }
        if let Some(at) = tail.interrupted_at {
            if self.status == Status::Running && at >= self.turn_started_at {
                self.status = Status::Idle;
                self.subtitle = "Interrupted".into();
                self.updated_at = now;
                changed = true;
            }
        }
        changed
    }
}

#[derive(Default)]
pub struct Sessions {
    map: HashMap<String, Session>,
    /// The last progress read from a hook (value, time), so the matching HTTP call isn't applied twice.
    hook_progress: Option<(u8, u64)>,
}

impl Sessions {
    /// Applies one Claude Code hook payload. Returns true when anything the pet shows changed.
    pub fn apply_hook(&mut self, v: &Value, now: u64) -> bool {
        let ev = v["hook_event_name"].as_str().unwrap_or("");
        let Some(sid) = v["session_id"].as_str().filter(|s| !s.is_empty()) else { return false };
        if ev == "SessionEnd" {
            return self.map.remove(sid).is_some();
        }
        let s = self.map.entry(sid.to_string()).or_insert_with(|| Session::new(sid, now));
        if let Some(c) = v["cwd"].as_str() {
            s.cwd = c.to_string();
        }
        if let Some(t) = v["transcript_path"].as_str().filter(|t| !t.is_empty()) {
            if s.transcript.as_deref() != Some(t) {
                s.transcript = Some(t.to_string());
                s.transcript_len = 0;
            }
        }
        if let Some(t) = v["session_title"].as_str().map(str::trim).filter(|t| !t.is_empty()) {
            s.title = t.to_string();
            s.title_explicit = true;
        }
        if let Some(h) = v["host_session_id"].as_str().filter(|h| valid_host_session(h)) {
            s.host_session = Some(h.to_string());
        }
        let tool = v["tool_name"].as_str().unwrap_or("");
        let input = &v["tool_input"];
        match ev {
            "UserPromptSubmit" => {
                s.status = Status::Running;
                s.turn_started_at = now;
                s.estimate = None;
                s.step = None;
                s.plan = Plan::default();
                s.tool_at = 0;
                s.text_at = 0;
                s.subtitle = "Thinking".into();
                if let Some(p) = v["prompt"].as_str() {
                    let line = clean_text(p.lines().find(|l| !l.trim().is_empty()).unwrap_or(""));
                    if !line.is_empty() && !line.starts_with('<') {
                        s.prompt_title = truncate(&line, 60);
                    }
                }
            }
            "PreToolUse" => {
                // async hooks can land out of order: a tool event right after Stop belongs to that turn
                if s.status != Status::Running && now.saturating_sub(s.stopped_at) < 2500 {
                    return false;
                }
                if s.status != Status::Running {
                    if s.status != Status::Waiting {
                        s.turn_started_at = now;
                        s.estimate = None;
                    }
                    s.status = Status::Running;
                }
                if let Some((p, t)) = progress_from_tool(tool, input) {
                    s.estimate = Some((p, now));
                    if t.is_some() {
                        s.step = t;
                    }
                    self.hook_progress = Some((p, now));
                } else {
                    match tool {
                        "TodoWrite" => {
                            if let Some(items) = input["todos"].as_array() {
                                s.plan.set(items, "content");
                            }
                        }
                        "mcp__ccd_turn__update_plan" => s.plan.update_plan(input),
                        _ => {}
                    }
                    s.subtitle = match s.plan.current() {
                        Some(c) if is_plan_tool(tool) => c.to_string(),
                        _ => describe_tool(tool, input),
                    };
                    s.tool_at = now;
                }
            }
            "PermissionRequest" => {
                s.status = Status::Waiting;
                s.subtitle = format!("Allow: {}", describe_tool(tool, input));
            }
            "Notification" => match v["notification_type"].as_str().unwrap_or("") {
                "permission_prompt" | "elicitation_dialog" => {
                    s.status = Status::Waiting;
                    if let Some(m) = v["message"].as_str() {
                        s.subtitle = truncate(&clean_text(m), 160);
                    }
                }
                _ => return false,
            },
            "PostToolUse" | "PostToolUseFailure" | "PermissionDenied" => {
                if s.status != Status::Waiting {
                    return false;
                }
                s.status = Status::Running;
                s.subtitle = describe_tool(tool, input);
            }
            "Stop" => {
                s.status = Status::Review;
                s.stopped_at = now;
                let last = v["last_assistant_message"].as_str().map(clean_text).unwrap_or_default();
                s.subtitle = if last.is_empty() { "Done".into() } else { truncate(&last, 240) };
            }
            "StopFailure" => {
                s.status = Status::Failed;
                s.stopped_at = now;
                let msg = ["error", "message", "reason"]
                    .iter()
                    .find_map(|k| v[*k].as_str())
                    .map(clean_text)
                    .unwrap_or_default();
                s.subtitle = if msg.is_empty() { "Stopped on an error".into() } else { truncate(&msg, 160) };
            }
            "SessionStart" => {}
            _ => return false,
        }
        s.updated_at = now;
        s.rescan(now);
        if s.title.is_empty() {
            s.title = s.fallback_title();
        }
        s.refresh_progress();
        true
    }

    /// Claude's progress call reaching the HTTP endpoint. Skipped when the PreToolUse hook of the same
    /// command already applied it (that one knows the session); otherwise it goes to the newest running one.
    pub fn apply_progress(&mut self, p: u8, step: Option<String>, now: u64) -> bool {
        if let Some((hp, at)) = self.hook_progress {
            if hp == p && now.saturating_sub(at) < 8000 {
                return false;
            }
        }
        let Some(s) = self
            .map
            .values_mut()
            .filter(|s| s.status == Status::Running)
            .max_by_key(|s| s.updated_at)
        else {
            return false;
        };
        s.estimate = Some((p.min(100), now));
        if step.is_some() {
            s.step = step;
        }
        s.updated_at = now;
        s.refresh_progress();
        true
    }

    /// Where a click on a chat goes: that chat in the Claude desktop app when the app started it, else the
    /// app itself. `continue` opens exactly this chat; `needs-input` would open another chat that's waiting
    /// on a permission when the app doesn't count this one (a question, say), so it's not used.
    pub fn chat_url(&self, id: &str) -> String {
        match self.map.get(id).and_then(|s| s.host_session.as_deref()).filter(|h| valid_host_session(h)) {
            Some(h) => format!("claude://code/continue?session={h}"),
            None => "claude://".into(),
        }
    }

    pub fn dismiss(&mut self, id: &str) -> bool {
        match self.map.get_mut(id) {
            Some(s) if s.status != Status::Running => {
                s.status = Status::Idle;
                true
            }
            _ => false,
        }
    }

    /// Every 1.5 s: follow the transcripts of live sessions and let old states lapse (Codex expires
    /// finished notifications too). Interrupts don't fire Stop, so the transcript is how we see them.
    pub fn tick(&mut self, now: u64) -> bool {
        let mut changed = false;
        for s in self.map.values_mut() {
            if matches!(s.status, Status::Running | Status::Waiting) && s.rescan(now) {
                s.refresh_progress();
                changed = true;
            }
            let age = now.saturating_sub(s.updated_at);
            let lapse = match s.status {
                Status::Running => 30 * MIN,
                Status::Review => 45 * MIN,
                Status::Failed => 60 * MIN,
                Status::Waiting => 120 * MIN,
                Status::Idle => u64::MAX,
            };
            if age > lapse {
                s.status = Status::Idle;
                changed = true;
            }
        }
        let before = self.map.len();
        self.map.retain(|_, s| s.status != Status::Idle || now.saturating_sub(s.updated_at) < 24 * 60 * MIN);
        changed || self.map.len() != before
    }

    /// The sessions worth showing, most urgent first (Codex: priority, then the newest).
    pub fn list(&self) -> Vec<Session> {
        let mut v: Vec<Session> =
            self.map.values().filter(|s| s.status != Status::Idle).cloned().collect();
        v.sort_by(|a, b| {
            a.group()
                .cmp(&b.group())
                .then(b.completion().cmp(&a.completion()))
                .then(b.updated_at.cmp(&a.updated_at))
                .then(a.id.cmp(&b.id))
        });
        v
    }
}

/// The desktop app's chat ids, as its claude://code links accept them: `^local_[A-Za-z0-9-]{1,64}$`.
pub fn valid_host_session(id: &str) -> bool {
    id.strip_prefix("local_")
        .is_some_and(|r| (1..=64).contains(&r.len()) && r.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-'))
}

fn is_plan_tool(tool: &str) -> bool {
    tool == "TodoWrite" || tool == "mcp__ccd_turn__update_plan"
}

/// Reads Claude's progress call out of a shell command: `curl -s -m 1 127.0.0.1:47811/p -d p=40 -d "t=Building"`
/// (also `?p=40&t=Building+it`). Returns (percent, label).
pub fn progress_from_command(cmd: &str) -> Option<(u8, Option<String>)> {
    let marker = format!(":{PORT}/p");
    let i = cmd.find(&marker)?;
    let rest = &cmd[i + marker.len()..];
    if rest.starts_with(|c: char| c.is_ascii_alphanumeric()) {
        return None;
    }
    let p = field(rest, "p")?.parse::<u32>().ok()?.min(100) as u8;
    let t = field(rest, "t").map(|t| truncate(&clean_text(&t), 60)).filter(|t| !t.is_empty());
    Some((p, t))
}

fn progress_from_tool(tool: &str, input: &Value) -> Option<(u8, Option<String>)> {
    if !matches!(tool, "Bash" | "PowerShell") {
        return None;
    }
    progress_from_command(input["command"].as_str()?)
}

/// `name=value` in a command line or a form body: the value runs to the matching quote, `&` or the end.
fn field(s: &str, name: &str) -> Option<String> {
    let pat = format!("{name}=");
    let mut from = 0;
    while let Some(j) = s[from..].find(&pat) {
        let at = from + j;
        let before = s[..at].chars().last();
        if before.map_or(true, |c| !c.is_ascii_alphanumeric() && c != '_' && c != '-') {
            let quote = before.filter(|c| *c == '"' || *c == '\'');
            let val = &s[at + pat.len()..];
            let end = val
                .find(|c: char| match quote {
                    Some(q) => c == q,
                    None => c == '&' || c == '"' || c == '\'' || c.is_whitespace(),
                })
                .unwrap_or(val.len());
            return Some(form_decode(&val[..end]));
        }
        from = at + pat.len();
    }
    None
}

pub fn form_decode(s: &str) -> String {
    let hex = |c: u8| (c as char).to_digit(16).map(|d| d as u8);
    let b = s.as_bytes();
    let mut out = Vec::with_capacity(b.len());
    let mut i = 0;
    while i < b.len() {
        match b[i] {
            b'+' => out.push(b' '),
            b'%' if i + 2 < b.len() => match (hex(b[i + 1]), hex(b[i + 2])) {
                (Some(h), Some(l)) => {
                    out.push(h * 16 + l);
                    i += 2;
                }
                _ => out.push(b'%'),
            },
            c => out.push(c),
        }
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

/// Form body or query string → (p, t).
pub fn parse_form(s: &str) -> (Option<u8>, Option<String>) {
    let mut p = None;
    let mut t = None;
    for pair in s.split('&') {
        let (k, v) = pair.split_once('=').unwrap_or((pair, ""));
        match k.trim() {
            "p" => p = form_decode(v).trim().parse::<u32>().ok().map(|n| n.min(100) as u8),
            "t" => t = Some(truncate(&clean_text(&form_decode(v)), 60)).filter(|t| !t.is_empty()),
            _ => {}
        }
    }
    (p, t)
}

fn base(p: &str) -> String {
    p.rsplit(['/', '\\']).next().unwrap_or(p).to_string()
}

/// A tool call in a few words, the way Codex words its activity line.
pub fn describe_tool(tool: &str, input: &Value) -> String {
    let s = |k: &str| input[k].as_str().unwrap_or("").trim().to_string();
    let out = match tool {
        "Bash" | "PowerShell" => {
            let d = s("description");
            if !d.is_empty() {
                d
            } else {
                let c = s("command");
                format!("Running {}", truncate(c.lines().next().unwrap_or(""), 48))
            }
        }
        "Read" => format!("Reading {}", base(&s("file_path"))),
        "Edit" | "MultiEdit" => format!("Editing {}", base(&s("file_path"))),
        "Write" => format!("Writing {}", base(&s("file_path"))),
        "NotebookEdit" => format!("Editing {}", base(&s("notebook_path"))),
        "Grep" => format!("Searching for “{}”", truncate(&s("pattern"), 40)),
        "Glob" => format!("Finding {}", truncate(&s("pattern"), 40)),
        "WebFetch" => format!("Reading {}", s("url").split('/').nth(2).unwrap_or("a page")),
        "WebSearch" => format!("Searching the web for “{}”", truncate(&s("query"), 40)),
        "Agent" | "Task" => {
            let d = s("description");
            if d.is_empty() { "Running an agent".into() } else { format!("Agent: {d}") }
        }
        "Skill" => format!("Using the {} skill", s("skill")),
        "TodoWrite" | "mcp__ccd_turn__update_plan" => "Planning".into(),
        "mcp__ccd_turn__wrap_up" => "Wrapping up".into(),
        "ToolSearch" => "Loading tools".into(),
        "AskUserQuestion" => "Asking you a question".into(),
        t if t.starts_with("mcp__") => {
            let name = t.rsplit("__").next().unwrap_or(t).replace('_', " ");
            let mut c = name.chars();
            match c.next() {
                Some(f) => format!("{}{}", f.to_uppercase(), c.as_str()),
                None => "Using a tool".into(),
            }
        }
        "" => "Working".into(),
        t => format!("Using {t}"),
    };
    truncate(&out, 80)
}

/// One readable line: markdown marks and runs of whitespace go, links keep their text.
pub fn clean_text(s: &str) -> String {
    let mut out = String::with_capacity(s.len().min(600));
    let mut chars = s.chars().take(4000).peekable();
    let mut last_space = true;
    while let Some(c) = chars.next() {
        match c {
            '*' | '`' | '[' => {}
            '#' | '>' if last_space => {}
            '-' | '+' if last_space && chars.peek() == Some(&' ') => {}
            '_' if chars.peek() == Some(&'_') => {
                chars.next();
            }
            ']' if chars.peek() == Some(&'(') => {
                for d in chars.by_ref() {
                    if d == ')' {
                        break;
                    }
                }
            }
            c if c.is_whitespace() => {
                if !last_space {
                    out.push(' ');
                    last_space = true;
                }
            }
            c => {
                out.push(c);
                last_space = false;
            }
        }
    }
    out.trim().trim_start_matches(['-', ' ']).to_string()
}

pub fn truncate(s: &str, n: usize) -> String {
    if s.chars().count() <= n {
        return s.to_string();
    }
    let mut t: String = s.chars().take(n.saturating_sub(1)).collect();
    t = t.trim_end().to_string();
    t.push('…');
    t
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn ev(name: &str, extra: Value) -> Value {
        let mut v = json!({ "hook_event_name": name, "session_id": "s1", "cwd": "C:\\work\\collegiapp" });
        if let (Some(o), Some(e)) = (v.as_object_mut(), extra.as_object()) {
            for (k, x) in e {
                o.insert(k.clone(), x.clone());
            }
        }
        v
    }

    #[test]
    fn reads_progress_calls() {
        let c = r#"curl -s -m 1 127.0.0.1:47811/p -d p=40 -d "t=Building the editor" >/dev/null"#;
        assert_eq!(progress_from_command(c), Some((40, Some("Building the editor".into()))));
        let q = r#"curl.exe -s "http://127.0.0.1:47811/p?p=85&t=Wiring+hooks""#;
        assert_eq!(progress_from_command(q), Some((85, Some("Wiring hooks".into()))));
        assert_eq!(progress_from_command("curl 127.0.0.1:47811/p -d p=250"), Some((100, None)));
        assert_eq!(progress_from_command("curl 127.0.0.1:47811/ping"), None);
        assert_eq!(progress_from_command("echo p=4"), None);
        assert_eq!(parse_form("p=12&t=Reading%20files"), (Some(12), Some("Reading files".into())));
    }

    #[test]
    fn walks_a_turn_like_codex() {
        let mut s = Sessions::default();
        assert!(s.apply_hook(&ev("UserPromptSubmit", json!({"prompt": "Fix the build please"})), 1000));
        let l = s.list();
        assert_eq!(l[0].status, Status::Running);
        assert_eq!(l[0].title, "Fix the build please");
        assert_eq!(l[0].subtitle, "Thinking");

        let call = json!({"tool_name": "Bash", "tool_input": {"command": "curl -s -m 1 127.0.0.1:47811/p -d p=30 -d \"t=Reading code\""}});
        s.apply_hook(&ev("PreToolUse", call), 2000);
        assert_eq!(s.list()[0].progress, Some(30));
        assert_eq!(s.list()[0].step.as_deref(), Some("Reading code"));
        assert!(!s.apply_progress(30, None, 2100), "the hook already applied this call");

        s.apply_hook(&ev("PreToolUse", json!({"tool_name": "Edit", "tool_input": {"file_path": "C:\\x\\app.js"}})), 3000);
        assert_eq!(s.list()[0].subtitle, "Editing app.js");

        s.apply_hook(&ev("PermissionRequest", json!({"tool_name": "Bash", "tool_input": {"command": "rm x", "description": "Remove x"}})), 4000);
        assert_eq!(s.list()[0].status, Status::Waiting);
        s.apply_hook(&ev("PostToolUse", json!({"tool_name": "Bash", "tool_input": {}})), 5000);
        assert_eq!(s.list()[0].status, Status::Running);

        s.apply_hook(&ev("Stop", json!({"last_assistant_message": "**Fixed** the build. Run `cargo test`."})), 6000);
        let l = s.list();
        assert_eq!(l[0].status, Status::Review);
        assert_eq!(l[0].progress, Some(100));
        assert_eq!(l[0].subtitle, "Fixed the build. Run cargo test.");
        // a late async PreToolUse from the finished turn doesn't reopen it
        assert!(!s.apply_hook(&ev("PreToolUse", json!({"tool_name": "Read", "tool_input": {}})), 6500));
        assert!(s.dismiss("s1"));
        assert!(s.list().is_empty());
    }

    #[test]
    fn plan_progress_is_the_fallback() {
        let mut s = Sessions::default();
        s.apply_hook(&ev("UserPromptSubmit", json!({"prompt": "go"})), 1000);
        let items = json!({"items": [
            {"content": "Read", "status": "in_progress"}, {"content": "Write", "status": "pending"},
            {"content": "Test", "status": "pending"}, {"content": "Ship", "status": "pending"}]});
        s.apply_hook(&ev("PreToolUse", json!({"tool_name": "mcp__ccd_turn__update_plan", "tool_input": items})), 2000);
        assert_eq!(s.list()[0].progress, Some(10));
        assert_eq!(s.list()[0].subtitle, "Read");
        s.apply_hook(&ev("PreToolUse", json!({"tool_name": "mcp__ccd_turn__update_plan", "tool_input": {"advance": true}})), 3000);
        assert_eq!(s.list()[0].progress, Some(35));
        assert_eq!(s.list()[0].subtitle, "Write");
    }

    #[test]
    fn needs_you_then_working_then_done() {
        let mut s = Sessions::default();
        let with = |name: &str, id: &str, extra: Value| {
            let mut v = ev(name, extra);
            v["session_id"] = json!(id);
            v
        };
        let progress = |p: u8| json!({ "tool_name": "Bash", "tool_input": { "command": format!("curl -s -m 1 127.0.0.1:47811/p -d p={p}") } });
        // a: running at 30 %, b: running at 80 %, c: no estimate, d: done (to the back), e: needs input (first)
        for (id, t) in [("a", 1000), ("b", 1001), ("c", 1002), ("d", 1003), ("e", 1004)] {
            s.apply_hook(&with("UserPromptSubmit", id, json!({})), t);
        }
        s.apply_hook(&with("PreToolUse", "a", progress(30)), 2000);
        s.apply_hook(&with("PreToolUse", "b", progress(80)), 2001);
        s.apply_hook(&with("PreToolUse", "e", progress(50)), 2002);
        s.apply_hook(&with("PermissionRequest", "e", json!({ "tool_name": "Bash", "tool_input": {} })), 2003);
        s.apply_hook(&with("Stop", "d", json!({ "last_assistant_message": "Done." })), 2004);
        let l = s.list();
        let order: Vec<&str> = l.iter().map(|x| x.id.as_str()).collect();
        assert_eq!(order, ["e", "b", "a", "c", "d"]);
        // a blocked chat is pinned after the one that needs input; a newly finished one goes ahead of older done ones
        s.apply_hook(&with("StopFailure", "a", json!({ "error": "API error" })), 3000);
        s.apply_hook(&with("Stop", "b", json!({ "last_assistant_message": "Done too." })), 3001);
        let l = s.list();
        let order: Vec<&str> = l.iter().map(|x| x.id.as_str()).collect();
        assert_eq!(order, ["e", "a", "c", "b", "d"]);
    }

    #[test]
    fn keeps_the_desktop_chat_id() {
        let mut s = Sessions::default();
        let host = "local_24220990-58f0-4505-931e-abe6bc3612bb";
        s.apply_hook(&ev("UserPromptSubmit", json!({ "host_session_id": host })), 1000);
        assert_eq!(s.list()[0].host_session.as_deref(), Some(host));
        assert_eq!(s.chat_url("s1"), format!("claude://code/continue?session={host}"));
        // a bad id never replaces a good one and never reaches the link
        let long = format!("local_{}", "a".repeat(65));
        for bad in ["local_", "local_a/b", "local_x&y=1", "session_abc", "local_ab cd", long.as_str()] {
            assert!(!valid_host_session(bad), "{bad}");
            s.apply_hook(&ev("PreToolUse", json!({ "tool_name": "Read", "tool_input": {}, "host_session_id": bad })), 2000);
            assert_eq!(s.list()[0].host_session.as_deref(), Some(host));
        }
        // a terminal chat (no id, or only a bad one) and an unknown chat open the app
        let mut v = ev("UserPromptSubmit", json!({ "host_session_id": "local_../../x" }));
        v["session_id"] = json!("cli");
        s.apply_hook(&v, 3000);
        assert_eq!(s.chat_url("cli"), "claude://");
        assert_eq!(s.chat_url("gone"), "claude://");
        assert!(valid_host_session(&format!("local_{}", "a".repeat(64))));
    }

    #[test]
    fn cleans_markdown() {
        assert_eq!(clean_text("## Done\n\n- see [the docs](https://x.y) for `more`"), "Done see the docs for more");
        assert_eq!(clean_text("snake_case stays"), "snake_case stays");
        assert_eq!(truncate("abcdef", 4), "abc…");
    }
}
