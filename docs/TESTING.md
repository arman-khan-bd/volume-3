# VolZone Manual QA & Verification Test Matrix

This document defines the comprehensive manual test protocol for verifying VolZone across all supported desktop platforms, display configurations, audio servers, and edge cases.

---

## 1. Test Environment Matrix

| ID | Operating System | Window System | Audio Server | Hardware / Architecture |
| :--- | :--- | :--- | :--- | :--- |
| **ENV-WIN10** | Windows 10 (22H2) | DWM | WASAPI | x86_64 |
| **ENV-WIN11** | Windows 11 (23H2 / 24H2) | DWM | WASAPI | x86_64 / ARM64 |
| **ENV-MAC-INTEL** | macOS 12 Monterey / 13 Ventura | Quartz / Aqua | CoreAudio | Intel x86_64 |
| **ENV-MAC-ARM** | macOS 14 Sonoma / 15 Sequoia | Quartz / Aqua | CoreAudio | Apple Silicon (M1/M2/M3/M4) |
| **ENV-UBUNTU-X11** | Ubuntu 22.04 / 24.04 LTS | X11 (Xorg) | PipeWire / PulseAudio | x86_64 |
| **ENV-UBUNTU-WAY** | Ubuntu 24.04 LTS (GNOME 46) | Wayland (Mutter) | PipeWire | x86_64 |
| **ENV-FEDORA-KDE** | Fedora 40 / 41 | Wayland (KWin) | PipeWire | x86_64 |

---

## 2. Core Functional Test Scenarios

### Scenario 1: Wheel-Only Consumption Inside Zone
- **Goal**: Confirm that scrolling inside an active zone adjusts volume and **never** scrolls the window underneath.
- **Steps**:
  1. Open a scrollable web page (e.g., a long document or Wikipedia article) in a browser.
  2. Position an enabled VolZone overlay over the text area.
  3. Place cursor directly inside the zone and roll the mouse wheel.
- **Expected Outcome**:
  - System or target volume increases/decreases smoothly.
  - The browser page underneath remains stationary and does **not** scroll up or down by even one pixel.
  - OSD shows current volume percentage and target name.

---

### Scenario 2: Wheel Outside Zone is Completely Untouched
- **Goal**: Confirm that cursor movement and wheel events outside zone boundaries are never intercepted, delayed, or altered.
- **Steps**:
  1. Move cursor 5 pixels outside the zone boundary over the scrollable browser window.
  2. Roll the mouse wheel up and down.
- **Expected Outcome**:
  - The document underneath scrolls normally.
  - System volume remains unchanged.
  - Zero input latency or stuttering.

---

### Scenario 3: Transparent Click, Drag & Hover Pass-Through
- **Goal**: Verify that clicks, double-clicks, text selections, context menus, and hover states pass through the zone to the window below.
- **Steps**:
  1. Place an active zone over text links and buttons on a web page or desktop application.
  2. Move cursor into the zone: observe hover states on links/buttons below.
  3. Single-click a button below the zone.
  4. Double-click or click-and-drag across text beneath the zone to highlight words.
  5. Right-click inside the zone to summon a context menu.
- **Expected Outcome**:
  - In normal (locked) mode, the zone window has `WS_EX_TRANSPARENT` / `set_ignore_cursor_events(true)`.
  - All clicks, selections, double-clicks, and context menus interact directly with the underlying app.
  - The zone never captures focus or activates its own window.

---

### Scenario 4: Fullscreen Video & Gaming Auto-Suppression
- **Goal**: Verify that zones auto-disable when a fullscreen application or game is focused to avoid accidental wheel interference.
- **Steps**:
  1. In VolZone Settings, verify "Auto-disable zones when games / fullscreen apps are focused" is enabled.
  2. Launch a game or enter fullscreen on a video player (e.g., YouTube in Chrome via `F11` / fullscreen button, or VLC).
  3. Scroll the mouse wheel in the area where a screen zone was located.
- **Expected Outcome**:
  - `is_foreground_fullscreen()` detects fullscreen geometry.
  - Zone wheel hook immediately passes through events to the game or media player.
  - OSD is suppressed and does not overlay the fullscreen surface.

---

### Scenario 5: Multi-Monitor & Mixed-DPI Scaling
- **Goal**: Ensure zones maintain correct physical pixel dimensions and screen positions across displays with different scaling factors.
- **Setup**: Monitor 1 at 1920x1080 (100% scale) and Monitor 2 at 3840x2160 (150% or 200% scale).
- **Steps**:
  1. Create a zone on Monitor 1 and another on Monitor 2.
  2. Verify zone borders and hit-testing on both monitors.
  3. Unplug Monitor 2 (simulate hot-unplug), then reconnect Monitor 2.
- **Expected Outcome**:
  - Hit testing uses exact physical coordinates (`tauri::PhysicalPosition`), preventing DPI drift.
  - When disconnected, `adjust_zone_for_monitors` automatically clamps bounds onto the primary display.
  - Reconnecting displays restores positions without application crashing.

---

### Scenario 6: System Sleep and Wake Resume
- **Goal**: Confirm low-level hooks, audio endpoint callbacks, and watchdog threads survive system sleep and hibernation.
- **Steps**:
  1. Put the operating system to Sleep or Hibernate while VolZone is running.
  2. Wake the system and log in.
  3. Scroll inside an active zone.
- **Expected Outcome**:
  - Hook thread and watchdog thread resume normally without throwing watchdog stall errors.
  - WASAPI / CoreAudio / PipeWire backend reconnects to active audio devices without crashing.

---

### Scenario 7: Dynamic Audio Output Device Switching
- **Goal**: Verify audio device listener reflects hot-plugged headphones or DACs.
- **Steps**:
  1. Play audio through built-in laptop speakers.
  2. Plug in 3.5mm headphones or a USB audio DAC / Bluetooth headset.
  3. Scroll inside a Master volume zone.
- **Expected Outcome**:
  - Windows `IMMNotificationClient` / PipeWire device listener detects default device change.
  - Volume adjustments instantly apply to the newly selected default output device.
  - Tray tooltip and OSD update to reflect the new device volume level.

---

### Scenario 8: Elevated Windows (Windows UIPI)
- **Goal**: Verify scroll-wheel behavior over elevated processes (Task Manager, Administrative PowerShell).
- **Steps**:
  1. Open an elevated Task Manager (`Run as Administrator`).
  2. In VolZone Settings, toggle "Run with Administrator Privileges" on/off.
  3. Move an active zone over Task Manager and scroll the wheel.
- **Expected Outcome**:
  - When standard (non-elevated): Windows UIPI security isolates hooks; wheel events pass through safely.
  - When VolZone is elevated (`is_elevated_admin`): VolZone successfully hooks and adjusts volume over elevated windows without hanging.

---

### Scenario 9: Touchpad Smooth Scrolling vs. Discrete Wheel Ticks
- **Goal**: Verify high-precision touchpad delta normalization and standard 120-unit wheel detents.
- **Steps**:
  1. Scroll with a physical mouse wheel (detented 120-unit clicks).
  2. Scroll with a precision laptop touchpad (smooth two-finger scroll producing fractional deltas like ±15, ±30).
- **Expected Outcome**:
  - Physical mouse produces crisp, discrete percentage steps (e.g. +2% per click).
  - Touchpad smooth scrolling accumulates fractional deltas without jitter, runaway acceleration, or audio freezing.

---

### Scenario 10: Emergency Panic Hotkey & Watchdog Safety
- **Goal**: Verify that all hooks can be killed instantly in an emergency.
- **Steps**:
  1. Press `Ctrl + Alt + Shift + Escape` (or `Ctrl + Alt + Shift + P`).
  2. Observe system state:
     - Tray tooltip changes to `VolZone [EMERGENCY PANIC: Hooks Removed]`.
     - Settings window displays the red recovery banner.
     - Rolling the wheel inside any zone passes through completely untouched.
  3. Click "Resume Wheel Hooks" in the Settings window.
- **Expected Outcome**:
  - All hooks are immediately uninstalled with zero system lockups.
  - Resuming restores normal zone operation seamlessly.

---

## 3. QA Sign-Off Checklist

- [ ] All 26 Rust backend unit tests pass (`cargo test`).
- [ ] TypeScript and Vite UI compiles without errors or warnings (`npm run build`).
- [ ] Zero compiler warnings (`cargo check`).
- [ ] Rotating log files created in `%LOCALAPPDATA%\VolZone\logs\` (or OS equivalent).
- [ ] Installer builds cleanly with `@tauri-apps/cli build`.
- [ ] Idle CPU usage remains under 0.1% when not scrolling.
