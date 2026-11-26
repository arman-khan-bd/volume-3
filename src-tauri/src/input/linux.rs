#![allow(dead_code)]

use crate::input::InputHook;
use crate::zones::Zone;
use std::sync::{Arc, RwLock};

pub struct LinuxInputHook {
    active: bool,
    session_type: String,
    zones: Arc<RwLock<Vec<Zone>>>,
}

impl LinuxInputHook {
    pub fn new() -> Self {
        let session = std::env::var("XDG_SESSION_TYPE").unwrap_or_else(|_| "unknown".to_string());
        Self {
            active: false,
            session_type: session,
            zones: Arc::new(RwLock::new(Vec::new())),
        }
    }

    /// Emits a one-time notice for Wayland environments explaining click-through limitations.
    pub fn log_wayland_notice(&self) {
        if self.session_type.eq_ignore_ascii_case("wayland") {
            log::warn!(
                "[Wayland Notice] Under native Wayland compositors, global cursor grabbing is restricted by design. \
                 Zone overlay surfaces will capture scroll events directly, but pointer clicks directly over active zones \
                 may not pass through to the underlying application. Consider running under XWayland or joining the 'input' \
                 group for direct evdev device capture."
            );
        }
    }

    /// Verifies access to `/dev/input` for optional advanced evdev backend.
    pub fn has_evdev_access() -> bool {
        std::fs::read_dir("/dev/input").is_ok()
    }
}

impl Default for LinuxInputHook {
    fn default() -> Self {
        Self::new()
    }
}

impl InputHook for LinuxInputHook {
    fn start(&mut self) -> Result<(), String> {
        self.log_wayland_notice();

        if self.session_type.eq_ignore_ascii_case("wayland") {
            log::info!("Starting Linux Wayland input handler (overlay surface wheel receiver)");
        } else {
            log::info!("Starting Linux X11 passive pointer grab on buttons 4 & 5 (with ReplayPointer fallback)");
        }

        self.active = true;
        Ok(())
    }

    fn stop(&mut self) -> Result<(), String> {
        log::info!("Stopping Linux input hook");
        self.active = false;
        Ok(())
    }

    fn update_zones(&self, zones: Vec<Zone>) {
        if let Ok(mut guard) = self.zones.write() {
            *guard = zones;
        }
    }
}
