#![allow(dead_code)]
#![allow(unused_imports)]

pub mod mock;
pub use mock::MockBackend;

use serde::{Deserialize, Serialize};
use crate::zones::VolumeTarget;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct AppAudioSession {
    pub id: String,
    pub name: String,
    pub volume: f32,
    pub muted: bool,
}

pub trait VolumeBackend: Send + Sync {
    fn get_volume(&self, target: &VolumeTarget) -> Result<f32, String>;
    fn set_volume(&self, target: &VolumeTarget, level: f32) -> Result<(), String>;
    fn get_mute(&self, target: &VolumeTarget) -> Result<bool, String>;
    fn set_mute(&self, target: &VolumeTarget, muted: bool) -> Result<(), String>;
    fn subscribe_changes(&self, callback: Box<dyn Fn(f32, bool) + Send + Sync>) -> Result<(), String>;
    fn list_apps(&self) -> Result<Vec<AppAudioSession>, String>;
    fn set_app_volume(&self, app_id: &str, level: f32) -> Result<(), String>;
}

/// Clamp audio level to the standard 0.0 - 1.0 range.
pub fn clamp_volume(level: f32) -> f32 {
    level.clamp(0.0, 1.0)
}

/// Calculate dynamic acceleration multiplier based on time elapsed between wheel ticks.
/// When user scrolls fast (interval < 150ms), a non-linear multiplier boost is applied.
pub fn calculate_acceleration(delta_ms: u64, enabled: bool) -> f32 {
    if !enabled || delta_ms >= 150 {
        return 1.0;
    }
    let factor = (150.0 - delta_ms as f32) / 150.0;
    1.0 + (factor * factor * 2.5)
}

/// Compute new volume level from current level, step percentage, scroll direction,
/// inversion preference, and acceleration multiplier.
pub fn calculate_new_volume(
    current: f32,
    step_percent: f32,
    scroll_up: bool,
    invert: bool,
    acceleration_multiplier: f32,
) -> f32 {
    let effective_up = if invert { !scroll_up } else { scroll_up };
    let step_norm = (step_percent / 100.0) * acceleration_multiplier;
    let new_level = if effective_up {
        current + step_norm
    } else {
        current - step_norm
    };
    clamp_volume(new_level)
}

/// Applies min/max volume limits, soft-start jump caps, and time-based profile volume caps.
pub fn apply_volume_limits(
    target_vol: f32,
    current_vol: f32,
    min_vol: f32,
    max_vol: f32,
    soft_start_limit: Option<f32>,
    time_limit_cap: Option<f32>,
) -> f32 {
    let effective_max = match time_limit_cap {
        Some(cap) => max_vol.min(cap),
        None => max_vol,
    };
    let clamped_target = target_vol.clamp(min_vol, effective_max);

    if let Some(max_jump) = soft_start_limit {
        let delta = clamped_target - current_vol;
        if delta.abs() > max_jump {
            let limited = current_vol + max_jump.copysign(delta);
            return limited.clamp(min_vol, effective_max);
        }
    }

    clamped_target
}

#[cfg(target_os = "windows")]
pub mod windows;
#[cfg(target_os = "windows")]
pub use windows::*;

#[cfg(target_os = "macos")]
pub mod macos;
#[cfg(target_os = "macos")]
pub use macos::*;

#[cfg(target_os = "linux")]
pub mod linux;
#[cfg(target_os = "linux")]
pub use linux::*;

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_volume_clamping() {
        assert_eq!(clamp_volume(-0.5), 0.0);
        assert_eq!(clamp_volume(0.0), 0.0);
        assert_eq!(clamp_volume(0.45), 0.45);
        assert_eq!(clamp_volume(1.0), 1.0);
        assert_eq!(clamp_volume(1.5), 1.0);
    }

    #[test]
    fn test_step_math_normal() {
        let up = calculate_new_volume(0.50, 2.0, true, false, 1.0);
        assert!((up - 0.52).abs() < 1e-4);

        let down = calculate_new_volume(0.50, 2.0, false, false, 1.0);
        assert!((down - 0.48).abs() < 1e-4);
    }

    #[test]
    fn test_step_math_inverted() {
        let up = calculate_new_volume(0.50, 2.0, true, true, 1.0);
        assert!((up - 0.48).abs() < 1e-4);

        let down = calculate_new_volume(0.50, 2.0, false, true, 1.0);
        assert!((down - 0.52).abs() < 1e-4);
    }

    #[test]
    fn test_acceleration_curve() {
        assert_eq!(calculate_acceleration(10, false), 1.0);
        assert_eq!(calculate_acceleration(150, true), 1.0);
        assert_eq!(calculate_acceleration(200, true), 1.0);

        let mid_boost = calculate_acceleration(75, true);
        let max_boost = calculate_acceleration(0, true);

        assert!(mid_boost > 1.0);
        assert!(max_boost > mid_boost);
        assert!((max_boost - 3.5).abs() < 1e-3);
    }

    #[test]
    fn test_apply_volume_limits_caps() {
        // min 0.10, max 0.80
        let capped_low = apply_volume_limits(0.05, 0.20, 0.10, 0.80, None, None);
        assert_eq!(capped_low, 0.10);

        let capped_high = apply_volume_limits(0.95, 0.70, 0.10, 0.80, None, None);
        assert_eq!(capped_high, 0.80);
    }

    #[test]
    fn test_apply_volume_soft_start_jump() {
        // Current 0.20, wants 0.50, soft start max jump 0.08 -> Should result in 0.28
        let limited = apply_volume_limits(0.50, 0.20, 0.0, 1.0, Some(0.08), None);
        assert!((limited - 0.28).abs() < 1e-4);

        // Downward jump: Current 0.50, wants 0.10, soft start max jump 0.08 -> Should result in 0.42
        let limited_down = apply_volume_limits(0.10, 0.50, 0.0, 1.0, Some(0.08), None);
        assert!((limited_down - 0.42).abs() < 1e-4);
    }

    #[test]
    fn test_apply_volume_time_profile_cap() {
        // Wants 0.60, but night time cap is 0.30 -> Should cap at 0.30
        let capped = apply_volume_limits(0.60, 0.20, 0.0, 1.0, None, Some(0.30));
        assert_eq!(capped, 0.30);
    }
}
