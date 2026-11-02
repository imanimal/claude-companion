//! Updates, like Collegiapp's: the app reads a signed `latest.json` from GitHub Releases
//! (`plugins.updater.endpoints` in tauri.conf.json; `CLAUDE_COMPANION_UPDATE_URL` overrides it for testing).
//! It checks 20 s after launch and every 6 hours. A new version is announced with "update-available" to
//! every window, and the tray's "Check for updates" item becomes "Update to x.y.z…". Installing is always
//! the user's call, from the update prompt in the main window.
//!
//! Releases are signed with the private key in `~/.tauri/claude-companion.key` (CI reads it from the
//! TAURI_SIGNING_PRIVATE_KEY secret); the app only installs files that match the public key in
//! tauri.conf.json. On Windows the NSIS installer runs in passive mode, then reopens the app.

use std::sync::Mutex;
use std::time::Duration;

use serde::Serialize;
use tauri::menu::MenuItem;
use tauri::{AppHandle, Emitter, Manager, Wry};
use tauri_plugin_updater::{Update, UpdaterExt};

const CHECK_EVERY: Duration = Duration::from_secs(6 * 60 * 60);

/// What the update prompt shows.
#[derive(Debug, Clone, Serialize)]
pub struct UpdateInfo {
    pub version: String,
    pub current: String,
    pub notes: Option<String>,
}

#[derive(Default)]
pub struct Updates {
    found: Mutex<Option<Update>>,
    menu: Mutex<Option<MenuItem<Wry>>>,
}

/// tray.rs hands over its "Check for updates" item so a found update can rename it.
pub fn set_menu_item(app: &AppHandle, item: MenuItem<Wry>) {
    if let Ok(mut m) = app.state::<Updates>().menu.lock() {
        *m = Some(item);
    }
}

/// Ask the release feed for a newer version. `Ok(None)` means up to date.
pub async fn check(app: &AppHandle) -> Result<Option<UpdateInfo>, String> {
    let mut builder = app.updater_builder();
    if let Some(url) = std::env::var_os("CLAUDE_COMPANION_UPDATE_URL") {
        let url = url.to_string_lossy().parse().map_err(|e| format!("CLAUDE_COMPANION_UPDATE_URL: {e}"))?;
        builder = builder.endpoints(vec![url]).map_err(|e| e.to_string())?;
    }
    let update = builder.build().map_err(|e| e.to_string())?.check().await.map_err(|e| e.to_string())?;
    let found = update.as_ref().map(|u| UpdateInfo {
        version: u.version.clone(),
        current: u.current_version.clone(),
        notes: u.body.clone().filter(|b| !b.trim().is_empty()),
    });
    let st = app.state::<Updates>();
    if let Ok(mut f) = st.found.lock() {
        *f = update;
    }
    if let Some(i) = &found {
        let _ = app.emit("update-available", i);
        if let Some(item) = st.menu.lock().ok().as_deref().and_then(Option::as_ref) {
            let _ = item.set_text(format!("Update to {}…", i.version));
        }
    }
    Ok(found)
}

/// Download, verify and install the update found by the last check, then restart. Emits
/// "update-progress" `{ done, total }` while downloading. On Windows the process exits inside `install`
/// and the installer reopens the app.
pub async fn install(app: &AppHandle) -> Result<(), String> {
    let update = app.state::<Updates>().found.lock().ok().and_then(|f| f.clone());
    let Some(update) = update else { return Err("No update to install. Check for updates first.".into()) };
    let mut done = 0u64;
    let bytes = update
        .download(
            |chunk, total| {
                done += chunk as u64;
                let _ = app.emit("update-progress", serde_json::json!({ "done": done, "total": total }));
            },
            || {},
        )
        .await
        .map_err(|e| e.to_string())?;
    update.install(bytes).map_err(|e| e.to_string())?;
    app.restart()
}

/// Quiet background checks; a failed check (offline, no release yet) just waits for the next.
pub fn spawn_checker(app: AppHandle) {
    std::thread::spawn(move || {
        std::thread::sleep(Duration::from_secs(20));
        loop {
            if let Err(e) = tauri::async_runtime::block_on(check(&app)) {
                eprintln!("claude-companion: update check failed: {e}");
            }
            std::thread::sleep(CHECK_EVERY);
        }
    });
}
