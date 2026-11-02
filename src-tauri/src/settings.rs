//! App settings: one JSON file in the app config dir. The UI reads them with `get_settings` and changes
//! them with `set_settings(patch)`; every change is broadcast as a `settings` event to both windows.

use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::BTreeMap;
use std::path::PathBuf;

#[derive(Clone, Serialize, Deserialize, Debug)]
#[serde(default, rename_all = "camelCase")]
pub struct Settings {
    /// Pet folder id under the Codex pets dir.
    pub active_pet: Option<String>,
    /// The pet's width as a share of Codex's 7.04rem, 0.5 to 2: Settings' slider, Ctrl-scroll on the pet, its menu.
    pub pet_scale: f64,
    /// Before the slider: s · m · l · xl. Read once into `pet_scale`, never written.
    #[serde(skip_serializing)]
    pub pet_size: Option<String>,
    /// auto (only when a session or a countdown has news) · always · never
    pub pill: String,
    /// v2 pets turn toward the cursor when it is near.
    pub look: bool,
    /// Codex jumps the pet on hover.
    pub hover_jump: bool,
    pub shadow: bool,
    /// Draw the pet smoothed (image-rendering: auto) instead of Codex's pixelated, which stair-steps at its odd scales.
    pub smooth: bool,
    pub pet_visible: bool,
    /// Windows: step aside while an app is fullscreen on the pet's screen (fullscreen.rs).
    pub hide_fullscreen: bool,
    /// The main window's theme: a built-in id (ui/js/themes.js) or one of `themes`. New installs start on Claude.
    pub theme: String,
    /// The dark theme a light `theme` hands over to while the system is dark (Claude Dark to start with).
    pub night_theme: String,
    /// auto (follow the system) · off
    pub night: String,
    /// Imported themes, each a shared Pocket theme file (Collegiapp's docs/THEMES.md).
    pub themes: Vec<Value>,
    /// The pet's top-left on screen, in physical px (the window moves around it).
    pub pet_x: Option<f64>,
    pub pet_y: Option<f64>,
    /// Autostart is turned on once, at first run; after that it is the user's switch.
    pub autostart_init: bool,
    /// Collegiapp's classes and deadlines as pills behind the Claude chats (collegiapp.rs).
    pub countdowns: bool,
    /// Countdowns dismissed from the pet, as "<item id>@<unix ms>", so a moved class or deadline comes back.
    pub countdowns_hidden: Vec<String>,
    /// Pull the pets Codex keeps in the ChatGPT account into the pets folder (codex.rs).
    pub codex_sync: bool,
    /// Codex's cloud pets pulled or linked so far: cloud id → the folder here and its art.
    pub codex_pets: BTreeMap<String, crate::codex::Link>,
}

impl Default for Settings {
    fn default() -> Self {
        Settings {
            active_pet: None,
            pet_scale: 1.0,
            pet_size: None,
            pill: "auto".into(),
            look: true,
            hover_jump: true,
            shadow: true,
            smooth: true,
            pet_visible: true,
            hide_fullscreen: true,
            theme: "claude".into(),
            night_theme: "claude-dark".into(),
            night: "auto".into(),
            themes: Vec::new(),
            pet_x: None,
            pet_y: None,
            autostart_init: false,
            countdowns: true,
            countdowns_hidden: Vec::new(),
            codex_sync: true,
            codex_pets: BTreeMap::new(),
        }
    }
}

impl Settings {
    /// Before the theme browser, `theme` was auto · light · dark: Cream, Night or whichever the system wanted.
    fn migrate(&mut self) {
        match self.theme.as_str() {
            "auto" => self.theme = "pocket-cream".into(),
            "light" => {
                self.theme = "pocket-cream".into();
                self.night = "off".into();
            }
            "dark" => self.theme = "pocket-night".into(),
            _ => {}
        }
        // the four sizes were 88, 112.64 (Codex's), 144 and 176 px wide
        if let Some(size) = self.pet_size.take() {
            self.pet_scale = match size.as_str() {
                "s" => 0.78,
                "l" => 1.28,
                "xl" => 1.56,
                _ => 1.0,
            };
        }
        self.pet_scale = self.pet_scale.clamp(0.5, 2.0);
    }
}

pub struct Store {
    path: PathBuf,
    pub data: Settings,
}

impl Store {
    pub fn load(dir: PathBuf) -> Self {
        let path = dir.join("settings.json");
        let mut data: Settings = std::fs::read_to_string(&path)
            .ok()
            .and_then(|s| serde_json::from_str(&s).ok())
            .unwrap_or_default();
        data.migrate();
        Store { path, data }
    }

    pub fn save(&self) {
        if let Some(d) = self.path.parent() {
            let _ = std::fs::create_dir_all(d);
        }
        if let Ok(s) = serde_json::to_string_pretty(&self.data) {
            let tmp = self.path.with_extension("json.tmp");
            if std::fs::write(&tmp, s).is_ok() {
                let _ = std::fs::rename(&tmp, &self.path);
            }
        }
    }

    /// Merges a partial object (camelCase keys) into the settings.
    pub fn patch(&mut self, patch: &Value) -> Result<(), String> {
        let mut cur = serde_json::to_value(&self.data).map_err(|e| e.to_string())?;
        if let (Some(c), Some(p)) = (cur.as_object_mut(), patch.as_object()) {
            for (k, v) in p {
                c.insert(k.clone(), v.clone());
            }
        }
        self.data = serde_json::from_value(cur).map_err(|e| e.to_string())?;
        self.save();
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn new_installs_start_on_claude() {
        let s: Settings = serde_json::from_str("{}").unwrap();
        assert_eq!((s.theme.as_str(), s.night_theme.as_str(), s.night.as_str()), ("claude", "claude-dark", "auto"));
        assert_eq!(s.active_pet, None);
        assert!(s.codex_sync && s.codex_pets.is_empty());
    }

    #[test]
    fn old_themes_become_ids() {
        let read = |theme: &str| {
            let mut s: Settings = serde_json::from_value(serde_json::json!({ "theme": theme })).unwrap();
            s.migrate();
            (s.theme, s.night)
        };
        assert_eq!(read("auto"), ("pocket-cream".into(), "auto".into()));
        assert_eq!(read("light"), ("pocket-cream".into(), "off".into()));
        assert_eq!(read("dark"), ("pocket-night".into(), "auto".into()));
        assert_eq!(read("standard-dark"), ("standard-dark".into(), "auto".into()));
    }

    #[test]
    fn old_sizes_become_scales() {
        let read = |v: Value| {
            let mut s: Settings = serde_json::from_value(v).unwrap();
            s.migrate();
            s
        };
        assert_eq!(read(serde_json::json!({ "petSize": "xl" })).pet_scale, 1.56);
        assert_eq!(read(serde_json::json!({ "petSize": "m" })).pet_scale, 1.0);
        assert_eq!(read(serde_json::json!({ "petScale": 1.4 })).pet_scale, 1.4);
        assert_eq!(read(serde_json::json!({ "petScale": 9 })).pet_scale, 2.0);
        let saved = serde_json::to_value(read(serde_json::json!({ "petSize": "s" }))).unwrap();
        assert_eq!((saved.get("petSize"), saved["petScale"].as_f64()), (None, Some(0.78)));
    }
}
