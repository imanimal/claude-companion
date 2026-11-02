//! Tray icon: left click opens the companion window; the menu shows or hides the pet and quits.
//! Menu ids are shared with the pet's right-click menu (overlay::pet_menu) and handled in `on_menu`.

use tauri::image::Image;
use tauri::menu::{MenuBuilder, MenuEvent, MenuItemBuilder};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{AppHandle, Emitter, Manager};

pub fn build(app: &AppHandle) -> tauri::Result<()> {
    let menu = MenuBuilder::new(app)
        .item(&MenuItemBuilder::with_id("open", "Open Claude Companion").build(app)?)
        .item(&MenuItemBuilder::with_id("toggle-pet", "Show or hide the pet").build(app)?)
        .separator()
        .item(&MenuItemBuilder::with_id("quit", "Quit").build(app)?)
        .build()?;
    let icon = Image::from_bytes(include_bytes!("../icons/tray.png"))?;
    TrayIconBuilder::with_id("main")
        .icon(icon)
        .tooltip("Claude Companion")
        .menu(&menu)
        .show_menu_on_left_click(false)
        .on_tray_icon_event(|t, e| {
            if let TrayIconEvent::Click { button: MouseButton::Left, button_state: MouseButtonState::Up, .. } = e {
                show_main(t.app_handle(), None);
            }
        })
        .build(app)?;
    Ok(())
}

pub fn show_main(app: &AppHandle, view: Option<&str>) {
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.show();
        let _ = w.unminimize();
        let _ = w.set_focus();
        if let Some(v) = view {
            let _ = app.emit_to("main", "nav", v);
        }
    }
}

/// Opens the editor on the pet that's on the desktop (the pet's edit key, its menu and the tray).
pub fn edit_active(app: &AppHandle) {
    let pet = crate::active_pet(app);
    show_main(app, Some("editor"));
    if let Some(p) = pet {
        let _ = app.emit_to("main", "edit-pet", p);
    }
}

pub fn on_menu(app: &AppHandle, e: MenuEvent) {
    match e.id().as_ref() {
        "open" => show_main(app, None),
        "edit" => edit_active(app),
        "claude" => crate::open_claude(app.clone()),
        "hide-pet" => crate::set_pet_visible(app, false),
        "toggle-pet" => {
            let vis = app.get_webview_window("pet").and_then(|w| w.is_visible().ok()).unwrap_or(false);
            crate::set_pet_visible(app, !vis);
        }
        "quit" => app.exit(0),
        _ => {}
    }
}
