//! Wiring into Claude Code, per user (every project, terminal and desktop app alike):
//! - hooks in ~/.claude/settings.json: exec-form command hooks (`<this exe> hook`), async so they never
//!   wait on the app, for the events sessions.rs reads. Other hooks are left alone; ours are recognised by
//!   the exe name plus the `hook` argument, so installing twice replaces rather than duplicates.
//! - the progress instruction in ~/.claude/CLAUDE.md, between two marker comments, so Claude sends its
//!   estimate (`curl … /p`) with the first tool call of each turn.
//! $CLAUDE_CONFIG_DIR moves both, as it does for Claude Code.

use serde::Serialize;
use serde_json::{json, Map, Value};
use std::path::PathBuf;

use crate::pets::home;
use crate::sessions::PORT;

const EVENTS: [(&str, bool); 11] = [
    ("SessionStart", false),
    ("UserPromptSubmit", false),
    ("PreToolUse", true),
    ("PostToolUse", true),
    ("PostToolUseFailure", true),
    ("PermissionRequest", true),
    ("PermissionDenied", true),
    ("Notification", false),
    ("Stop", false),
    ("StopFailure", false),
    ("SessionEnd", false),
];

const START: &str = "<!-- claude-companion:start -->";
const END: &str = "<!-- claude-companion:end -->";

pub fn claude_dir() -> PathBuf {
    std::env::var_os("CLAUDE_CONFIG_DIR")
        .filter(|d| !d.is_empty())
        .map(PathBuf::from)
        .unwrap_or_else(|| home().join(".claude"))
}

fn settings_path() -> PathBuf {
    claude_dir().join("settings.json")
}

fn memory_path() -> PathBuf {
    claude_dir().join("CLAUDE.md")
}

pub fn memory_block() -> String {
    format!(
        "{START}\n\
## Pet progress (Claude Companion)\n\
\n\
A desktop pet shows each session's state from hooks. Keep its progress bar current as a reflex: no deliberation, no extra round trip.\n\
\n\
- In the same message as the first tool call of a turn, also run this with the Bash tool (in PowerShell write `curl.exe`):\n\
\x20 `curl -s -m 1 127.0.0.1:{PORT}/p -d p=15 -d \"t=Reading the hooks code\"`\n\
\x20 `p` is a rough percent of the user's current request that is done (0-100); `t` is what you're on, at most six words, sentence case.\n\
- Send it again beside a later tool call when the estimate moves about 20 points or the phase changes.\n\
- Never send one at the very end (the Stop hook marks the turn done), on turns without tool calls, or as a retry after a failure.\n\
{END}\n"
    )
}

fn exe() -> String {
    std::env::current_exe()
        .map(|p| p.to_string_lossy().replace('\\', "/"))
        .unwrap_or_else(|_| "claude-companion".into())
}

fn ours(h: &Value) -> bool {
    let cmd = h["command"].as_str().unwrap_or("");
    let is_exe = cmd.contains("claude-companion");
    let has_arg = h["args"].as_array().is_some_and(|a| a.iter().any(|x| x == "hook")) || cmd.ends_with(" hook");
    is_exe && has_arg
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Status {
    pub hooks: bool,
    /// installed, but for another copy of the exe (a moved install, a dev build)
    pub hooks_elsewhere: bool,
    pub memory: bool,
    pub settings_path: String,
    pub memory_path: String,
    pub exe: String,
    pub port: u16,
}

fn read_settings() -> Result<Value, String> {
    match std::fs::read_to_string(settings_path()) {
        Ok(s) if s.trim().is_empty() => Ok(json!({})),
        Ok(s) => serde_json::from_str(&s).map_err(|e| format!("~/.claude/settings.json isn't valid JSON ({e}); fix it first")),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(json!({})),
        Err(e) => Err(e.to_string()),
    }
}

pub fn status() -> Status {
    let me = exe();
    let mut found = 0;
    let mut mine = 0;
    if let Ok(v) = read_settings() {
        for (ev, _) in EVENTS {
            for g in v["hooks"][ev].as_array().into_iter().flatten() {
                for h in g["hooks"].as_array().into_iter().flatten().filter(|h| ours(h)) {
                    found += 1;
                    if h["command"].as_str() == Some(me.as_str()) {
                        mine += 1;
                    }
                }
            }
        }
    }
    let memory = std::fs::read_to_string(memory_path()).map(|s| s.contains(START)).unwrap_or(false);
    Status {
        hooks: mine >= EVENTS.len(),
        hooks_elsewhere: found > 0 && mine < EVENTS.len(),
        memory,
        settings_path: settings_path().to_string_lossy().to_string(),
        memory_path: memory_path().to_string_lossy().to_string(),
        exe: me,
        port: PORT,
    }
}

/// Removes our hooks from a settings value (and the groups and event keys that empties).
fn strip(v: &mut Value) {
    let Some(hooks) = v.get_mut("hooks").and_then(Value::as_object_mut) else { return };
    for (_, groups) in hooks.iter_mut() {
        if let Some(gs) = groups.as_array_mut() {
            for g in gs.iter_mut() {
                if let Some(hs) = g.get_mut("hooks").and_then(Value::as_array_mut) {
                    hs.retain(|h| !ours(h));
                }
            }
            gs.retain(|g| g["hooks"].as_array().map_or(true, |h| !h.is_empty()));
        }
    }
    hooks.retain(|_, g| g.as_array().map_or(true, |a| !a.is_empty()));
    if hooks.is_empty() {
        if let Some(o) = v.as_object_mut() {
            o.remove("hooks");
        }
    }
}

fn write_settings(v: &Value) -> Result<(), String> {
    let path = settings_path();
    std::fs::create_dir_all(claude_dir()).map_err(|e| e.to_string())?;
    if path.is_file() {
        let bak = path.with_file_name("settings.json.companion-backup");
        if !bak.exists() {
            std::fs::copy(&path, &bak).map_err(|e| e.to_string())?;
        }
    }
    let text = serde_json::to_string_pretty(v).map_err(|e| e.to_string())? + "\n";
    let tmp = path.with_file_name("settings.json.companion-tmp");
    std::fs::write(&tmp, text).map_err(|e| e.to_string())?;
    std::fs::rename(&tmp, &path).map_err(|e| e.to_string())
}

pub fn install_hooks() -> Result<(), String> {
    let mut v = read_settings()?;
    if !v.is_object() {
        return Err("~/.claude/settings.json isn't a JSON object".into());
    }
    strip(&mut v);
    let me = exe();
    let hooks = v.as_object_mut().unwrap().entry("hooks").or_insert_with(|| Value::Object(Map::new()));
    let hooks = hooks.as_object_mut().ok_or("\"hooks\" in settings.json isn't an object")?;
    for (ev, tools) in EVENTS {
        let mut group = json!({ "hooks": [{ "type": "command", "command": me, "args": ["hook"], "async": true, "timeout": 10 }] });
        if tools {
            group["matcher"] = json!("*");
        }
        let list = hooks.entry(ev).or_insert_with(|| json!([]));
        match list.as_array_mut() {
            Some(a) => a.push(group),
            None => *list = json!([group]),
        }
    }
    write_settings(&v)
}

pub fn remove_hooks() -> Result<(), String> {
    let mut v = read_settings()?;
    strip(&mut v);
    write_settings(&v)
}

pub fn install_memory() -> Result<(), String> {
    let path = memory_path();
    let cur = std::fs::read_to_string(&path).unwrap_or_default();
    let block = memory_block();
    let next = match (cur.find(START), cur.find(END)) {
        (Some(a), Some(b)) if b > a => format!("{}{}{}", &cur[..a], block.trim_end(), &cur[b + END.len()..]),
        _ if cur.trim().is_empty() => block,
        _ => format!("{}\n\n{}", cur.trim_end(), block),
    };
    std::fs::create_dir_all(claude_dir()).map_err(|e| e.to_string())?;
    std::fs::write(&path, next).map_err(|e| e.to_string())
}

pub fn remove_memory() -> Result<(), String> {
    let path = memory_path();
    let cur = std::fs::read_to_string(&path).map_err(|e| e.to_string())?;
    if let (Some(a), Some(b)) = (cur.find(START), cur.find(END)) {
        if b > a {
            let next = format!("{}{}", cur[..a].trim_end(), &cur[b + END.len()..]);
            std::fs::write(&path, next.trim_start_matches('\n')).map_err(|e| e.to_string())?;
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn strip_keeps_other_hooks() {
        let mut v = json!({ "model": "x", "hooks": {
            "Stop": [
                { "hooks": [{ "type": "command", "command": "C:/a/claude-companion.exe", "args": ["hook"] }] },
                { "hooks": [{ "type": "command", "command": "notify-send done" }] }
            ],
            "PreToolUse": [{ "matcher": "*", "hooks": [{ "type": "command", "command": "\"C:/a/claude-companion.exe\" hook" }] }]
        }});
        strip(&mut v);
        assert_eq!(v["hooks"]["Stop"].as_array().unwrap().len(), 1);
        assert_eq!(v["hooks"]["Stop"][0]["hooks"][0]["command"], "notify-send done");
        assert!(v["hooks"].get("PreToolUse").is_none());
        assert_eq!(v["model"], "x");
    }

    #[test]
    fn the_memory_block_names_the_port() {
        assert!(memory_block().contains("127.0.0.1:47811/p -d p="));
        assert!(memory_block().starts_with(START));
    }
}
