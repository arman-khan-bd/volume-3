#![allow(dead_code)]

use std::process::Command;
use std::sync::{Arc, Mutex};
use crate::volume::{clamp_volume, AppAudioSession, VolumeBackend};
use crate::zones::VolumeTarget;

type VolumeSubscriber = Box<dyn Fn(f32, bool) + Send + Sync>;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum LinuxAudioTool {
    PipeWire,   // wpctl
    PulseAudio, // pactl
    Alsa,       // amixer
    None,
}

pub struct LinuxVolumeController {
    tool: LinuxAudioTool,
    subscribers: Arc<Mutex<Vec<VolumeSubscriber>>>,
}

impl LinuxVolumeController {
    pub fn new() -> Result<Self, String> {
        let tool = Self::detect_tool();
        log::info!("Detected Linux audio backend tool: {:?}", tool);
        Ok(Self {
            tool,
            subscribers: Arc::new(Mutex::new(Vec::new())),
        })
    }

    fn detect_tool() -> LinuxAudioTool {
        if Command::new("wpctl")
            .arg("status")
            .output()
            .map(|o| o.status.success())
            .unwrap_or(false)
        {
            return LinuxAudioTool::PipeWire;
        }

        if Command::new("pactl")
            .arg("info")
            .output()
            .map(|o| o.status.success())
            .unwrap_or(false)
        {
            return LinuxAudioTool::PulseAudio;
        }

        if Command::new("amixer")
            .arg("sget")
            .arg("Master")
            .output()
            .map(|o| o.status.success())
            .unwrap_or(false)
        {
            return LinuxAudioTool::Alsa;
        }

        LinuxAudioTool::None
    }
}

impl Default for LinuxVolumeController {
    fn default() -> Self {
        Self::new().expect("Failed to initialize Linux volume controller")
    }
}

impl VolumeBackend for LinuxVolumeController {
    fn get_volume(&self, target: &VolumeTarget) -> Result<f32, String> {
        match self.tool {
            LinuxAudioTool::PipeWire => {
                let node = match target {
                    VolumeTarget::Master => "@DEFAULT_AUDIO_SINK@",
                    VolumeTarget::Mic => "@DEFAULT_AUDIO_SOURCE@",
                    VolumeTarget::App(_) | VolumeTarget::AppUnderCursor => {
                        return Err("Per-app volume under wpctl delegates to pactl sink-inputs".to_string())
                    }
                };
                let output = Command::new("wpctl")
                    .args(["get-volume", node])
                    .output()
                    .map_err(|e| format!("Failed to run wpctl: {e}"))?;

                let stdout = String::from_utf8_lossy(&output.stdout);
                // Expected format: "Volume: 0.65" or "Volume: 0.65 [MUTED]"
                let val = stdout
                    .split_whitespace()
                    .nth(1)
                    .ok_or_else(|| format!("Invalid wpctl output: '{stdout}'"))?
                    .parse::<f32>()
                    .map_err(|e| format!("Failed to parse volume '{stdout}': {e}"))?;

                Ok(clamp_volume(val))
            }
            LinuxAudioTool::PulseAudio => {
                match target {
                    VolumeTarget::Master | VolumeTarget::Mic => {
                        let sink = match target {
                            VolumeTarget::Master => "@DEFAULT_SINK@",
                            _ => "@DEFAULT_SOURCE@",
                        };
                        let cmd_name = if matches!(target, VolumeTarget::Master) {
                            "get-sink-volume"
                        } else {
                            "get-source-volume"
                        };
                        let output = Command::new("pactl")
                            .args([cmd_name, sink])
                            .output()
                            .map_err(|e| format!("Failed to run pactl: {e}"))?;

                        let stdout = String::from_utf8_lossy(&output.stdout);
                        // Output contains "... / 45% / ..."
                        for part in stdout.split('/') {
                            let trimmed = part.trim();
                            if let Some(pct_str) = trimmed.strip_suffix('%') {
                                if let Ok(pct) = pct_str.trim().parse::<f32>() {
                                    return Ok(clamp_volume(pct / 100.0));
                                }
                            }
                        }
                        Err(format!("Could not parse pactl volume output: '{stdout}'"))
                    }
                    VolumeTarget::App(app_id) => {
                        let apps = self.list_apps()?;
                        apps.into_iter()
                            .find(|a| a.id.eq_ignore_ascii_case(app_id) || a.name.eq_ignore_ascii_case(app_id))
                            .map(|a| a.volume)
                            .ok_or_else(|| format!("Sink input '{app_id}' not found"))
                    }
                    VolumeTarget::AppUnderCursor => self.get_volume(&VolumeTarget::Master),
                }
            }
            LinuxAudioTool::Alsa => {
                let scontrol = match target {
                    VolumeTarget::Master => "Master",
                    VolumeTarget::Mic => "Capture",
                    VolumeTarget::App(_) | VolumeTarget::AppUnderCursor => return Err("Per-app volume unsupported under ALSA".to_string()),
                };
                let output = Command::new("amixer")
                    .args(["sget", scontrol])
                    .output()
                    .map_err(|e| format!("Failed to run amixer: {e}"))?;

                let stdout = String::from_utf8_lossy(&output.stdout);
                // Look for percentages inside square brackets, e.g. [55%]
                for token in stdout.split('[') {
                    if let Some(pct_str) = token.split(']').next() {
                        if let Some(num_str) = pct_str.strip_suffix('%') {
                            if let Ok(pct) = num_str.trim().parse::<f32>() {
                                return Ok(clamp_volume(pct / 100.0));
                            }
                        }
                    }
                }
                Err(format!("Could not parse amixer output: '{stdout}'"))
            }
            LinuxAudioTool::None => Err("No supported Linux audio backend tool detected".to_string()),
        }
    }

    fn set_volume(&self, target: &VolumeTarget, level: f32) -> Result<(), String> {
        let clamped = clamp_volume(level);
        let pct = (clamped * 100.0).round() as u32;

        match self.tool {
            LinuxAudioTool::PipeWire => {
                let node = match target {
                    VolumeTarget::Master => "@DEFAULT_AUDIO_SINK@",
                    VolumeTarget::Mic => "@DEFAULT_AUDIO_SOURCE@",
                    VolumeTarget::App(app_id) => return self.set_app_volume(app_id, clamped),
                    VolumeTarget::AppUnderCursor => return self.set_volume(&VolumeTarget::Master, clamped),
                };
                Command::new("wpctl")
                    .args(["set-volume", node, &format!("{clamped:.3}")])
                    .status()
                    .map_err(|e| format!("Failed to set wpctl volume: {e}"))?;

                if let Ok(subs) = self.subscribers.lock() {
                    for sub in subs.iter() {
                        sub(clamped, false);
                    }
                }
                Ok(())
            }
            LinuxAudioTool::PulseAudio => {
                match target {
                    VolumeTarget::Master => {
                        Command::new("pactl")
                            .args(["set-sink-volume", "@DEFAULT_SINK@", &format!("{pct}%")])
                            .status()
                            .map_err(|e| format!("Failed to set pactl sink volume: {e}"))?;
                        Ok(())
                    }
                    VolumeTarget::Mic => {
                        Command::new("pactl")
                            .args(["set-source-volume", "@DEFAULT_SOURCE@", &format!("{pct}%")])
                            .status()
                            .map_err(|e| format!("Failed to set pactl source volume: {e}"))?;
                        Ok(())
                    }
                    VolumeTarget::App(app_id) => self.set_app_volume(app_id, clamped),
                    VolumeTarget::AppUnderCursor => self.set_volume(&VolumeTarget::Master, clamped),
                }
            }
            LinuxAudioTool::Alsa => {
                let scontrol = match target {
                    VolumeTarget::Master => "Master",
                    VolumeTarget::Mic => "Capture",
                    VolumeTarget::App(_) | VolumeTarget::AppUnderCursor => return Err("Per-app volume unsupported under ALSA".to_string()),
                };
                Command::new("amixer")
                    .args(["sset", scontrol, &format!("{pct}%")])
                    .status()
                    .map_err(|e| format!("Failed to set amixer volume: {e}"))?;
                Ok(())
            }
            LinuxAudioTool::None => Err("No supported Linux audio backend tool detected".to_string()),
        }
    }

    fn get_mute(&self, target: &VolumeTarget) -> Result<bool, String> {
        match self.tool {
            LinuxAudioTool::PipeWire => {
                let node = match target {
                    VolumeTarget::Master => "@DEFAULT_AUDIO_SINK@",
                    VolumeTarget::Mic => "@DEFAULT_AUDIO_SOURCE@",
                    VolumeTarget::App(_) | VolumeTarget::AppUnderCursor => return Err("Per-app mute under wpctl not supported".to_string()),
                };
                let output = Command::new("wpctl")
                    .args(["get-volume", node])
                    .output()
                    .map_err(|e| format!("Failed to run wpctl: {e}"))?;

                let stdout = String::from_utf8_lossy(&output.stdout);
                Ok(stdout.contains("[MUTED]"))
            }
            LinuxAudioTool::PulseAudio => {
                let cmd = match target {
                    VolumeTarget::Master => "get-sink-mute",
                    _ => "get-source-mute",
                };
                let dev = match target {
                    VolumeTarget::Master => "@DEFAULT_SINK@",
                    _ => "@DEFAULT_SOURCE@",
                };
                let output = Command::new("pactl")
                    .args([cmd, dev])
                    .output()
                    .map_err(|e| format!("Failed to run pactl: {e}"))?;

                let stdout = String::from_utf8_lossy(&output.stdout);
                Ok(stdout.contains("Mute: yes"))
            }
            LinuxAudioTool::Alsa => {
                let scontrol = match target {
                    VolumeTarget::Master => "Master",
                    _ => "Capture",
                };
                let output = Command::new("amixer")
                    .args(["sget", scontrol])
                    .output()
                    .map_err(|e| format!("Failed to run amixer: {e}"))?;

                let stdout = String::from_utf8_lossy(&output.stdout);
                Ok(stdout.contains("[off]"))
            }
            LinuxAudioTool::None => Err("No supported Linux audio backend tool detected".to_string()),
        }
    }

    fn set_mute(&self, target: &VolumeTarget, muted: bool) -> Result<(), String> {
        match self.tool {
            LinuxAudioTool::PipeWire => {
                let node = match target {
                    VolumeTarget::Master => "@DEFAULT_AUDIO_SINK@",
                    _ => "@DEFAULT_AUDIO_SOURCE@",
                };
                let flag = if muted { "1" } else { "0" };
                Command::new("wpctl")
                    .args(["set-mute", node, flag])
                    .status()
                    .map_err(|e| format!("Failed to set wpctl mute: {e}"))?;
                Ok(())
            }
            LinuxAudioTool::PulseAudio => {
                let cmd = match target {
                    VolumeTarget::Master => "set-sink-mute",
                    _ => "set-source-mute",
                };
                let dev = match target {
                    VolumeTarget::Master => "@DEFAULT_SINK@",
                    _ => "@DEFAULT_SOURCE@",
                };
                let flag = if muted { "1" } else { "0" };
                Command::new("pactl")
                    .args([cmd, dev, flag])
                    .status()
                    .map_err(|e| format!("Failed to set pactl mute: {e}"))?;
                Ok(())
            }
            LinuxAudioTool::Alsa => {
                let scontrol = match target {
                    VolumeTarget::Master => "Master",
                    _ => "Capture",
                };
                let action = if muted { "mute" } else { "unmute" };
                Command::new("amixer")
                    .args(["sset", scontrol, action])
                    .status()
                    .map_err(|e| format!("Failed to set amixer mute: {e}"))?;
                Ok(())
            }
            LinuxAudioTool::None => Err("No supported Linux audio backend tool detected".to_string()),
        }
    }

    fn subscribe_changes(&self, callback: Box<dyn Fn(f32, bool) + Send + Sync>) -> Result<(), String> {
        let mut subs = self.subscribers.lock().map_err(|e| e.to_string())?;
        subs.push(callback);
        Ok(())
    }

    fn list_apps(&self) -> Result<Vec<AppAudioSession>, String> {
        // Enumerate active sink inputs via pactl
        let output = Command::new("pactl")
            .args(["list", "sink-inputs"])
            .output()
            .map_err(|e| format!("Failed to run pactl list sink-inputs: {e}"))?;

        let stdout = String::from_utf8_lossy(&output.stdout);
        let mut sessions = Vec::new();
        let mut current_id = String::new();
        let mut current_name = String::new();
        let mut current_vol = 1.0f32;
        let mut current_mute = false;

        for line in stdout.lines() {
            let line = line.trim();
            if let Some(id_str) = line.strip_prefix("Sink Input #") {
                if !current_id.is_empty() {
                    sessions.push(AppAudioSession {
                        id: current_id.clone(),
                        name: if current_name.is_empty() { format!("Sink Input #{current_id}") } else { current_name.clone() },
                        volume: current_vol,
                        muted: current_mute,
                    });
                }
                current_id = id_str.trim().to_string();
                current_name.clear();
                current_vol = 1.0;
                current_mute = false;
            } else if line.starts_with("application.name = ") {
                current_name = line
                    .trim_start_matches("application.name = ")
                    .trim_matches('"')
                    .to_string();
            } else if line.starts_with("Mute: ") {
                current_mute = line.ends_with("yes");
            } else if line.starts_with("Volume: ") {
                for part in line.split('/') {
                    if let Some(pct) = part.trim().strip_suffix('%') {
                        if let Ok(v) = pct.trim().parse::<f32>() {
                            current_vol = clamp_volume(v / 100.0);
                            break;
                        }
                    }
                }
            }
        }

        if !current_id.is_empty() {
            sessions.push(AppAudioSession {
                id: current_id.clone(),
                name: if current_name.is_empty() { format!("Sink Input #{current_id}") } else { current_name },
                volume: current_vol,
                muted: current_mute,
            });
        }

        Ok(sessions)
    }

    fn set_app_volume(&self, app_id: &str, level: f32) -> Result<(), String> {
        let clamped = clamp_volume(level);
        let pct = (clamped * 100.0).round() as u32;
        Command::new("pactl")
            .args(["set-sink-input-volume", app_id, &format!("{pct}%")])
            .status()
            .map_err(|e| format!("Failed to set pactl sink-input volume: {e}"))?;
        Ok(())
    }
}
