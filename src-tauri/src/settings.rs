//! App settings: one JSON file in the app config dir. The UI reads them with `get_settings` and changes
//! them with `set_settings(patch)`; every change is broadcast as a `settings` event to both windows.

use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::path::PathBuf;

#[derive(Clone, Serialize, Deserialize, Debug)]
#[serde(default, rename_all = "camelCase")]
pub struct Settings {
    /// Pet folder id under the Codex pets dir.
    pub active_pet: Option<String>,
    /// s · m · l · xl (m is Codex's 7.04rem).
    pub pet_size: String,
    /// auto (only when a session has news) · always · never
    pub pill: String,
    /// v2 pets turn toward the cursor when it is near.
    pub look: bool,
    /// Codex jumps the pet on hover.
    pub hover_jump: bool,
    pub shadow: bool,
    pub pet_visible: bool,
    /// auto · light · dark
    pub theme: String,
    /// The pet's top-left on screen, in physical px (the window moves around it).
    pub pet_x: Option<f64>,
    pub pet_y: Option<f64>,
    /// Autostart is turned on once, at first run; after that it is the user's switch.
    pub autostart_init: bool,
}

impl Default for Settings {
    fn default() -> Self {
        Settings {
            active_pet: None,
            pet_size: "m".into(),
            pill: "auto".into(),
            look: true,
            hover_jump: true,
            shadow: true,
            pet_visible: true,
            theme: "auto".into(),
            pet_x: None,
            pet_y: None,
            autostart_init: false,
        }
    }
}

pub struct Store {
    path: PathBuf,
    pub data: Settings,
}

impl Store {
    pub fn load(dir: PathBuf) -> Self {
        let path = dir.join("settings.json");
        let data = std::fs::read_to_string(&path)
            .ok()
            .and_then(|s| serde_json::from_str(&s).ok())
            .unwrap_or_default();
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
