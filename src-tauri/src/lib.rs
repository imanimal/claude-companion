//! Claude Companion: a Codex-compatible desktop pet that shows what Claude Code is doing.
//!
//! Rust owns the data: sessions (sessions.rs, fed by the bridge), settings (settings.rs) and the pets on
//! disk (pets.rs). Two windows read it: `main` (library, spritesheet editor, Claude setup, settings) and
//! `pet` (the overlay, overlay.rs). Both get the same events:
//! - "sessions" (Vec<Session>)  whenever what the pet shows changes
//! - "countdowns" (Vec<Countdown>) Collegiapp's classes and deadlines worth a pill (collegiapp.rs)
//! - "settings" (Settings)      after every change
//! - "pets"                     after a pet is written (the library and the pet reload)
//! - "nav" / "edit-pet"         (to main) open a view / a pet in the editor
//! - "cursor" / "hover"         (to pet) from the overlay poll
//! - "drag-move" ([x, y, vx, vy]) (to pet) the dragged window's eased position and velocity, physical px
//! - "update-available" (UpdateInfo) / "update-progress" ({ done, total }) / "update-check" (to main) (updater.rs)
//! Sheets load over the `pet` scheme (pets::serve), so <img>, CSS and canvas read them directly.

mod bridge;
mod claude;
mod collegiapp;
#[cfg(windows)]
mod fullscreen;
mod overlay;
mod pets;
mod sessions;
mod settings;
mod transcript;
mod tray;
#[cfg(desktop)]
mod updater;

pub use bridge::hook_client;

use serde_json::{json, Value};
use std::collections::HashSet;
use std::sync::Mutex;
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use tauri::{AppHandle, Emitter, Manager, WindowEvent};
use tauri_plugin_autostart::ManagerExt as _;
use tauri_plugin_opener::OpenerExt as _;

use sessions::Sessions;

pub struct App {
    sessions: Mutex<Sessions>,
    countdowns: Mutex<collegiapp::Reader>,
    settings: Mutex<settings::Store>,
    /// "" while listening, else why the bridge couldn't start
    bridge_error: Mutex<String>,
    last_event: Mutex<u64>,
    /// pets already backed up during this run (the first save of each makes a copy)
    backed_up: Mutex<HashSet<String>>,
}

fn now_ms() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or(0)
}

fn emit_sessions(app: &AppHandle) {
    let list = app.state::<App>().sessions.lock().map(|s| s.list()).unwrap_or_default();
    let _ = app.emit("sessions", &list);
}

/// Re-reads Collegiapp if its file changed and tells the windows when the countdowns differ.
fn refresh_countdowns(app: &AppHandle) {
    let st = app.state::<App>();
    let Some((on, hidden)) = st.settings.lock().ok().map(|s| (s.data.countdowns, s.data.countdowns_hidden.clone())) else {
        return;
    };
    let mut c = match st.countdowns.lock() {
        Ok(c) => c,
        Err(_) => return,
    };
    if c.refresh(now_ms() as i64, on, &hidden) {
        let _ = app.emit("countdowns", c.list());
    }
}

fn emit_settings(app: &AppHandle) {
    if let Ok(s) = app.state::<App>().settings.lock() {
        let _ = app.emit("settings", &s.data);
    }
}

pub(crate) fn active_pet(app: &AppHandle) -> Option<String> {
    app.state::<App>().settings.lock().ok().and_then(|s| s.data.active_pet.clone())
}

/// The pet's size, a share of Codex's (settings.rs `pet_scale`).
pub(crate) fn pet_scale(app: &AppHandle) -> f64 {
    app.state::<App>().settings.lock().map(|s| s.data.pet_scale).unwrap_or(1.0)
}

/// The user's switch for the pet, and whether it also steps aside for fullscreen apps (fullscreen.rs).
pub(crate) fn pet_prefs(app: &AppHandle) -> (bool, bool) {
    app.state::<App>().settings.lock().map(|s| (s.data.pet_visible, s.data.hide_fullscreen)).unwrap_or((true, false))
}

pub(crate) fn set_pet_visible(app: &AppHandle, vis: bool) {
    if let Ok(mut s) = app.state::<App>().settings.lock() {
        s.data.pet_visible = vis;
        s.save();
    }
    if let Some(w) = app.get_webview_window("pet") {
        let _ = if vis { w.show() } else { w.hide() };
    }
    emit_settings(app);
}

pub(crate) fn open_claude(app: AppHandle) {
    // the desktop app registers claude://; nothing happens where it isn't installed
    let _ = app.opener().open_url("claude://", None::<&str>);
}

fn on_request(app: &AppHandle, r: bridge::Request) -> Option<String> {
    let st = app.state::<App>();
    let now = now_ms();
    match r {
        bridge::Request::Hook(v) => {
            *st.last_event.lock().ok()? = now;
            let changed = st.sessions.lock().ok()?.apply_hook(&v, now);
            if changed {
                emit_sessions(app);
            }
            None
        }
        bridge::Request::Progress(p, t) => {
            *st.last_event.lock().ok()? = now;
            if st.sessions.lock().ok()?.apply_progress(p, t, now) {
                emit_sessions(app);
            }
            None
        }
        bridge::Request::State => serde_json::to_string(&st.sessions.lock().ok()?.list()).ok(),
        bridge::Request::Ping => None,
    }
}

// ───────── commands ─────────

#[tauri::command]
fn list_pets() -> Vec<pets::PetInfo> {
    pets::list()
}

#[tauri::command]
fn pets_folder() -> String {
    let d = pets::pets_dir();
    let _ = std::fs::create_dir_all(&d);
    d.to_string_lossy().to_string()
}

/// Raw body: u32 LE length of a JSON header, the header, then the image bytes.
/// Header: {"mode":"save","id","manifest","backup"} or {"mode":"create","name","manifest","ext"}.
#[tauri::command]
fn write_pet(app: AppHandle, request: tauri::ipc::Request<'_>) -> Result<pets::PetInfo, String> {
    let tauri::ipc::InvokeBody::Raw(body) = request.body() else { return Err("expected raw bytes".into()) };
    if body.len() < 4 {
        return Err("empty request".into());
    }
    let n = u32::from_le_bytes([body[0], body[1], body[2], body[3]]) as usize;
    let head: Value = serde_json::from_slice(body.get(4..4 + n).ok_or("bad header")?).map_err(|e| e.to_string())?;
    let img = &body[4 + n..];
    let st = app.state::<App>();
    let out = match head["mode"].as_str() {
        Some("save") => {
            let id = head["id"].as_str().ok_or("no id")?;
            let first = st.backed_up.lock().map_err(|e| e.to_string())?.insert(id.to_string());
            let want = head["backup"].as_bool().unwrap_or(true);
            pets::save(id, &head["manifest"], img, first && want)?
        }
        Some("create") => {
            pets::create(head["name"].as_str().unwrap_or("pet"), &head["manifest"], img, head["ext"].as_str().unwrap_or("png"))?
        }
        _ => return Err("unknown mode".into()),
    };
    let _ = app.emit("pets", &out.id);
    Ok(out)
}

#[tauri::command]
fn get_settings(state: tauri::State<App>) -> settings::Settings {
    state.settings.lock().map(|s| s.data.clone()).unwrap_or_default()
}

#[tauri::command]
fn set_settings(app: AppHandle, patch: Value) -> Result<settings::Settings, String> {
    let st = app.state::<App>();
    let (vis_before, data) = {
        let mut s = st.settings.lock().map_err(|e| e.to_string())?;
        let before = s.data.pet_visible;
        s.patch(&patch)?;
        (before, s.data.clone())
    };
    if data.pet_visible != vis_before {
        set_pet_visible(&app, data.pet_visible);
    } else {
        emit_settings(&app);
    }
    refresh_countdowns(&app);
    Ok(data)
}

#[tauri::command]
fn get_countdowns(state: tauri::State<App>) -> Vec<collegiapp::Countdown> {
    state.countdowns.lock().map(|c| c.list()).unwrap_or_default()
}

#[tauri::command]
fn countdown_status(state: tauri::State<App>) -> Option<collegiapp::Status> {
    state.countdowns.lock().ok().map(|c| c.status())
}

/// The x on a countdown: hidden until it moves (settings `countdownsHidden`).
#[tauri::command]
fn dismiss_countdown(app: AppHandle, key: String) {
    if let Ok(mut s) = app.state::<App>().settings.lock() {
        collegiapp::prune(&mut s.data.countdowns_hidden, now_ms() as i64);
        if !s.data.countdowns_hidden.contains(&key) {
            s.data.countdowns_hidden.push(key);
        }
        s.save();
    }
    emit_settings(&app);
    refresh_countdowns(&app);
}

/// Settings' "Preview": sample countdowns on the pet for a minute.
#[tauri::command]
fn preview_countdowns(app: AppHandle) {
    if let Ok(mut c) = app.state::<App>().countdowns.lock() {
        c.start_preview(now_ms() as i64);
    }
    refresh_countdowns(&app);
}

/// A click on a countdown: Collegiapp (a second launch brings up the running copy), else the item's page.
#[tauri::command]
fn open_collegiapp(app: AppHandle, id: String) -> Result<(), String> {
    if let Some(exe) = collegiapp::app_path() {
        return app.opener().open_path(exe.to_string_lossy(), None::<&str>).map_err(|e| e.to_string());
    }
    let url = app.state::<App>().countdowns.lock().ok().and_then(|c| c.url(&id));
    match url {
        Some(u) => app.opener().open_url(u, None::<&str>).map_err(|e| e.to_string()),
        None => Err("Collegiapp isn't installed".into()),
    }
}

#[tauri::command]
fn get_sessions(state: tauri::State<App>) -> Vec<sessions::Session> {
    state.sessions.lock().map(|s| s.list()).unwrap_or_default()
}

#[tauri::command]
fn dismiss(app: AppHandle, id: String) {
    let changed = app.state::<App>().sessions.lock().map(|mut s| s.dismiss(&id)).unwrap_or(false);
    if changed {
        emit_sessions(&app);
    }
}

#[tauri::command]
fn claude_status(state: tauri::State<App>) -> Value {
    let mut v = serde_json::to_value(claude::status()).unwrap_or(json!({}));
    v["bridgeError"] = json!(state.bridge_error.lock().map(|s| s.clone()).unwrap_or_default());
    v["lastEvent"] = json!(*state.last_event.lock().map_err(|_| ()).as_deref().unwrap_or(&0));
    v
}

#[tauri::command]
fn claude_setup(state: tauri::State<App>, what: String, on: bool) -> Result<Value, String> {
    match (what.as_str(), on) {
        ("hooks", true) => claude::install_hooks()?,
        ("hooks", false) => claude::remove_hooks()?,
        ("memory", true) => claude::install_memory()?,
        ("memory", false) => claude::remove_memory()?,
        _ => return Err("unknown setup step".into()),
    }
    Ok(claude_status(state))
}

#[tauri::command]
fn memory_text() -> String {
    claude::memory_block()
}

#[tauri::command]
fn reveal(app: AppHandle, path: String) -> Result<(), String> {
    app.opener().open_path(path, None::<&str>).map_err(|e| e.to_string())
}

#[tauri::command]
fn open_claude_app(app: AppHandle) {
    open_claude(app);
}

/// A click on a chat (a pill, a row in the Claude view): that chat in the desktop app, or the app.
#[tauri::command]
fn open_chat(app: AppHandle, id: String) {
    let url = app.state::<App>().sessions.lock().map(|s| s.chat_url(&id)).unwrap_or_else(|_| "claude://".into());
    let _ = app.opener().open_url(url, None::<&str>);
}

#[tauri::command]
fn show_main_view(app: AppHandle, view: Option<String>) {
    tray::show_main(&app, view.as_deref());
}

#[tauri::command]
fn edit_active_pet(app: AppHandle) {
    tray::edit_active(&app);
}

#[tauri::command]
fn hide_pet(app: AppHandle) {
    set_pet_visible(&app, false);
}

/// The Claude view's "Try it" keys: feed the pet a fake session without Claude.
#[tauri::command]
fn test_session(app: AppHandle, kind: String) {
    let base = json!({ "session_id": "companion-test", "cwd": "Claude Companion", "session_title": "Test from Claude Companion" });
    let with = |ev: &str, extra: Value| {
        let mut v = base.clone();
        v["hook_event_name"] = json!(ev);
        for (k, x) in extra.as_object().cloned().unwrap_or_default() {
            v[k] = x;
        }
        v
    };
    let evs = match kind.as_str() {
        "running" => vec![
            with("UserPromptSubmit", json!({ "prompt": "Show me the pet" })),
            with("PreToolUse", json!({ "tool_name": "Bash", "tool_input": { "command": "curl -s -m 1 127.0.0.1:47811/p -d p=40 -d \"t=Testing the pill\"" } })),
            with("PreToolUse", json!({ "tool_name": "Edit", "tool_input": { "file_path": "C:/demo/pet.js" } })),
        ],
        "waiting" => vec![with("PermissionRequest", json!({ "tool_name": "Bash", "tool_input": { "description": "Run the test suite" } }))],
        "review" => vec![with("Stop", json!({ "last_assistant_message": "All set: the pet now shows each Claude session, with a progress bar from Claude's own estimate." }))],
        "failed" => vec![with("StopFailure", json!({ "error": "API error: overloaded. Try again in a moment." }))],
        _ => vec![with("SessionEnd", json!({}))],
    };
    let st = app.state::<App>();
    for e in evs {
        // spaced a little so the late-tool guard after Stop doesn't eat a following test step
        let now = now_ms();
        if let Ok(mut s) = st.sessions.lock() {
            s.apply_hook(&e, now);
        }
    }
    emit_sessions(&app);
}

/// Settings' theme export: the file goes in Downloads (the home folder where there's none); returns its path.
#[tauri::command]
fn export_theme(app: AppHandle, file: String, text: String) -> Result<String, String> {
    let name: String = file.chars().filter(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.')).collect();
    let name = if name.trim_matches('.').is_empty() { "theme.json".to_string() } else { name };
    let path = app.path().download_dir().unwrap_or_else(|_| pets::home()).join(name);
    std::fs::write(&path, text).map_err(|e| e.to_string())?;
    Ok(path.to_string_lossy().to_string())
}

/// Ask GitHub Releases for a newer version; `null` when up to date (updater.rs).
#[cfg(desktop)]
#[tauri::command]
async fn check_update(app: AppHandle) -> Result<Option<updater::UpdateInfo>, String> {
    updater::check(&app).await
}

/// Download, verify and install the update from the last check, then restart.
#[cfg(desktop)]
#[tauri::command]
async fn install_update(app: AppHandle) -> Result<(), String> {
    updater::install(&app).await
}

#[tauri::command]
fn autostart(app: AppHandle, on: Option<bool>) -> Result<bool, String> {
    let al = app.autolaunch();
    match on {
        Some(true) => al.enable().map_err(|e| e.to_string())?,
        Some(false) => al.disable().map_err(|e| e.to_string())?,
        None => {}
    }
    al.is_enabled().map_err(|e| e.to_string())
}

/// `claude-companion setup`: installs (or with `--remove`, removes) the hooks and the progress memory, both by
/// default, and prints the resulting status. Exit code 1 on the first failure.
pub fn setup_cli(args: &[String]) -> i32 {
    let remove = args.iter().any(|a| a == "--remove");
    let mut what: Vec<&str> = args.iter().map(String::as_str).filter(|a| *a == "hooks" || *a == "memory").collect();
    if what.is_empty() {
        what = vec!["hooks", "memory"];
    }
    for w in what {
        let done = match (w, remove) {
            ("hooks", false) => claude::install_hooks(),
            ("hooks", true) => claude::remove_hooks(),
            (_, false) => claude::install_memory(),
            (_, true) => claude::remove_memory(),
        };
        if let Err(e) = done {
            eprintln!("{w}: {e}");
            return 1;
        }
    }
    println!("{}", serde_json::to_string_pretty(&claude::status()).unwrap_or_default());
    0
}

pub fn run() {
    let builder = tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, _argv, _cwd| tray::show_main(app, None)))
        .plugin(tauri_plugin_autostart::init(
            tauri_plugin_autostart::MacosLauncher::LaunchAgent,
            Some(vec!["--hidden"]),
        ))
        .plugin(tauri_plugin_opener::init());
    // signed self-updates (updater.rs); desktop only, like its dependency
    #[cfg(desktop)]
    let builder = builder.plugin(tauri_plugin_updater::Builder::new().build());
    builder
        .register_uri_scheme_protocol("pet", |_ctx, req| {
            let (code, mime, body) = pets::serve(req.uri().path());
            tauri::http::Response::builder()
                .status(code)
                .header("Content-Type", mime)
                .header("Access-Control-Allow-Origin", "*")
                .header("Cache-Control", "no-store")
                .body(body)
                .unwrap()
        })
        .invoke_handler(tauri::generate_handler![
            list_pets,
            pets_folder,
            write_pet,
            get_settings,
            set_settings,
            get_sessions,
            dismiss,
            get_countdowns,
            countdown_status,
            dismiss_countdown,
            preview_countdowns,
            open_collegiapp,
            claude_status,
            claude_setup,
            memory_text,
            reveal,
            open_claude_app,
            open_chat,
            show_main_view,
            edit_active_pet,
            hide_pet,
            test_session,
            export_theme,
            #[cfg(desktop)]
            check_update,
            #[cfg(desktop)]
            install_update,
            autostart,
            overlay::overlay_info,
            overlay::overlay_set,
            overlay::set_hit_rects,
            overlay::drag_start,
            overlay::drag_stop,
            overlay::pet_menu,
        ])
        .on_menu_event(tray::on_menu)
        .on_window_event(|w, e| {
            // closing the companion window hides it; the pet keeps running (Quit is in the tray)
            if w.label() == "main" {
                if let WindowEvent::CloseRequested { api, .. } = e {
                    api.prevent_close();
                    let _ = w.hide();
                }
            }
        })
        .setup(|app| {
            let h = app.handle().clone();
            let dir = app.path().app_config_dir()?;
            let mut store = settings::Store::load(dir);
            if store.data.active_pet.as_deref().and_then(pets::read).is_none() {
                store.data.active_pet = pets::list().first().map(|p| p.id.clone());
            }
            let first_run = !store.data.autostart_init;
            store.data.autostart_init = true;
            store.save();
            let pet_visible = store.data.pet_visible;
            app.manage(App {
                sessions: Mutex::new(Sessions::default()),
                countdowns: Mutex::new(collegiapp::Reader::default()),
                settings: Mutex::new(store),
                bridge_error: Mutex::new(String::new()),
                last_event: Mutex::new(0),
                backed_up: Mutex::new(HashSet::new()),
            });
            app.manage(overlay::Overlay::default());
            #[cfg(desktop)]
            app.manage(updater::Updates::default());
            if first_run {
                let _ = h.autolaunch().enable();
            }

            match bridge::bind() {
                Ok(l) => {
                    let h2 = h.clone();
                    std::thread::spawn(move || bridge::serve(l, move |r| on_request(&h2, r)));
                }
                Err(e) => {
                    *h.state::<App>().bridge_error.lock().unwrap() =
                        format!("Port {} is in use ({e}); is another copy running?", sessions::PORT);
                }
            }
            let h3 = h.clone();
            std::thread::spawn(move || loop {
                std::thread::sleep(Duration::from_millis(1500));
                let changed = h3.state::<App>().sessions.lock().map(|mut s| s.tick(now_ms())).unwrap_or(false);
                if changed {
                    emit_sessions(&h3);
                }
            });
            let h4 = h.clone();
            std::thread::spawn(move || loop {
                refresh_countdowns(&h4);
                std::thread::sleep(collegiapp::TICK);
            });

            overlay::create(&h, pet_visible)?;
            overlay::spawn_poll(h.clone());
            #[cfg(windows)]
            fullscreen::spawn_watch(h.clone());
            tray::build(&h)?;
            #[cfg(desktop)]
            updater::spawn_checker(h.clone());
            if !std::env::args().any(|a| a == "--hidden") {
                tray::show_main(&h, None);
            }
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running Claude Companion");
}
