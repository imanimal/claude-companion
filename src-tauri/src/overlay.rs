//! The pet window: transparent, frameless, always on top, out of the taskbar. Like Codex's overlay it is
//! bigger than the pet (room for the pill above or below) and click-through everywhere except the
//! regions pet.js reports (`set_hit_rects`): a 33 ms poll compares the cursor with those rects and flips
//! `set_ignore_cursor_events`, and reports the cursor (window CSS px) as `cursor` so v2 pets can look at it.
//! Dragging is done here too (`drag_start`/`drag_stop`): every 8 ms the window eases toward the cursor, only as
//! far as keeps the pet on screen, and after release it glides onto the spot it was let go at. That stays smooth
//! where an IPC round trip per pointer move would not.

use serde::Serialize;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::Mutex;
use std::thread::JoinHandle;
use std::time::{Duration, Instant};

/// How quickly the dragged window catches up with the cursor: the time constant of its easing, in seconds.
const DRAG_EASE: f64 = 0.03;
use tauri::{AppHandle, Emitter, LogicalSize, Manager, PhysicalPosition, Runtime, WebviewWindowBuilder};

#[derive(Default)]
pub struct Overlay {
    rects: Mutex<Vec<[f64; 4]>>,
    dragging: AtomicBool,
    drag_gen: AtomicU64,
    /// the drag's easing thread; it ends where the window came to rest
    drag_thread: Mutex<Option<JoinHandle<[i32; 2]>>>,
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
        // not NaN: every comparison with NaN is false, so no cursor would ever be sent
        let mut last = (f64::INFINITY, f64::INFINITY);
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

/// `pet` is the pet's box in the window and the band its keys need above and below it, CSS px: [x, y, w, h, keys].
/// The window follows the cursor only as far as keeps that box on a monitor's work area (the bounds pet.js
/// placeWindow keeps), so the pet slides along the screen's edges instead of coming back after the drop.
#[tauri::command]
pub fn drag_start(app: AppHandle, state: tauri::State<Overlay>, pet: [f64; 5]) -> Result<(), String> {
    let w = app.get_webview_window("pet").ok_or("no pet window")?;
    let cur0 = app.cursor_position().map_err(|e| e.to_string())?;
    let pos0 = w.outer_position().map_err(|e| e.to_string())?;
    let mons: Vec<[f64; 4]> = w
        .available_monitors()
        .map(|ms| {
            ms.iter()
                .map(|m| {
                    let a = m.work_area();
                    [a.position.x as f64, a.position.y as f64, a.size.width as f64, a.size.height as f64]
                })
                .collect()
        })
        .unwrap_or_default();
    state.dragging.store(true, Ordering::Relaxed);
    let gen = state.drag_gen.fetch_add(1, Ordering::Relaxed) + 1;
    let app2 = app.clone();
    let thread = std::thread::spawn(move || {
        let st = app2.state::<Overlay>();
        let (mut x, mut y) = (pos0.x as f64, pos0.y as f64);
        let (mut tx, mut ty) = (x, y);
        let mut last = [pos0.x, pos0.y];
        let mut sent = (x, y);
        let mut t = Instant::now();
        while st.drag_gen.load(Ordering::Relaxed) == gen {
            // while held the target follows the cursor; once let go it stays where the cursor was
            let held = st.dragging.load(Ordering::Relaxed);
            if held {
                if let Ok(c) = app2.cursor_position() {
                    let s = w.scale_factor().unwrap_or(1.0);
                    (tx, ty) = on_screen(&mons, pet.map(|v| v * s), pos0.x as f64 + c.x - cur0.x, pos0.y as f64 + c.y - cur0.y);
                }
            }
            let now = Instant::now();
            let k = 1.0 - (-(now - t).as_secs_f64() / DRAG_EASE).exp();
            t = now;
            x += (tx - x) * k;
            y += (ty - y) * k;
            let settled = !held && (tx - x).abs() < 0.5 && (ty - y).abs() < 0.5;
            if settled {
                (x, y) = (tx, ty);
            }
            let next = [x.round() as i32, y.round() as i32];
            if next != last {
                last = next;
                let _ = w.set_position(PhysicalPosition::new(next[0], next[1]));
            }
            // pet.js hangs the pills on a spring from this: where the window is and how fast it's going
            if (x - sent.0).abs() > 0.05 || (y - sent.1).abs() > 0.05 {
                sent = (x, y);
                let _ = app2.emit_to("pet", "drag-move", [x, y, (tx - x) / DRAG_EASE, (ty - y) / DRAG_EASE]);
            }
            if settled {
                break;
            }
            std::thread::sleep(Duration::from_millis(8));
        }
        let _ = app2.emit_to("pet", "drag-move", [x, y, 0.0, 0.0]);
        last
    });
    if let Ok(mut d) = state.drag_thread.lock() {
        *d = Some(thread);
    }
    Ok(())
}

/// Where the window may go, given where the cursor would take it, for the pet (`pet` as in `drag_start`, physical
/// px) to stay on the work area of the monitor under its middle, or the nearest one, with its keys' band clear.
fn on_screen(mons: &[[f64; 4]], pet: [f64; 5], x: f64, y: f64) -> (f64, f64) {
    let [ox, oy, w, h, keys] = pet;
    let (cx, cy) = (x + ox + w / 2.0, y + oy + h / 2.0);
    let gap = |m: &&[f64; 4]| {
        let dx = (m[0] - cx).max(cx - m[0] - m[2]).max(0.0);
        let dy = (m[1] - cy).max(cy - m[1] - m[3]).max(0.0);
        dx * dx + dy * dy
    };
    let Some(m) = mons.iter().min_by(|a, b| gap(a).total_cmp(&gap(b))) else { return (x, y) };
    let px = (x + ox).max(m[0]).min(m[0] + m[2] - w);
    let py = (y + oy).max(m[1] + keys).min(m[1] + m[3] - h - keys);
    (px - ox, py - oy)
}

/// Lets go and answers once the window has glided to rest, with where that is.
#[tauri::command]
pub async fn drag_stop(app: AppHandle) -> Result<[i32; 2], String> {
    let thread = {
        let st = app.state::<Overlay>();
        st.dragging.store(false, Ordering::Relaxed);
        st.drag_thread.lock().ok().and_then(|mut d| d.take())
    };
    if let Some(thread) = thread {
        if let Ok(Ok(p)) = tauri::async_runtime::spawn_blocking(move || thread.join()).await {
            return Ok(p);
        }
    }
    let w = app.get_webview_window("pet").ok_or("no pet window")?;
    let p = w.outer_position().map_err(|e| e.to_string())?;
    Ok([p.x, p.y])
}

#[tauri::command]
pub fn pet_menu(app: AppHandle) -> Result<(), String> {
    use tauri::menu::{CheckMenuItemBuilder, MenuBuilder, MenuItemBuilder, SubmenuBuilder};
    let w = app.get_webview_window("pet").ok_or("no pet window")?;
    // Settings' slider goes in between; the menu ticks a size only when it's one of these
    let scale = crate::pet_scale(&app);
    let mut size = SubmenuBuilder::new(&app, "Size");
    for pct in [50, 75, 100, 125, 150, 200] {
        let label = if pct == 100 { "100% (Codex)".to_string() } else { format!("{pct}%") };
        let on = (scale * 100.0 - pct as f64).abs() < 0.5;
        size = size.item(&CheckMenuItemBuilder::with_id(format!("size-{pct}"), label).checked(on).build(&app).map_err(|e| e.to_string())?);
    }
    let menu = MenuBuilder::new(&app)
        .item(&MenuItemBuilder::with_id("open", "Open Claude Companion").build(&app).map_err(|e| e.to_string())?)
        .item(&MenuItemBuilder::with_id("edit", "Edit this pet").build(&app).map_err(|e| e.to_string())?)
        .item(&MenuItemBuilder::with_id("claude", "Open Claude").build(&app).map_err(|e| e.to_string())?)
        .separator()
        .item(&size.build().map_err(|e| e.to_string())?)
        .item(&MenuItemBuilder::with_id("hide-pet", "Hide pet").build(&app).map_err(|e| e.to_string())?)
        .item(&MenuItemBuilder::with_id("quit", "Quit").build(&app).map_err(|e| e.to_string())?)
        .build()
        .map_err(|e| e.to_string())?;
    w.popup_menu(&menu).map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::on_screen;

    // a 1920 × 1040 work area with a shorter 1280 × 680 one to its right; the pet 100 × 110 at (200, 400) in the window
    const MONS: [[f64; 4]; 2] = [[0.0, 0.0, 1920.0, 1040.0], [1920.0, 0.0, 1280.0, 680.0]];
    const PET: [f64; 5] = [200.0, 400.0, 100.0, 110.0, 38.0];

    #[test]
    fn free_on_screen() {
        assert_eq!(on_screen(&MONS, PET, 500.0, 100.0), (500.0, 100.0));
    }

    #[test]
    fn stops_at_the_edges_with_room_for_the_keys() {
        assert_eq!(on_screen(&MONS, PET, -400.0, 900.0), (-200.0, 1040.0 - 38.0 - 110.0 - 400.0));
        assert_eq!(on_screen(&MONS, PET, 100.0, -500.0), (100.0, 38.0 - 400.0));
    }

    #[test]
    fn keeps_to_the_nearest_monitor() {
        // under the shorter monitor, past its bottom: stopped on it, not pulled back to the first
        assert_eq!(on_screen(&MONS, PET, 2500.0, 900.0), (2500.0, 680.0 - 38.0 - 110.0 - 400.0));
    }

    #[test]
    fn no_monitors_no_limits() {
        assert_eq!(on_screen(&[], PET, -9000.0, 9000.0), (-9000.0, 9000.0));
    }
}
