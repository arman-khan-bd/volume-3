#![allow(dead_code)]
#![allow(unused_imports)]

use crate::volume::{calculate_acceleration, calculate_new_volume, clamp_volume, VolumeBackend};
use crate::zones::{VolumeTarget, Zone};
use std::sync::Arc;

#[derive(Debug, Clone)]
pub struct WheelEvent {
    pub zone_id: String,
    pub raw_delta: f32, // Raw wheel delta (+120 / -120 or fractional high-res)
    pub is_horizontal: bool,
    pub shift_down: bool,
    pub ctrl_down: bool,
    pub alt_down: bool,
    pub meta_down: bool,
    pub timestamp_ms: u64,
}

pub trait InputHook: Send + Sync {
    fn start(&mut self) -> Result<(), String>;
    fn stop(&mut self) -> Result<(), String>;
    fn update_zones(&self, zones: Vec<Zone>);
}

/// Computes the volume delta percentage from a wheel event, taking into account
/// high-resolution ticks, acceleration, and modifier multipliers (Shift = coarse, Ctrl = fine).
pub fn compute_wheel_volume_delta(
    raw_delta: f32,
    base_step_pct: f32,
    shift_down: bool,
    ctrl_down: bool,
    acceleration_multiplier: f32,
) -> (bool, f32) {
    let is_up = raw_delta > 0.0;
    let ticks = (raw_delta.abs() / 120.0).max(0.1);

    let modifier_multiplier = if shift_down {
        2.5 // Coarse adjustment
    } else if ctrl_down {
        0.25 // Fine adjustment
    } else {
        1.0
    };

    let effective_step = base_step_pct * ticks * modifier_multiplier * acceleration_multiplier;
    (is_up, effective_step)
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

#[cfg(not(target_os = "windows"))]
pub fn emergency_panic_unhook() {
    log::warn!("EMERGENCY PANIC: Input hooks disengaged");
}
#[cfg(not(target_os = "windows"))]
pub fn reset_panic_state() {}
#[cfg(not(target_os = "windows"))]
pub fn is_panic_disengaged() -> bool {
    false
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_standard_wheel_delta() {
        // 1 standard wheel tick (+120), 2% step, no modifiers, no acceleration
        let (is_up, step) = compute_wheel_volume_delta(120.0, 2.0, false, false, 1.0);
        assert!(is_up);
        assert!((step - 2.0).abs() < 1e-4);

        let (is_up_down, step_down) = compute_wheel_volume_delta(-120.0, 2.0, false, false, 1.0);
        assert!(!is_up_down);
        assert!((step_down - 2.0).abs() < 1e-4);
    }

    #[test]
    fn test_high_res_wheel_delta() {
        // Smooth scroll / high-res wheel tick (+30)
        let (is_up, step) = compute_wheel_volume_delta(30.0, 2.0, false, false, 1.0);
        assert!(is_up);
        assert!((step - 0.5).abs() < 1e-4);
    }

    #[test]
    fn test_modifiers_multiplier() {
        // Shift = coarse (2.5x)
        let (_, shift_step) = compute_wheel_volume_delta(120.0, 2.0, true, false, 1.0);
        assert!((shift_step - 5.0).abs() < 1e-4);

        // Ctrl = fine (0.25x)
        let (_, ctrl_step) = compute_wheel_volume_delta(120.0, 2.0, false, true, 1.0);
        assert!((ctrl_step - 0.5).abs() < 1e-4);
    }

    #[test]
    fn test_acceleration_boost() {
        let (_, normal_step) = compute_wheel_volume_delta(120.0, 2.0, false, false, 1.0);
        let (_, boosted_step) = compute_wheel_volume_delta(120.0, 2.0, false, false, 2.5);
        assert!((boosted_step - (normal_step * 2.5)).abs() < 1e-4);
    }
}
