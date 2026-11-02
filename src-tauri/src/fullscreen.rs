//! "Hide while an app is fullscreen" (settings `hideFullscreen`), Windows only. Every 300 ms: when the foreground
//! window covers the whole monitor the pet is on (a video, a game, a slideshow), the pet window hides, and it comes
//! back once that ends. Both go straight through Win32 (SW_HIDE, then SWP_SHOWWINDOW | SWP_NOACTIVATE) so the pet
//! never takes focus from the app the user returns to, and tao keeps counting the window as shown: the user's own
//! switch (`set_pet_visible`) stays separate. macOS needs none of this: a fullscreen app gets its own Space, which
//! the pet doesn't join.

use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;
use tauri::{AppHandle, Manager};
use windows_sys::Win32::Foundation::{HWND, RECT};
use windows_sys::Win32::Graphics::Gdi::{
    GetMonitorInfoW, MonitorFromWindow, MONITORINFO, MONITOR_DEFAULTTONEAREST, MONITOR_DEFAULTTONULL,
};
use windows_sys::Win32::UI::WindowsAndMessaging::{
    GetClassNameW, GetForegroundWindow, GetWindowRect, GetWindowThreadProcessId, IsWindowVisible, IsZoomed, SetWindowPos,
    ShowWindowAsync, HWND_TOPMOST, SWP_ASYNCWINDOWPOS, SWP_NOACTIVATE, SWP_NOMOVE, SWP_NOSIZE, SWP_SHOWWINDOW,
    SW_HIDE,
};

/// the pet is out of the way of a fullscreen app (not hidden by the user)
static HIDDEN: AtomicBool = AtomicBool::new(false);

pub fn spawn_watch(app: AppHandle) {
    std::thread::spawn(move || loop {
        std::thread::sleep(Duration::from_millis(300));
        let Some(pet) = app.get_webview_window("pet").and_then(|w| w.hwnd().ok()).map(|h| h.0) else { continue };
        let (visible, on) = crate::pet_prefs(&app);
        let full = visible && on && covered(pet);
        unsafe {
            if full {
                HIDDEN.store(true, Ordering::Relaxed);
                // every tick, not once: any tao call that touches the window's flags shows it again
                if IsWindowVisible(pet) != 0 {
                    ShowWindowAsync(pet, SW_HIDE);
                }
            } else if HIDDEN.swap(false, Ordering::Relaxed) && visible {
                // back on top too: a fullscreen app may have pushed itself above the topmost band
                SetWindowPos(
                    pet,
                    HWND_TOPMOST,
                    0,
                    0,
                    0,
                    0,
                    SWP_ASYNCWINDOWPOS | SWP_NOACTIVATE | SWP_NOMOVE | SWP_NOSIZE | SWP_SHOWWINDOW,
                );
            }
        }
    });
}

/// Whether the foreground window fills the monitor `pet` is on. The desktop and this app's own windows don't count.
fn covered(pet: HWND) -> bool {
    unsafe {
        let fg = GetForegroundWindow();
        if fg.is_null() {
            return false;
        }
        let mut pid = 0;
        GetWindowThreadProcessId(fg, &mut pid);
        if pid == std::process::id() {
            return false;
        }
        // the desktop (Progman, or the WorkerW behind its icons) spans every screen
        let mut class = [0u16; 16];
        let n = GetClassNameW(fg, class.as_mut_ptr(), class.len() as i32).max(0) as usize;
        if matches!(String::from_utf16_lossy(&class[..n]).as_str(), "Progman" | "WorkerW") {
            return false;
        }
        let mon = MonitorFromWindow(pet, MONITOR_DEFAULTTONEAREST);
        if MonitorFromWindow(fg, MONITOR_DEFAULTTONULL) != mon {
            return false;
        }
        let mut info: MONITORINFO = std::mem::zeroed();
        info.cbSize = std::mem::size_of::<MONITORINFO>() as u32;
        let mut r: RECT = std::mem::zeroed();
        if GetMonitorInfoW(mon, &mut info) == 0 || GetWindowRect(fg, &mut r) == 0 {
            return false;
        }
        let m = info.rcMonitor;
        // A maximized window spills past the screen by its frame, so with an auto-hidden taskbar it covers the screen
        // too. Chromium's fullscreen (Chrome, Edge, Electron apps) keeps a maximized window maximized, strips the frame
        // and puts the window exactly on the screen, so a maximized window counts only when it fits it exactly.
        if IsZoomed(fg) != 0 {
            return (r.left, r.top, r.right, r.bottom) == (m.left, m.top, m.right, m.bottom);
        }
        r.left <= m.left && r.top <= m.top && r.right >= m.right && r.bottom >= m.bottom
    }
}
