#![allow(dead_code)]

use std::process::Command;
use std::sync::{Arc, Mutex};
use crate::volume::{clamp_volume, AppAudioSession, VolumeBackend};
use crate::zones::VolumeTarget;

type VolumeSubscriber = Box<dyn Fn(f32, bool) + Send + Sync>;

pub struct MacosVolumeController {
    subscribers: Arc<Mutex<Vec<VolumeSubscriber>>>,
}

impl MacosVolumeController {
    pub fn new() -> Result<Self, String> {
        Ok(Self {
            subscribers: Arc::new(Mutex::new(Vec::new())),
        })
    }

    fn run_osascript(&self, script: &str) -> Result<String, String> {
        let output = Command::new("osascript")
            .arg("-e")
            .arg(script)
            .output()
            .map_err(|e| format!("Failed to execute osascript: {e}"))?;

        if !output.status.success() {
            let stderr = String::from_utf8_lossy(&output.stderr);
            return Err(format!("osascript error: {stderr}"));
        }

        Ok(String::from_utf8_lossy(&output.stdout).trim().to_string())
    }
}

impl Default for MacosVolumeController {
    fn default() -> Self {
        Self::new().expect("Failed to initialize macOS volume controller")
    }
}

impl VolumeBackend for MacosVolumeController {
    fn get_volume(&self, target: &VolumeTarget) -> Result<f32, String> {
        match target {
            VolumeTarget::Master => {
                let out = self.run_osascript("output volume of (get volume settings)")?;
                let pct: f32 = out
                    .parse()
                    .map_err(|e| format!("Failed to parse macOS volume '{out}': {e}"))?;
                Ok(clamp_volume(pct / 100.0))
            }
            VolumeTarget::Mic => {
                let out = self.run_osascript("input volume of (get volume settings)")?;
                let pct: f32 = out
                    .parse()
                    .map_err(|e| format!("Failed to parse macOS input volume '{out}': {e}"))?;
                Ok(clamp_volume(pct / 100.0))
            }
            VolumeTarget::App(_) | VolumeTarget::AppUnderCursor => {
                Err("Per-app volume is unsupported on macOS".to_string())
            }
        }
    }

    fn set_volume(&self, target: &VolumeTarget, level: f32) -> Result<(), String> {
        let clamped = clamp_volume(level);
        let pct = (clamped * 100.0).round() as u32;

        match target {
            VolumeTarget::Master => {
                self.run_osascript(&format!("set volume output volume {pct}"))?;
                let muted = self.get_mute(&VolumeTarget::Master).unwrap_or(false);
                if let Ok(subs) = self.subscribers.lock() {
                    for sub in subs.iter() {
                        sub(clamped, muted);
                    }
                }
                Ok(())
            }
            VolumeTarget::Mic => {
                self.run_osascript(&format!("set volume input volume {pct}"))?;
                Ok(())
            }
            VolumeTarget::App(_) | VolumeTarget::AppUnderCursor => {
                Err("Per-app volume is unsupported on macOS".to_string())
            }
        }
    }

    fn get_mute(&self, target: &VolumeTarget) -> Result<bool, String> {
        match target {
            VolumeTarget::Master => {
                let out = self.run_osascript("output muted of (get volume settings)")?;
                Ok(out.eq_ignore_ascii_case("true"))
            }
            VolumeTarget::Mic => {
                // macOS does not provide a standard input muted setting via osascript; check input volume == 0
                let vol = self.get_volume(&VolumeTarget::Mic)?;
                Ok(vol <= 0.001)
            }
            VolumeTarget::App(_) | VolumeTarget::AppUnderCursor => {
                Err("Per-app volume is unsupported on macOS".to_string())
            }
        }
    }

    fn set_mute(&self, target: &VolumeTarget, muted: bool) -> Result<(), String> {
        match target {
            VolumeTarget::Master => {
                self.run_osascript(&format!("set volume output muted {muted}"))?;
                let vol = self.get_volume(&VolumeTarget::Master).unwrap_or(0.5);
                if let Ok(subs) = self.subscribers.lock() {
                    for sub in subs.iter() {
                        sub(vol, muted);
                    }
                }
                Ok(())
            }
            VolumeTarget::Mic => {
                if muted {
                    self.run_osascript("set volume input volume 0")?;
                } else {
                    self.run_osascript("set volume input volume 50")?;
                }
                Ok(())
            }
            VolumeTarget::App(_) | VolumeTarget::AppUnderCursor => {
                Err("Per-app volume is unsupported on macOS".to_string())
            }
        }
    }

    fn subscribe_changes(
        &self,
        callback: Box<dyn Fn(f32, bool) + Send + Sync>,
    ) -> Result<(), String> {
        let mut subs = self.subscribers.lock().map_err(|e| e.to_string())?;
        subs.push(callback);
        Ok(())
    }

    fn list_apps(&self) -> Result<Vec<AppAudioSession>, String> {
        // macOS does not offer per-application volume routing via standard userland APIs
        Ok(Vec::new())
    }

    fn set_app_volume(&self, _app_id: &str, _level: f32) -> Result<(), String> {
        Err("Per-app volume is unsupported on macOS".to_string())
    }
}
