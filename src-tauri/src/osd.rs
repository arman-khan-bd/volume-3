#![allow(dead_code)]

use crate::config::{OsdConfig, OsdPosition};
use serde::Serialize;
use tauri::{
    AppHandle, Emitter, Manager, PhysicalPosition, Position, WebviewUrl, WebviewWindowBuilder,
};

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

        let win_w = 380;
        let win_h = 160;

        let osd_win = match app.get_webview_window("volzone-osd") {
            Some(w) => w,
            None => {
                let url = WebviewUrl::App("index.html".into());
                match WebviewWindowBuilder::new(app, "volzone-osd", url)
                    .title("VolZone OSD")
                    .transparent(true)
                    .decorations(false)
                    .always_on_top(true)
                    .skip_taskbar(true)
                    .focusable(false)
                    .shadow(false)
                    .inner_size(win_w as f64, win_h as f64)
                    .build()
                {
                    Ok(w) => {
                        let _ = w.set_ignore_cursor_events(true);
                        #[cfg(target_os = "windows")]
                        {
                            use windows::Win32::Foundation::HWND;
                            use windows::Win32::UI::WindowsAndMessaging::{
                                GetWindowLongPtrW, SetWindowLongPtrW, GWL_EXSTYLE,
                                WS_EX_NOACTIVATE, WS_EX_TOOLWINDOW, WS_EX_TRANSPARENT,
                            };
                            if let Ok(hwnd) = w.hwnd() {
                                let hwnd = HWND(hwnd.0);
                                unsafe {
                                    let cur_style = GetWindowLongPtrW(hwnd, GWL_EXSTYLE);
                                    let new_style = cur_style
                                        | (WS_EX_NOACTIVATE.0 as isize)
                                        | (WS_EX_TOOLWINDOW.0 as isize)
                                        | (WS_EX_TRANSPARENT.0 as isize);
                                    SetWindowLongPtrW(hwnd, GWL_EXSTYLE, new_style);
                                }
                            }
                        }
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
                    OsdPosition::TopCenter => (
                        m_pos.x + (m_size.width as i32 / 2) - (win_w / 2),
                        m_pos.y + 40,
                    ),
                    OsdPosition::TopLeft => (m_pos.x + 40, m_pos.y + 40),
                    OsdPosition::TopRight => (
                        m_pos.x + (m_size.width as i32) - win_w - 40,
                        m_pos.y + 40,
                    ),
                    OsdPosition::BottomCenter => (
                        m_pos.x + (m_size.width as i32 / 2) - (win_w / 2),
                        m_pos.y + (m_size.height as i32) - win_h - 40,
                    ),
                    OsdPosition::BottomLeft => (
                        m_pos.x + 40,
                        m_pos.y + (m_size.height as i32) - win_h - 40,
                    ),
                    OsdPosition::BottomRight => (
                        m_pos.x + (m_size.width as i32) - win_w - 40,
                        m_pos.y + (m_size.height as i32) - win_h - 40,
                    ),
                    OsdPosition::Center => (
                        m_pos.x + (m_size.width as i32 / 2) - (win_w / 2),
                        m_pos.y + (m_size.height as i32 / 2) - (win_h / 2),
                    ),
                    OsdPosition::NearCursor => {
                        #[cfg(target_os = "windows")]
                        {
                            use windows::Win32::Foundation::POINT;
                            use windows::Win32::UI::WindowsAndMessaging::GetCursorPos;
                            let mut pt = POINT::default();
                            if unsafe { GetCursorPos(&mut pt).is_ok() } {
                                (
                                    (pt.x + 20).min(m_pos.x + m_size.width as i32 - win_w),
                                    (pt.y + 20).min(m_pos.y + m_size.height as i32 - win_h),
                                )
                            } else {
                                (
                                    m_pos.x + (m_size.width as i32 / 2) - (win_w / 2),
                                    m_pos.y + (m_size.height as i32 / 2) - (win_h / 2),
                                )
                            }
                        }
                        #[cfg(not(target_os = "windows"))]
                        {
                            (
                                m_pos.x + (m_size.width as i32 / 2) - (win_w / 2),
                                m_pos.y + (m_size.height as i32 / 2) - (win_h / 2),
                            )
                        }
                    }
                };

                let _ = osd_win.set_position(Position::Physical(PhysicalPosition::new(x, y)));
                let _ = osd_win.set_size(tauri::Size::Physical(tauri::PhysicalSize::new(
                    win_w as u32,
                    win_h as u32,
                )));
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
