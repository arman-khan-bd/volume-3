#![allow(dead_code)]

use crate::volume::{clamp_volume, AppAudioSession, VolumeBackend};
use crate::zones::VolumeTarget;
use std::sync::Mutex;

type VolumeSubscriber = Box<dyn Fn(f32, bool) + Send + Sync>;

pub struct MockBackend {
    master_volume: Mutex<f32>,
    master_muted: Mutex<bool>,
    mic_volume: Mutex<f32>,
    mic_muted: Mutex<bool>,
    apps: Mutex<Vec<AppAudioSession>>,
    subscribers: Mutex<Vec<VolumeSubscriber>>,
}

impl MockBackend {
    pub fn new() -> Self {
        Self {
            master_volume: Mutex::new(0.50),
            master_muted: Mutex::new(false),
            mic_volume: Mutex::new(0.80),
            mic_muted: Mutex::new(false),
            apps: Mutex::new(vec![
                AppAudioSession {
                    id: "spotify.exe".to_string(),
                    name: "Spotify".to_string(),
                    volume: 0.60,
                    muted: false,
                },
                AppAudioSession {
                    id: "chrome.exe".to_string(),
                    name: "Google Chrome".to_string(),
                    volume: 0.75,
                    muted: false,
                },
            ]),
            subscribers: Mutex::new(Vec::new()),
        }
    }

    fn notify_subscribers(&self, level: f32, muted: bool) {
        if let Ok(subs) = self.subscribers.lock() {
            for sub in subs.iter() {
                sub(level, muted);
            }
        }
    }
}

impl Default for MockBackend {
    fn default() -> Self {
        Self::new()
    }
}

impl VolumeBackend for MockBackend {
    fn get_volume(&self, target: &VolumeTarget) -> Result<f32, String> {
        match target {
            VolumeTarget::Master => Ok(*self.master_volume.lock().map_err(|e| e.to_string())?),
            VolumeTarget::Mic => Ok(*self.mic_volume.lock().map_err(|e| e.to_string())?),
            VolumeTarget::App(app_id) => {
                let apps = self.apps.lock().map_err(|e| e.to_string())?;
                apps.iter()
                    .find(|a| {
                        a.id.eq_ignore_ascii_case(app_id) || a.name.eq_ignore_ascii_case(app_id)
                    })
                    .map(|a| a.volume)
                    .ok_or_else(|| format!("App session '{app_id}' not found"))
            }
            VolumeTarget::AppUnderCursor => {
                Ok(*self.master_volume.lock().map_err(|e| e.to_string())?)
            }
        }
    }

    fn set_volume(&self, target: &VolumeTarget, level: f32) -> Result<(), String> {
        let clamped = clamp_volume(level);
        match target {
            VolumeTarget::Master => {
                let mut vol = self.master_volume.lock().map_err(|e| e.to_string())?;
                *vol = clamped;
                let muted = *self.master_muted.lock().map_err(|e| e.to_string())?;
                drop(vol);
                self.notify_subscribers(clamped, muted);
                Ok(())
            }
            VolumeTarget::Mic => {
                let mut vol = self.mic_volume.lock().map_err(|e| e.to_string())?;
                *vol = clamped;
                Ok(())
            }
            VolumeTarget::App(app_id) => self.set_app_volume(app_id, clamped),
            VolumeTarget::AppUnderCursor => self.set_volume(&VolumeTarget::Master, clamped),
        }
    }

    fn get_mute(&self, target: &VolumeTarget) -> Result<bool, String> {
        match target {
            VolumeTarget::Master => Ok(*self.master_muted.lock().map_err(|e| e.to_string())?),
            VolumeTarget::Mic => Ok(*self.mic_muted.lock().map_err(|e| e.to_string())?),
            VolumeTarget::App(app_id) => {
                let apps = self.apps.lock().map_err(|e| e.to_string())?;
                apps.iter()
                    .find(|a| {
                        a.id.eq_ignore_ascii_case(app_id) || a.name.eq_ignore_ascii_case(app_id)
                    })
                    .map(|a| a.muted)
                    .ok_or_else(|| format!("App session '{app_id}' not found"))
            }
            VolumeTarget::AppUnderCursor => {
                Ok(*self.master_muted.lock().map_err(|e| e.to_string())?)
            }
        }
    }

    fn set_mute(&self, target: &VolumeTarget, muted: bool) -> Result<(), String> {
        match target {
            VolumeTarget::Master => {
                let mut m = self.master_muted.lock().map_err(|e| e.to_string())?;
                *m = muted;
                let vol = *self.master_volume.lock().map_err(|e| e.to_string())?;
                drop(m);
                self.notify_subscribers(vol, muted);
                Ok(())
            }
            VolumeTarget::Mic => {
                let mut m = self.mic_muted.lock().map_err(|e| e.to_string())?;
                *m = muted;
                Ok(())
            }
            VolumeTarget::App(app_id) => {
                let mut apps = self.apps.lock().map_err(|e| e.to_string())?;
                if let Some(app) = apps.iter_mut().find(|a| {
                    a.id.eq_ignore_ascii_case(app_id) || a.name.eq_ignore_ascii_case(app_id)
                }) {
                    app.muted = muted;
                    Ok(())
                } else {
                    Err(format!("App session '{app_id}' not found"))
                }
            }
            VolumeTarget::AppUnderCursor => self.set_mute(&VolumeTarget::Master, muted),
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
        let apps = self.apps.lock().map_err(|e| e.to_string())?;
        Ok(apps.clone())
    }

    fn set_app_volume(&self, app_id: &str, level: f32) -> Result<(), String> {
        let clamped = clamp_volume(level);
        let mut apps = self.apps.lock().map_err(|e| e.to_string())?;
        if let Some(app) = apps
            .iter_mut()
            .find(|a| a.id.eq_ignore_ascii_case(app_id) || a.name.eq_ignore_ascii_case(app_id))
        {
            app.volume = clamped;
            Ok(())
        } else {
            Err(format!("App session '{app_id}' not found"))
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicBool, Ordering};
    use std::sync::Arc;

    #[test]
    fn test_mock_master_volume_and_mute() {
        let backend = MockBackend::new();
        let target = VolumeTarget::Master;

        assert_eq!(backend.get_volume(&target).unwrap(), 0.50);
        assert!(!backend.get_mute(&target).unwrap());

        backend.set_volume(&target, 0.72).unwrap();
        assert_eq!(backend.get_volume(&target).unwrap(), 0.72);

        backend.set_mute(&target, true).unwrap();
        assert!(backend.get_mute(&target).unwrap());
    }

    #[test]
    fn test_mock_per_app_volume() {
        let backend = MockBackend::new();
        let target = VolumeTarget::App("spotify.exe".to_string());

        assert_eq!(backend.get_volume(&target).unwrap(), 0.60);
        backend.set_volume(&target, 0.40).unwrap();
        assert_eq!(backend.get_volume(&target).unwrap(), 0.40);

        // Unknown app should return error
        let unknown = VolumeTarget::App("nonexistent.exe".to_string());
        assert!(backend.get_volume(&unknown).is_err());
    }

    #[test]
    fn test_mock_subscriber_callback() {
        let backend = MockBackend::new();
        let called = Arc::new(AtomicBool::new(false));
        let called_clone = Arc::clone(&called);

        backend
            .subscribe_changes(Box::new(move |vol, _muted| {
                if (vol - 0.95).abs() < 1e-4 {
                    called_clone.store(true, Ordering::SeqCst);
                }
            }))
            .unwrap();

        backend.set_volume(&VolumeTarget::Master, 0.95).unwrap();
        assert!(called.load(Ordering::SeqCst));
    }
}
