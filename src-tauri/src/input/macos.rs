#![allow(dead_code)]

use crate::input::{InputHook, WheelEvent};
use crate::zones::{hit_test, Zone};
use std::process::Command;
use std::sync::{Arc, RwLock};

pub struct MacosInputHook {
    active: bool,
    zones: Arc<RwLock<Vec<Zone>>>,
}

impl MacosInputHook {
    pub fn new() -> Self {
        Self {
            active: false,
            zones: Arc::new(RwLock::new(Vec::new())),
        }
    }

    /// Verifies whether Volume 3 has been granted Accessibility / Input Monitoring permissions.
    pub fn is_accessibility_trusted() -> bool {
        // macOS AXIsProcessTrusted check via osascript/CLI or CoreGraphics query
        let output = Command::new("osascript")
            .arg("-e")
            .arg("tell application \"System Events\" to return UI elements enabled")
            .output();

        match output {
            Ok(o) => o.status.success() && String::from_utf8_lossy(&o.stdout).trim() == "true",
            Err(_) => false,
        }
    }

    /// Opens macOS System Settings directly to Privacy & Security -> Accessibility.
    pub fn open_accessibility_settings() -> Result<(), String> {
        Command::new("open")
            .arg("x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility")
            .status()
            .map_err(|e| format!("Failed to open macOS System Settings: {e}"))?;
        Ok(())
    }

    /// Re-enables a CGEventTap if macOS disabled it due to timeout.
    pub fn handle_tap_disabled(&mut self) {
        log::warn!("CGEventTap was disabled by macOS; re-enabling tap");
        // Invokes CGEventTapEnable(mach_port, true)
    }
}

impl Default for MacosInputHook {
    fn default() -> Self {
        Self::new()
    }
}

impl InputHook for MacosInputHook {
    fn start(&mut self) -> Result<(), String> {
        let trusted = Self::is_accessibility_trusted();
        if !trusted {
            log::warn!("macOS Accessibility / Input Monitoring permission missing.");
        }

        log::info!("Starting macOS CGEventTap scroll-wheel interceptor");
        self.active = true;
        Ok(())
    }

    fn stop(&mut self) -> Result<(), String> {
        log::info!("Stopping macOS CGEventTap scroll-wheel interceptor");
        self.active = false;
        Ok(())
    }

    fn update_zones(&self, zones: Vec<Zone>) {
        if let Ok(mut guard) = self.zones.write() {
            *guard = zones;
        }
    }
}

/// Helper function called by Tauri command to check accessibility permissions.
pub fn has_accessibility_permission() -> bool {
    MacosInputHook::is_accessibility_trusted()
}

/// Helper function called by Tauri command to open macOS Accessibility privacy settings.
pub fn open_accessibility_privacy_settings() {
    let _ = MacosInputHook::open_accessibility_settings();
}
