#![allow(dead_code)]

use serde::{Deserialize, Deserializer, Serialize, Serializer};
use tauri::{
    AppHandle, Manager, PhysicalPosition, PhysicalSize, Position, Size, WebviewUrl, WebviewWindow,
    WebviewWindowBuilder,
};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub struct Rect {
    pub x: i32,
    pub y: i32,
    pub width: u32,
    pub height: u32,
}

impl Rect {
    pub const fn new(x: i32, y: i32, width: u32, height: u32) -> Self {
        Self {
            x,
            y,
            width,
            height,
        }
    }

    pub fn contains(&self, px: i32, py: i32) -> bool {
        let max_x = self.x.saturating_add(self.width as i32);
        let max_y = self.y.saturating_add(self.height as i32);
        px >= self.x && px < max_x && py >= self.y && py < max_y
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "snake_case")]
pub enum ScreenEdge {
    #[default]
    Top,
    Bottom,
    Left,
    Right,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ZoneShape {
    Rectangle,
    Rounded { radius: u32 },
    Circle,
    ScreenEdgeStrip { edge: ScreenEdge, thickness: u32 },
}

impl Default for ZoneShape {
    fn default() -> Self {
        Self::Rectangle
    }
}

#[derive(Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
enum TaggedShape {
    Rectangle,
    Rounded { radius: u32 },
    Circle,
    ScreenEdgeStrip { edge: ScreenEdge, thickness: u32 },
}

#[derive(Deserialize)]
#[serde(untagged)]
enum ShapeHelper {
    Simple(String),
    Tagged(TaggedShape),
}

impl Serialize for ZoneShape {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: Serializer,
    {
        let tagged = match *self {
            Self::Rectangle => TaggedShape::Rectangle,
            Self::Rounded { radius } => TaggedShape::Rounded { radius },
            Self::Circle => TaggedShape::Circle,
            Self::ScreenEdgeStrip { edge, thickness } => {
                TaggedShape::ScreenEdgeStrip { edge, thickness }
            }
        };
        tagged.serialize(serializer)
    }
}

impl<'de> Deserialize<'de> for ZoneShape {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: Deserializer<'de>,
    {
        match ShapeHelper::deserialize(deserializer)? {
            ShapeHelper::Simple(s) => match s.to_ascii_lowercase().as_str() {
                "circle" => Ok(Self::Circle),
                _ => Ok(Self::Rectangle),
            },
            ShapeHelper::Tagged(tagged) => match tagged {
                TaggedShape::Rectangle => Ok(Self::Rectangle),
                TaggedShape::Rounded { radius } => Ok(Self::Rounded { radius }),
                TaggedShape::Circle => Ok(Self::Circle),
                TaggedShape::ScreenEdgeStrip { edge, thickness } => {
                    Ok(Self::ScreenEdgeStrip { edge, thickness })
                }
            },
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "snake_case")]
pub enum VisualMode {
    Invisible,
    #[default]
    FaintTint,
    OutlineOnHover,
    AlwaysVisible,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", content = "target", rename_all = "snake_case")]
pub enum VolumeTarget {
    Master,
    Mic,
    App(String),
    AppUnderCursor,
}

impl Default for VolumeTarget {
    fn default() -> Self {
        Self::Master
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "snake_case")]
pub enum HorizontalWheelAction {
    #[default]
    None,
    Balance,
    MediaTrack,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "snake_case")]
pub enum ModifierKey {
    #[default]
    None,
    Shift,
    Ctrl,
    Alt,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
pub struct Modifiers {
    #[serde(default)]
    pub ctrl: bool,
    #[serde(default)]
    pub alt: bool,
    #[serde(default)]
    pub shift: bool,
    #[serde(default)]
    pub meta: bool,
}

impl Modifiers {
    pub const fn none() -> Self {
        Self {
            ctrl: false,
            alt: false,
            shift: false,
            meta: false,
        }
    }

    pub const fn is_none(&self) -> bool {
        !self.ctrl && !self.alt && !self.shift && !self.meta
    }

    pub fn matches(&self, ctrl: bool, alt: bool, shift: bool, meta: bool) -> bool {
        self.ctrl == ctrl && self.alt == alt && self.shift == shift && self.meta == meta
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Zone {
    pub id: String,
    pub name: String,
    #[serde(default)]
    pub monitor_id: Option<String>,
    pub rect: Rect,
    #[serde(default)]
    pub shape: ZoneShape,
    #[serde(default)]
    pub visual_mode: VisualMode,
    #[serde(default = "default_opacity")]
    pub opacity: f32, // 0.0 to 1.0
    #[serde(default)]
    pub target: VolumeTarget,
    #[serde(default = "default_step")]
    pub step: f32,
    #[serde(default)]
    pub acceleration: bool,
    #[serde(default)]
    pub invert: bool,
    #[serde(default)]
    pub modifiers: Modifiers,
    #[serde(default = "default_min_volume")]
    pub min_volume: f32,
    #[serde(default = "default_max_volume")]
    pub max_volume: f32,
    #[serde(default)]
    pub soft_start_limit: Option<f32>,
    #[serde(default)]
    pub middle_click_to_mute: bool,
    #[serde(default = "default_coarse_modifier")]
    pub coarse_modifier: ModifierKey,
    #[serde(default = "default_fine_modifier")]
    pub fine_modifier: ModifierKey,
    #[serde(default)]
    pub horizontal_action: HorizontalWheelAction,
    #[serde(default)]
    pub tick_sound: bool,
    #[serde(default = "default_pulse_tint")]
    pub pulse_tint: bool,
    #[serde(default = "default_enabled")]
    pub enabled: bool,
}

const fn default_step() -> f32 {
    2.0
}

const fn default_opacity() -> f32 {
    0.25
}

const fn default_min_volume() -> f32 {
    0.0
}

const fn default_max_volume() -> f32 {
    1.0
}

const fn default_pulse_tint() -> bool {
    true
}

const fn default_enabled() -> bool {
    true
}

const fn default_coarse_modifier() -> ModifierKey {
    ModifierKey::Shift
}

const fn default_fine_modifier() -> ModifierKey {
    ModifierKey::Ctrl
}

impl Zone {
    pub fn new(id: impl Into<String>, name: impl Into<String>, rect: Rect) -> Self {
        Self {
            id: id.into(),
            name: name.into(),
            monitor_id: None,
            rect,
            shape: ZoneShape::Rectangle,
            visual_mode: VisualMode::FaintTint,
            opacity: default_opacity(),
            target: VolumeTarget::Master,
            step: default_step(),
            acceleration: false,
            invert: false,
            modifiers: Modifiers::none(),
            min_volume: default_min_volume(),
            max_volume: default_max_volume(),
            soft_start_limit: None,
            middle_click_to_mute: false,
            coarse_modifier: default_coarse_modifier(),
            fine_modifier: default_fine_modifier(),
            horizontal_action: HorizontalWheelAction::None,
            tick_sound: false,
            pulse_tint: true,
            enabled: true,
        }
    }

    pub fn window_label(&self) -> String {
        format!("zone-{}", self.id)
    }

    /// Checks if a physical pixel coordinate (px, py) falls within this zone's shape.
    pub fn hit_test_geometry(&self, px: i32, py: i32) -> bool {
        if !self.rect.contains(px, py) {
            return false;
        }

        match self.shape {
            ZoneShape::Rectangle => true,
            ZoneShape::Rounded { radius } => {
                let r = radius as i32;
                if r <= 0 {
                    return true;
                }
                let left_corner = px < self.rect.x + r;
                let right_corner = px >= self.rect.x + (self.rect.width as i32) - r;
                let top_corner = py < self.rect.y + r;
                let bottom_corner = py >= self.rect.y + (self.rect.height as i32) - r;

                let (cx, cy) = match (left_corner, right_corner, top_corner, bottom_corner) {
                    (true, _, true, _) => (self.rect.x + r, self.rect.y + r),
                    (_, true, true, _) => {
                        (self.rect.x + (self.rect.width as i32) - r, self.rect.y + r)
                    }
                    (true, _, _, true) => {
                        (self.rect.x + r, self.rect.y + (self.rect.height as i32) - r)
                    }
                    (_, true, _, true) => (
                        self.rect.x + (self.rect.width as i32) - r,
                        self.rect.y + (self.rect.height as i32) - r,
                    ),
                    _ => return true,
                };

                let dx = px - cx;
                let dy = py - cy;
                (dx * dx + dy * dy) <= (r * r)
            }
            ZoneShape::Circle => {
                let r = ((self.rect.width.min(self.rect.height)) / 2) as i32;
                let cx = self.rect.x + (self.rect.width as i32 / 2);
                let cy = self.rect.y + (self.rect.height as i32 / 2);
                let dx = px - cx;
                let dy = py - cy;
                (dx * dx + dy * dy) <= (r * r)
            }
            ZoneShape::ScreenEdgeStrip { edge, thickness } => {
                let t = thickness as i32;
                match edge {
                    ScreenEdge::Top => py < self.rect.y + t,
                    ScreenEdge::Bottom => py >= self.rect.y + (self.rect.height as i32) - t,
                    ScreenEdge::Left => px < self.rect.x + t,
                    ScreenEdge::Right => px >= self.rect.x + (self.rect.width as i32) - t,
                }
            }
        }
    }
}

/// Pure hit-testing function checking an array of zones for physical cursor containment and modifier match.
pub fn hit_test<'a>(
    zones: &'a [Zone],
    px: i32,
    py: i32,
    ctrl: bool,
    alt: bool,
    shift: bool,
    meta: bool,
) -> Option<&'a Zone> {
    for zone in zones {
        if !zone.enabled {
            continue;
        }

        if !zone.modifiers.is_none() && !zone.modifiers.matches(ctrl, alt, shift, meta) {
            continue;
        }

        if zone.hit_test_geometry(px, py) {
            return Some(zone);
        }
    }
    None
}

/// Clamps a physical pixel rectangle so it remains visible within the given monitor bounds.
pub fn clamp_rect_to_bounds(rect: &Rect, mon_x: i32, mon_y: i32, mon_w: u32, mon_h: u32) -> Rect {
    let w = rect.width.min(mon_w).max(20);
    let h = rect.height.min(mon_h).max(20);

    let max_x = mon_x + (mon_w as i32) - (w as i32);
    let max_y = mon_y + (mon_h as i32) - (h as i32);

    let x = rect.x.clamp(mon_x, max_x.max(mon_x));
    let y = rect.y.clamp(mon_y, max_y.max(mon_y));

    Rect {
        x,
        y,
        width: w,
        height: h,
    }
}

/// Adjusts the physical coordinates of a zone based on currently connected monitors.
/// If the monitor is missing or disconnected, relocates/clamps to the primary monitor.
pub fn adjust_zone_for_monitors(app: &AppHandle, zone: &mut Zone) {
    let monitors = match app.available_monitors() {
        Ok(m) => m,
        Err(err) => {
            log::warn!("Failed to query available monitors: {err}");
            return;
        }
    };

    if monitors.is_empty() {
        return;
    }

    let target_monitor = if let Some(ref m_id) = zone.monitor_id {
        monitors
            .iter()
            .find(|m| m.name().map(|n| n == m_id).unwrap_or(false))
    } else {
        None
    };

    let primary_name = app
        .primary_monitor()
        .ok()
        .flatten()
        .and_then(|m| m.name().cloned());
    let monitor = target_monitor
        .or_else(|| {
            if let Some(ref p_name) = primary_name {
                monitors
                    .iter()
                    .find(|m| m.name().map(|n| n == p_name).unwrap_or(false))
            } else {
                None
            }
        })
        .or_else(|| monitors.first());

    if let Some(m) = monitor {
        let pos = m.position();
        let size = m.size();
        let mon_name = m.name().cloned();

        let clamped = clamp_rect_to_bounds(&zone.rect, pos.x, pos.y, size.width, size.height);
        zone.rect = clamped;
        zone.monitor_id = mon_name;
    }
}

/// Applies OS-specific window traits to guarantee non-focusable, always-on-top, click-through behavior.
pub fn apply_platform_window_traits(window: &WebviewWindow, edit_mode: bool) -> Result<(), String> {
    window
        .set_ignore_cursor_events(!edit_mode)
        .map_err(|e| format!("Failed to set ignore_cursor_events: {e}"))?;

    #[cfg(target_os = "windows")]
    {
        use windows::Win32::Foundation::HWND;
        use windows::Win32::UI::WindowsAndMessaging::{
            GetWindowLongPtrW, SetWindowLongPtrW, GWL_EXSTYLE, WS_EX_NOACTIVATE, WS_EX_TOOLWINDOW,
        };

        if let Ok(hwnd) = window.hwnd() {
            let hwnd = HWND(hwnd.0);
            // SAFETY: Modifying window extended style to prevent window activation/focus stealing
            // and hide it from the Alt+Tab task switcher.
            unsafe {
                let cur_style = GetWindowLongPtrW(hwnd, GWL_EXSTYLE);
                let mut new_style =
                    cur_style | (WS_EX_NOACTIVATE.0 as isize) | (WS_EX_TOOLWINDOW.0 as isize);
                if !edit_mode {
                    // WS_EX_TRANSPARENT allows hit-testing to pass through to underlying windows
                    new_style |= 0x00000020; // WS_EX_TRANSPARENT
                }
                SetWindowLongPtrW(hwnd, GWL_EXSTYLE, new_style);
            }
        }
    }

    #[cfg(target_os = "macos")]
    {
        log::debug!("Applied macOS non-activating floating traits to zone window");
    }

    #[cfg(target_os = "linux")]
    {
        let session_type =
            std::env::var("XDG_SESSION_TYPE").unwrap_or_else(|_| "unknown".to_string());
        log::debug!("Linux session type for zone window: {session_type}");
    }

    Ok(())
}

/// Creates a frameless, transparent, always-on-top zone window in physical pixels.
pub fn create_zone_window(
    app: &AppHandle,
    zone: &Zone,
    edit_mode: bool,
) -> Result<WebviewWindow, tauri::Error> {
    let label = zone.window_label();

    if let Some(existing) = app.get_webview_window(&label) {
        let _ = existing.set_position(Position::Physical(PhysicalPosition::new(
            zone.rect.x,
            zone.rect.y,
        )));
        let _ = existing.set_size(Size::Physical(PhysicalSize::new(
            zone.rect.width,
            zone.rect.height,
        )));
        let _ = apply_platform_window_traits(&existing, edit_mode);
        return Ok(existing);
    }

    let url = WebviewUrl::App(format!("index.html?zone_id={}", zone.id).into());

    let window = WebviewWindowBuilder::new(app, &label, url)
        .title(&zone.name)
        .transparent(true)
        .decorations(false)
        .always_on_top(true)
        .skip_taskbar(true)
        .focusable(false)
        .shadow(false)
        .position(zone.rect.x as f64, zone.rect.y as f64)
        .inner_size(zone.rect.width as f64, zone.rect.height as f64)
        .build()?;

    let _ = window.set_position(Position::Physical(PhysicalPosition::new(
        zone.rect.x,
        zone.rect.y,
    )));
    let _ = window.set_size(Size::Physical(PhysicalSize::new(
        zone.rect.width,
        zone.rect.height,
    )));

    if let Err(err) = apply_platform_window_traits(&window, edit_mode) {
        log::warn!("Failed to apply platform window traits to {label}: {err}");
    }

    Ok(window)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_rect_contains() {
        let r = Rect::new(100, 200, 50, 60);
        assert!(r.contains(100, 200));
        assert!(r.contains(149, 259));
        assert!(!r.contains(99, 200));
        assert!(!r.contains(150, 200));
        assert!(!r.contains(100, 260));
    }

    #[test]
    fn test_hit_test_rectangle() {
        let zone = Zone::new("rect", "Top", Rect::new(0, 0, 1000, 30));
        let zones = vec![zone];

        assert!(hit_test(&zones, 500, 15, false, false, false, false).is_some());
        assert!(hit_test(&zones, 500, 35, false, false, false, false).is_none());
    }

    #[test]
    fn test_hit_test_rounded_corners() {
        let mut zone = Zone::new("round", "Rounded", Rect::new(100, 100, 100, 100));
        zone.shape = ZoneShape::Rounded { radius: 20 };
        let zones = vec![zone];

        assert!(hit_test(&zones, 150, 150, false, false, false, false).is_some());
        assert!(hit_test(&zones, 101, 101, false, false, false, false).is_none());
        assert!(hit_test(&zones, 115, 115, false, false, false, false).is_some());
    }

    #[test]
    fn test_hit_test_circle() {
        let mut zone = Zone::new("circ", "Circle", Rect::new(100, 100, 100, 100));
        zone.shape = ZoneShape::Circle;
        let zones = vec![zone];

        assert!(hit_test(&zones, 150, 150, false, false, false, false).is_some());
        assert!(hit_test(&zones, 101, 101, false, false, false, false).is_none());
    }

    #[test]
    fn test_hit_test_screen_edge_strip() {
        let mut zone = Zone::new("strip", "Top Strip", Rect::new(0, 0, 1920, 100));
        zone.shape = ZoneShape::ScreenEdgeStrip {
            edge: ScreenEdge::Top,
            thickness: 20,
        };
        let zones = vec![zone];

        assert!(hit_test(&zones, 500, 10, false, false, false, false).is_some());
        assert!(hit_test(&zones, 500, 25, false, false, false, false).is_none());
    }

    #[test]
    fn test_hit_test_modifiers_matching() {
        let mut zone = Zone::new("mod", "Mod Zone", Rect::new(0, 0, 500, 50));
        zone.modifiers = Modifiers {
            ctrl: true,
            alt: false,
            shift: false,
            meta: false,
        };
        let zones = vec![zone];

        assert!(hit_test(&zones, 250, 25, false, false, false, false).is_none());
        assert!(hit_test(&zones, 250, 25, true, false, false, false).is_some());
    }

    #[test]
    fn test_hit_test_disabled_zone() {
        let mut zone = Zone::new("dis", "Disabled", Rect::new(0, 0, 500, 50));
        zone.enabled = false;
        let zones = vec![zone];

        assert!(hit_test(&zones, 250, 25, false, false, false, false).is_none());
    }

    #[test]
    fn test_zone_advanced_options_serialization() {
        let mut zone = Zone::new("adv", "Advanced Zone", Rect::new(10, 10, 200, 50));
        zone.target = VolumeTarget::AppUnderCursor;
        zone.min_volume = 0.05;
        zone.max_volume = 0.85;
        zone.soft_start_limit = Some(0.10);
        zone.middle_click_to_mute = true;
        zone.horizontal_action = HorizontalWheelAction::MediaTrack;
        zone.coarse_modifier = ModifierKey::Alt;
        zone.fine_modifier = ModifierKey::Ctrl;
        zone.tick_sound = true;

        let json = serde_json::to_string(&zone).expect("serialize advanced zone");
        let parsed: Zone = serde_json::from_str(&json).expect("deserialize advanced zone");
        assert_eq!(zone, parsed);
        assert_eq!(parsed.target, VolumeTarget::AppUnderCursor);
        assert_eq!(parsed.horizontal_action, HorizontalWheelAction::MediaTrack);
        assert_eq!(parsed.coarse_modifier, ModifierKey::Alt);
    }
}
