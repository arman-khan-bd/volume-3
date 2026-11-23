use std::fs;
use std::path::PathBuf;
use serde::{Deserialize, Serialize};
use thiserror::Error;
use crate::zones::{Modifiers, Rect, ScreenEdge, VisualMode, VolumeTarget, Zone, ZoneShape};

#[derive(Error, Debug)]
pub enum ConfigError {
    #[error("Unable to resolve system configuration directory")]
    MissingConfigDir,
    #[error("IO error handling configuration file: {0}")]
    Io(#[from] std::io::Error),
    #[error("JSON serialization or parsing error: {0}")]
    Json(#[from] serde_json::Error),
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "snake_case")]
pub enum OsdPosition {
    #[default]
    Center,
    Top,
    Bottom,
    NearCursor,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct OsdConfig {
    #[serde(default = "default_true")]
    pub enabled: bool,
    #[serde(default = "default_osd_duration")]
    pub duration_ms: u32,
    #[serde(default)]
    pub position: OsdPosition,
    #[serde(default = "default_true")]
    pub hide_in_fullscreen: bool,
    #[serde(default = "default_osd_theme")]
    pub theme: String, // "dark", "light", "auto"
}

const fn default_true() -> bool {
    true
}

const fn default_osd_duration() -> u32 {
    1000
}

fn default_osd_theme() -> String {
    "auto".to_string()
}

impl Default for OsdConfig {
    fn default() -> Self {
        Self {
            enabled: true,
            duration_ms: default_osd_duration(),
            position: OsdPosition::Center,
            hide_in_fullscreen: true,
            theme: default_osd_theme(),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct TimeProfile {
    #[serde(default)]
    pub enabled: bool,
    #[serde(default = "default_night_start")]
    pub start_hour: u8, // e.g. 22 (10 PM)
    #[serde(default = "default_night_end")]
    pub end_hour: u8,   // e.g. 7 (7 AM)
    #[serde(default = "default_night_max_vol")]
    pub max_volume: f32, // e.g. 0.30
}

const fn default_night_start() -> u8 {
    22
}

const fn default_night_end() -> u8 {
    7
}

const fn default_night_max_vol() -> f32 {
    0.30
}

impl Default for TimeProfile {
    fn default() -> Self {
        Self {
            enabled: false,
            start_hour: default_night_start(),
            end_hour: default_night_end(),
            max_volume: default_night_max_vol(),
        }
    }
}

impl TimeProfile {
    pub fn is_active_at_hour(&self, hour: u8) -> bool {
        if !self.enabled {
            return false;
        }
        if self.start_hour <= self.end_hour {
            hour >= self.start_hour && hour < self.end_hour
        } else {
            // Wraps around midnight (e.g. 22:00 to 07:00)
            hour >= self.start_hour || hour < self.end_hour
        }
    }

    pub fn current_cap(&self) -> Option<f32> {
        if !self.enabled {
            return None;
        }
        #[cfg(target_os = "windows")]
        {
            use windows::Win32::System::SystemInformation::GetLocalTime;
            // SAFETY: Standard Windows API querying local time
            let st = unsafe { GetLocalTime() };
            if self.is_active_at_hour(st.wHour as u8) {
                return Some(self.max_volume);
            }
        }
        None
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Default)]
pub struct FullscreenRule {
    #[serde(default = "default_true")]
    pub disable_in_fullscreen: bool,
    #[serde(default)]
    pub blacklisted_apps: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ZoneProfile {
    pub id: String,
    pub name: String,
    pub zones: Vec<Zone>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Settings {
    #[serde(default)]
    pub edit_mode: bool,
    #[serde(default)]
    pub start_at_login: bool,
    #[serde(default)]
    pub run_as_admin: bool,
    #[serde(default)]
    pub osd: OsdConfig,
    #[serde(default)]
    pub time_profile: TimeProfile,
    #[serde(default)]
    pub fullscreen_rule: FullscreenRule,
    #[serde(default = "default_profile_id")]
    pub active_profile_id: String,
    #[serde(default)]
    pub profiles: Vec<ZoneProfile>,
    #[serde(default = "default_zones")]
    pub zones: Vec<Zone>,
}

fn default_profile_id() -> String {
    "default".to_string()
}

fn default_zones() -> Vec<Zone> {
    vec![
        Zone {
            id: "default-top".to_string(),
            name: "Screen Top Bar".to_string(),
            monitor_id: None,
            rect: Rect::new(0, 0, 1920, 24),
            shape: ZoneShape::ScreenEdgeStrip {
                edge: ScreenEdge::Top,
                thickness: 24,
            },
            visual_mode: VisualMode::FaintTint,
            opacity: 0.25,
            target: VolumeTarget::Master,
            step: 2.0,
            acceleration: false,
            invert: false,
            modifiers: Modifiers::none(),
            min_volume: 0.0,
            max_volume: 1.0,
            soft_start_limit: None,
            middle_click_to_mute: false,
            coarse_modifier: crate::zones::ModifierKey::Shift,
            fine_modifier: crate::zones::ModifierKey::Ctrl,
            horizontal_action: crate::zones::HorizontalWheelAction::None,
            tick_sound: false,
            pulse_tint: true,
            enabled: true,
        },
    ]
}

impl Default for Settings {
    fn default() -> Self {
        let initial_zones = default_zones();
        Self {
            edit_mode: false,
            start_at_login: false,
            run_as_admin: false,
            osd: OsdConfig::default(),
            time_profile: TimeProfile::default(),
            fullscreen_rule: FullscreenRule::default(),
            active_profile_id: default_profile_id(),
            profiles: vec![ZoneProfile {
                id: default_profile_id(),
                name: "Default Profile".to_string(),
                zones: initial_zones.clone(),
            }],
            zones: initial_zones,
        }
    }
}

use std::sync::OnceLock;

static CUSTOM_CONFIG_PATH: OnceLock<PathBuf> = OnceLock::new();

pub fn set_custom_config_path(path: PathBuf) {
    let _ = CUSTOM_CONFIG_PATH.set(path);
}

pub fn get_config_dir() -> Result<PathBuf, ConfigError> {
    let base = dirs::config_dir().ok_or(ConfigError::MissingConfigDir)?;
    #[cfg(target_os = "windows")]
    let dir = base.join("VolZone");
    #[cfg(not(target_os = "windows"))]
    let dir = base.join("volzone");
    Ok(dir)
}

pub fn get_config_path() -> Result<PathBuf, ConfigError> {
    if let Some(custom) = CUSTOM_CONFIG_PATH.get() {
        return Ok(custom.clone());
    }
    let dir = get_config_dir()?;
    Ok(dir.join("config.json"))
}

pub fn load_config() -> Result<Settings, ConfigError> {
    let path = get_config_path()?;
    if !path.exists() {
        let settings = Settings::default();
        let _ = save_config(&settings);
        return Ok(settings);
    }

    let contents = fs::read_to_string(&path)?;
    let settings: Settings = serde_json::from_str(&contents)?;
    Ok(settings)
}

pub fn save_config(settings: &Settings) -> Result<(), ConfigError> {
    let path = get_config_path()?;
    if let Some(parent) = path.parent() {
        if !parent.exists() {
            fs::create_dir_all(parent)?;
        }
    }
    let json = serde_json::to_string_pretty(settings)?;
    fs::write(path, json)?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_time_profile_wraparound() {
        let profile = TimeProfile {
            enabled: true,
            start_hour: 22, // 10 PM
            end_hour: 7,    // 7 AM
            max_volume: 0.30,
        };

        // Active times
        assert!(profile.is_active_at_hour(22));
        assert!(profile.is_active_at_hour(23));
        assert!(profile.is_active_at_hour(0));
        assert!(profile.is_active_at_hour(3));
        assert!(profile.is_active_at_hour(6));

        // Inactive times
        assert!(!profile.is_active_at_hour(7));
        assert!(!profile.is_active_at_hour(12));
        assert!(!profile.is_active_at_hour(21));
    }

    #[test]
    fn test_roundtrip_advanced_settings() {
        let original = Settings::default();
        let serialized = serde_json::to_string_pretty(&original).expect("serialize");
        let parsed: Settings = serde_json::from_str(&serialized).expect("deserialize");
        assert_eq!(original, parsed);
    }
}
