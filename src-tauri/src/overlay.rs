//! The pet window: transparent, frameless, always on top, out of the taskbar. Like Codex's overlay it is
//! bigger than the pet (room for the pill above or below) and click-through everywhere except the
//! regions pet.js reports (`set_hit_rects`): a 33 ms poll compares the cursor with those rects and flips
//! `set_ignore_cursor_events`, and reports the cursor (window CSS px) as `cursor` so v2 pets can look at it.
//! Dragging is done here too (`drag_start`/`drag_stop`): the window follows the cursor every 8 ms, which
//! stays smooth where an IPC round trip per pointer move would not.

use serde::Serialize;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::Mutex;
use std::time::Duration;
use tauri::{AppHandle, Emitter, LogicalSize, Manager, PhysicalPosition, Runtime, WebviewWindowBuilder};

#[derive(Default)]
pub struct Overlay {
    rects: Mutex<Vec<[f64; 4]>>,
    dragging: AtomicBool,
    drag_gen: AtomicU64,
    interactive: AtomicBool,
}

pub fn create<R: Runtime>(app: &AppHandle<R>, visible: bool) -> tauri::Result<()> {
    if app.get_webview_window("pet").is_some() {
        return Ok(());
    }
    let Some(cfg) = app.config().app.windows.iter().find(|w| w.label == "pet").cloned() else { return Ok(()) };
    let w = WebviewWindowBuilder::from_config(app, &cfg)?.build()?;
    let _ = w.set_ignore_cursor_events(true);
    if visible {
        // pet.js places and sizes the window before it shows anything; showing now keeps startup simple
        let _ = w.show();
    }
    Ok(())
}

pub fn spawn_poll<R: Runtime>(app: AppHandle<R>) {
    std::thread::spawn(move || {
        let mut last = (f64::NAN, f64::NAN);
        loop {
            std::thread::sleep(Duration::from_millis(33));
            let Some(w) = app.get_webview_window("pet") else { continue };
            if !w.is_visible().unwrap_or(false) {
                continue;
            }
            let st = app.state::<Overlay>();
            let (Ok(cur), Ok(pos)) = (app.cursor_position(), w.outer_position()) else { continue };
            let scale = w.scale_factor().unwrap_or(1.0);
            let lx = (cur.x - pos.x as f64) / scale;
            let ly = (cur.y - pos.y as f64) / scale;
            let inside = st.dragging.load(Ordering::Relaxed)
                || st.rects.lock().map_or(false, |r| {
                    r.iter().any(|r| lx >= r[0] && ly >= r[1] && lx < r[0] + r[2] && ly < r[1] + r[3])
                });
            if inside != st.interactive.load(Ordering::Relaxed) {
                st.interactive.store(inside, Ordering::Relaxed);
                let _ = w.set_ignore_cursor_events(!inside);
                let _ = app.emit_to("pet", "hover", inside);
            }
            if (lx - last.0).abs() >= 1.0 || (ly - last.1).abs() >= 1.0 {
                last = (lx, ly);
                let _ = app.emit_to("pet", "cursor", [lx.round(), ly.round()]);
            }
        }
    });
}

#[derive(Serialize)]
pub struct Info {
    x: i32,
    y: i32,
    scale: f64,
    /// work areas of every monitor, physical px: [x, y, w, h]
    monitors: Vec<[i32; 4]>,
}

#[tauri::command]
pub fn overlay_info(app: AppHandle) -> Result<Info, String> {
    let w = app.get_webview_window("pet").ok_or("no pet window")?;
    let pos = w.outer_position().map_err(|e| e.to_string())?;
    let monitors = w
        .available_monitors()
        .map_err(|e| e.to_string())?
        .iter()
        .map(|m| {
            let a = m.work_area();
            [a.position.x, a.position.y, a.size.width as i32, a.size.height as i32]
        })
        .collect();
    Ok(Info { x: pos.x, y: pos.y, scale: w.scale_factor().unwrap_or(1.0), monitors })
}

/// Size in CSS px, position in physical px (the pet's screen spot is stored physical).
#[tauri::command]
pub fn overlay_set(app: AppHandle, x: i32, y: i32, width: f64, height: f64) -> Result<(), String> {
    let w = app.get_webview_window("pet").ok_or("no pet window")?;
    w.set_size(LogicalSize::new(width, height)).map_err(|e| e.to_string())?;
    w.set_position(PhysicalPosition::new(x, y)).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn set_hit_rects(state: tauri::State<Overlay>, rects: Vec<[f64; 4]>) {
    if let Ok(mut r) = state.rects.lock() {
        *r = rects;
    }
}

#[tauri::command]
pub fn drag_start(app: AppHandle, state: tauri::State<Overlay>) -> Result<(), String> {
    let w = app.get_webview_window("pet").ok_or("no pet window")?;
    let cur0 = app.cursor_position().map_err(|e| e.to_string())?;
    let pos0 = w.outer_position().map_err(|e| e.to_string())?;
    state.dragging.store(true, Ordering::Relaxed);
    let gen = state.drag_gen.fetch_add(1, Ordering::Relaxed) + 1;
    let app2 = app.clone();
    std::thread::spawn(move || {
        let st = app2.state::<Overlay>();
        let mut last = (pos0.x, pos0.y);
        while st.dragging.load(Ordering::Relaxed) && st.drag_gen.load(Ordering::Relaxed) == gen {
            if let Ok(c) = app2.cursor_position() {
                let next = (pos0.x + (c.x - cur0.x).round() as i32, pos0.y + (c.y - cur0.y).round() as i32);
                if next != last {
                    last = next;
                    let _ = w.set_position(PhysicalPosition::new(next.0, next.1));
                }
            }
            std::thread::sleep(Duration::from_millis(8));
        }
    });
    Ok(())
}

#[tauri::command]
pub fn drag_stop(app: AppHandle, state: tauri::State<Overlay>) -> Result<[i32; 2], String> {
    state.dragging.store(false, Ordering::Relaxed);
    let w = app.get_webview_window("pet").ok_or("no pet window")?;
    let p = w.outer_position().map_err(|e| e.to_string())?;
    Ok([p.x, p.y])
}

#[tauri::command]
pub fn pet_menu(app: AppHandle) -> Result<(), String> {
    use tauri::menu::{MenuBuilder, MenuItemBuilder};
    let w = app.get_webview_window("pet").ok_or("no pet window")?;
    let menu = MenuBuilder::new(&app)
        .item(&MenuItemBuilder::with_id("open", "Open Claude Companion").build(&app).map_err(|e| e.to_string())?)
        .item(&MenuItemBuilder::with_id("edit", "Edit this pet").build(&app).map_err(|e| e.to_string())?)
        .item(&MenuItemBuilder::with_id("claude", "Open Claude").build(&app).map_err(|e| e.to_string())?)
        .separator()
        .item(&MenuItemBuilder::with_id("hide-pet", "Hide pet").build(&app).map_err(|e| e.to_string())?)
        .item(&MenuItemBuilder::with_id("quit", "Quit").build(&app).map_err(|e| e.to_string())?)
        .build()
        .map_err(|e| e.to_string())?;
    w.popup_menu(&menu).map_err(|e| e.to_string())
}
