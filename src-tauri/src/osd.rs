#![allow(dead_code)]

use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager, PhysicalPosition, Position, WebviewUrl, WebviewWindowBuilder};
use crate::config::{OsdConfig, OsdPosition};

#[derive(Debug, Clone, Serialize)]
pub struct OsdPayload {
    pub volume: f32,
    pub muted: bool,
    pub target: String,
    pub duration_ms: u32,
    pub position: OsdPosition,
    pub theme: String,
}

pub fn is_foreground_fullscreen() -> bool {
    OsdManager::is_fullscreen_active()
}

#[derive(Default)]
pub struct OsdManager;

impl OsdManager {
    pub fn new() -> Self {
        Self
    }

    /// Checks if the foreground application is currently in fullscreen mode.
    pub fn is_fullscreen_active() -> bool {
        #[cfg(target_os = "windows")]
        {
            use windows::Win32::Foundation::RECT;
            use windows::Win32::UI::WindowsAndMessaging::{
                GetDesktopWindow, GetForegroundWindow, GetShellWindow, GetWindowRect,
            };

            // SAFETY: Calling standard Win32 APIs to inspect foreground window bounds
            unsafe {
                let fg = GetForegroundWindow();
                if fg.0.is_null() || fg == GetDesktopWindow() || fg == GetShellWindow() {
                    return false;
                }

                let mut rect = RECT::default();
                if GetWindowRect(fg, &mut rect).is_ok() {
                    let w = (rect.right - rect.left).abs();
                    let h = (rect.bottom - rect.top).abs();
                    // Fullscreen threshold check against common display resolutions
                    if w >= 1920 && h >= 1080 {
                        return true;
                    }
                }
            }
            false
        }
        #[cfg(not(target_os = "windows"))]
        {
            false
        }
    }

    /// Displays or updates the On-Screen Display (OSD) volume notification overlay.
    pub fn show_volume(
        &self,
        app: &AppHandle,
        config: &OsdConfig,
        level: f32,
        muted: bool,
        target_name: &str,
    ) {
        if !config.enabled {
            return;
        }

        if config.hide_in_fullscreen && Self::is_fullscreen_active() {
            log::debug!("OSD suppressed: fullscreen application active");
            return;
        }

        let osd_win = match app.get_webview_window("volzone-osd") {
            Some(w) => w,
            None => {
                let url = WebviewUrl::App("index.html?view=osd".into());
                match WebviewWindowBuilder::new(app, "volzone-osd", url)
                    .title("VolZone OSD")
                    .transparent(true)
                    .decorations(false)
                    .always_on_top(true)
                    .skip_taskbar(true)
                    .focusable(false)
                    .shadow(false)
                    .inner_size(240.0, 70.0)
                    .build()
                {
                    Ok(w) => {
                        let _ = w.set_ignore_cursor_events(true);
                        w
                    }
                    Err(e) => {
                        log::error!("Failed to create OSD window: {e}");
                        return;
                    }
                }
            }
        };

        // Position OSD according to configuration
        if let Ok(monitors) = app.available_monitors() {
            if let Some(m) = monitors.first() {
                let m_pos = m.position();
                let m_size = m.size();

                let (x, y) = match config.position {
                    OsdPosition::Top => (
                        m_pos.x + (m_size.width as i32 / 2) - 120,
                        m_pos.y + 60,
                    ),
                    OsdPosition::Bottom => (
                        m_pos.x + (m_size.width as i32 / 2) - 120,
                        m_pos.y + (m_size.height as i32) - 130,
                    ),
                    OsdPosition::Center | OsdPosition::NearCursor => (
                        m_pos.x + (m_size.width as i32 / 2) - 120,
                        m_pos.y + (m_size.height as i32 / 2) - 35,
                    ),
                };

                let _ = osd_win.set_position(Position::Physical(PhysicalPosition::new(x, y)));
            }
        }

        let _ = osd_win.show();

        let payload = OsdPayload {
            volume: level,
            muted,
            target: target_name.to_string(),
            duration_ms: config.duration_ms,
            position: config.position,
            theme: config.theme.clone(),
        };

        let _ = app.emit("osd-show", payload);
    }
}
