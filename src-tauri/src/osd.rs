#![allow(dead_code)]

use crate::config::{OsdConfig, OsdPosition};
use serde::Serialize;
use std::sync::{Mutex, OnceLock};
use std::time::{SystemTime, UNIX_EPOCH};
use tauri::{
    AppHandle, Emitter, Manager, PhysicalPosition, Position, WebviewUrl, WebviewWindow,
    WebviewWindowBuilder,
};

#[derive(Debug, Clone, Serialize)]
pub struct OsdPayload {
    pub volume: f32,
    pub muted: bool,
    pub target: String,
    pub duration_ms: u32,
    pub position: OsdPosition,
    pub theme: String,
    pub accent_color: String,
    pub scale: f32,
    pub show_percentage: bool,
    pub show_target: bool,
}

struct StoredOsd {
    payload: OsdPayload,
    timestamp_ms: u64,
}

static LAST_OSD: OnceLock<Mutex<Option<StoredOsd>>> = OnceLock::new();

fn last_osd_store() -> &'static Mutex<Option<StoredOsd>> {
    LAST_OSD.get_or_init(|| Mutex::new(None))
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}

pub fn get_recent_osd_payload() -> Option<OsdPayload> {
    let guard = last_osd_store().lock().ok()?;
    let stored = guard.as_ref()?;
    if now_ms().saturating_sub(stored.timestamp_ms) <= 3000 {
        Some(stored.payload.clone())
    } else {
        None
    }
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

    /// Checks if the foreground application is genuinely in borderless fullscreen mode.
    pub fn is_fullscreen_active() -> bool {
        #[cfg(target_os = "windows")]
        {
            use windows::Win32::Foundation::RECT;
            use windows::Win32::UI::WindowsAndMessaging::{
                GetDesktopWindow, GetForegroundWindow, GetShellWindow, GetSystemMetrics,
                GetWindowLongPtrW, GetWindowRect, GWL_STYLE, SM_CXSCREEN, SM_CYSCREEN, WS_CAPTION,
            };

            // SAFETY: Calling standard Win32 APIs to inspect foreground window bounds and style
            unsafe {
                let fg = GetForegroundWindow();
                if fg.0.is_null() || fg == GetDesktopWindow() || fg == GetShellWindow() {
                    return false;
                }

                let style = GetWindowLongPtrW(fg, GWL_STYLE);
                let has_caption = (style & (WS_CAPTION.0 as isize)) == (WS_CAPTION.0 as isize);
                if has_caption {
                    // Normal or maximized titled windows should not suppress OSD
                    return false;
                }

                let cx = GetSystemMetrics(SM_CXSCREEN).max(800);
                let cy = GetSystemMetrics(SM_CYSCREEN).max(600);

                let mut rect = RECT::default();
                if GetWindowRect(fg, &mut rect).is_ok() {
                    let w = (rect.right - rect.left).abs();
                    let h = (rect.bottom - rect.top).abs();
                    if w >= cx && h >= cy {
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

    fn compute_dimensions(theme: &str, scale_raw: f32, dpi_scale: f32) -> (i32, i32, f32) {
        let user_scale = if scale_raw <= 0.1 {
            1.0
        } else {
            scale_raw.clamp(0.75, 1.5)
        };
        let total_scale = user_scale * dpi_scale.max(1.0);
        let (base_w, base_h) = match theme {
            "volume2_vertical" => (130, 320),
            "macos_hud" => (210, 210),
            "circular_dial" | "rotary_knob" | "oled_badge" => (190, 190),
            "win10_flyout" => (350, 145),
            "win11_flyout" | "minimal_line" | "compact_pill" => (340, 120),
            _ => (390, 155),
        };
        let win_w = ((base_w as f32) * total_scale).round() as i32;
        let win_h = ((base_h as f32) * total_scale).round() as i32;
        (win_w, win_h, user_scale)
    }

    fn ensure_osd_window_on_main_thread(
        app: &AppHandle,
        win_w: i32,
        win_h: i32,
        initially_visible: bool,
    ) -> Option<WebviewWindow> {
        if let Some(w) = app.get_webview_window("volzone-osd") {
            return Some(w);
        }

        let url = WebviewUrl::App("index.html?view=osd".into());
        match WebviewWindowBuilder::new(app, "volzone-osd", url)
            .title("Volume 3 OSD")
            .transparent(true)
            .decorations(false)
            .always_on_top(true)
            .skip_taskbar(true)
            .focusable(false)
            .shadow(false)
            .visible(initially_visible)
            .inner_size(win_w as f64, win_h as f64)
            .build()
        {
            Ok(w) => {
                let _ = w.set_ignore_cursor_events(true);
                #[cfg(target_os = "windows")]
                {
                    use windows::Win32::Foundation::HWND;
                    use windows::Win32::UI::WindowsAndMessaging::{
                        GetWindowLongPtrW, SetWindowLongPtrW, GWL_EXSTYLE, WS_EX_NOACTIVATE,
                        WS_EX_TOOLWINDOW, WS_EX_TRANSPARENT,
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
                log::info!("Created Volume 3 OSD overlay window ({win_w}x{win_h})");
                Some(w)
            }
            Err(e) => {
                log::error!("Failed to create OSD window: {e}");
                None
            }
        }
    }

    /// Pre-initializes the hidden OSD window during app startup on the UI main thread
    /// so its WebView2 context is loaded and ready for instant feedback on the first scroll.
    pub fn init_osd_window(&self, app: &AppHandle) {
        let _ = Self::ensure_osd_window_on_main_thread(app, 390, 155, false);
    }

    fn compute_position(app: &AppHandle, position: OsdPosition, win_w: i32, win_h: i32) -> (i32, i32) {
        let monitor = app
            .primary_monitor()
            .ok()
            .flatten()
            .or_else(|| app.available_monitors().ok().and_then(|mut m| m.drain(..).next()));

        let Some(m) = monitor else {
            return (80, 80);
        };

        let m_pos = m.position();
        let m_size = m.size();

        match position {
            OsdPosition::TopCenter => (
                m_pos.x + (m_size.width as i32 / 2) - (win_w / 2),
                m_pos.y + 40,
            ),
            OsdPosition::TopLeft => (m_pos.x + 40, m_pos.y + 40),
            OsdPosition::TopRight => (m_pos.x + (m_size.width as i32) - win_w - 40, m_pos.y + 40),
            OsdPosition::BottomCenter => (
                m_pos.x + (m_size.width as i32 / 2) - (win_w / 2),
                m_pos.y + (m_size.height as i32) - win_h - 56,
            ),
            OsdPosition::BottomLeft => (
                m_pos.x + 40,
                m_pos.y + (m_size.height as i32) - win_h - 56,
            ),
            OsdPosition::BottomRight => (
                m_pos.x + (m_size.width as i32) - win_w - 32,
                m_pos.y + (m_size.height as i32) - win_h - 56,
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
                        let max_x = (m_pos.x + m_size.width as i32 - win_w - 12).max(m_pos.x);
                        let max_y = (m_pos.y + m_size.height as i32 - win_h - 12).max(m_pos.y);
                        (
                            (pt.x + 20).clamp(m_pos.x + 12, max_x),
                            (pt.y - win_h - 16).clamp(m_pos.y + 12, max_y),
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
        }
    }

    /// Displays or updates the On-Screen Display (OSD) volume notification overlay.
    /// Safely dispatches window operations to Tauri's main UI thread so background
    /// input workers or IPC handlers never deadlock on WebView2 creation.
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

        let theme_name = config.theme.clone();
        let scale_raw = config.scale;
        let (_, _, user_scale) = Self::compute_dimensions(&theme_name, scale_raw, 1.0);

        let payload = OsdPayload {
            volume: level,
            muted,
            target: target_name.to_string(),
            duration_ms: config.duration_ms,
            position: config.position,
            theme: theme_name.clone(),
            accent_color: if config.accent_color.is_empty() {
                "#38bdf8".to_string()
            } else {
                config.accent_color.clone()
            },
            scale: user_scale,
            show_percentage: config.show_percentage,
            show_target: config.show_target,
        };

        if let Ok(mut guard) = last_osd_store().lock() {
            *guard = Some(StoredOsd {
                payload: payload.clone(),
                timestamp_ms: now_ms(),
            });
        }

        let app_handle = app.clone();
        let position = config.position;
        if let Err(err) = app.run_on_main_thread(move || {
            let dpi_scale = app_handle
                .primary_monitor()
                .ok()
                .flatten()
                .map(|m| m.scale_factor() as f32)
                .unwrap_or(1.0);
            let (win_w, win_h, _) = Self::compute_dimensions(&theme_name, scale_raw, dpi_scale);

            let Some(osd_win) =
                Self::ensure_osd_window_on_main_thread(&app_handle, win_w, win_h, true)
            else {
                return;
            };

            let (x, y) = Self::compute_position(&app_handle, position, win_w, win_h);

            let _ = osd_win.set_size(tauri::Size::Physical(tauri::PhysicalSize::new(
                win_w as u32,
                win_h as u32,
            )));
            let _ = osd_win.set_position(Position::Physical(PhysicalPosition::new(x, y)));
            let _ = osd_win.show();
            let _ = osd_win.set_always_on_top(true);

            #[cfg(target_os = "windows")]
            {
                use windows::Win32::Foundation::HWND;
                use windows::Win32::UI::WindowsAndMessaging::{
                    SetWindowPos, HWND_TOPMOST, SWP_NOACTIVATE, SWP_SHOWWINDOW,
                };
                if let Ok(hwnd) = osd_win.hwnd() {
                    unsafe {
                        let _ = SetWindowPos(
                            HWND(hwnd.0),
                            Some(HWND_TOPMOST),
                            x,
                            y,
                            win_w,
                            win_h,
                            SWP_SHOWWINDOW | SWP_NOACTIVATE,
                        );
                    }
                }
            }

            log::info!(
                "OSD displayed: theme={}, vol={:.0}%, pos=({},{}) size={}x{}",
                payload.theme,
                payload.volume * 100.0,
                x,
                y,
                win_w,
                win_h
            );
            let _ = osd_win.emit("osd-show", payload.clone());
            let _ = app_handle.emit("osd-show", payload);
        }) {
            log::warn!("Failed to schedule OSD display on main thread: {err}");
        }
    }
}
