# Volume 3

[![CI](https://github.com/arman-khan-bd/volume-3/actions/workflows/ci.yml/badge.svg)](https://github.com/arman-khan-bd/volume-3/actions/workflows/ci.yml)
[![Build All OS](https://github.com/arman-khan-bd/volume-3/actions/workflows/release.yml/badge.svg)](https://github.com/arman-khan-bd/volume-3/actions/workflows/release.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Platform](https://img.shields.io/badge/Platform-Windows%20%7C%20macOS%20%7C%20Linux-brightgreen)](https://github.com/arman-khan-bd/volume-3)

**Volume 3** is an open-source, lightweight cross-platform desktop application inspired by Volume². Instead of hunting for a tiny tray icon or media keys, Volume 3 lets you place transparent scroll-wheel zones anywhere on your screen (such as over the Windows Taskbar, screen edges, or custom floating regions).

Rolling your mouse scroll wheel over an active zone adjusts system, microphone, or application audio immediately with 18 customizable On-Screen Display (OSD) styles, while clicks, drags, and hover events pass right through to the windows underneath.

---

## 🌟 Key Features

- **Strict Wheel-Only Interception**: Wheel events inside active zones adjust audio. Clicks, drags, and hover events pass through untouched to background applications.
- **Interactive Edit Mode (`Ctrl+Alt+V`)**: Drag to reposition, resize with 8 handles, 15px screen-edge snapping, arrow-key nudging (1px / 10px with Shift), and numeric dimension badges.
- **Multiple Shapes & Visual Styles**:
  - Shapes: `Rectangle`, `Rounded Rectangle` (custom radius), `Circle`, and `Screen Edge Strip` (Top, Bottom, Left, Right).
  - Visual Modes: `Invisible`, `Faint Tint`, `Outline on Hover`, and `Always Visible` with adjustable opacity (0%–100%).
- **Multi-Target Audio Backend**:
  - **Master Output**: System primary audio endpoint.
  - **Microphone Input**: Real-time input volume / microphone gain.
  - **Specific Application**: Per-app volume on Windows (WASAPI) and Linux (PulseAudio/PipeWire).
  - **App Under Cursor**: Automatically adjusts the volume of whichever application window is located beneath the pointer.
- **Smart Tuning & Safety Limits**:
  - Non-linear acceleration curve for fast wheel spins (up to 4.5x boost).
  - Remappable Coarse modifier (2.5x) and Fine modifier (0.25x) supporting Shift, Ctrl, and Alt.
  - Hard Minimum and Maximum volume ceilings (0%–100%).
  - **Soft Start Protection**: Configurable maximum volume jump limit per event (e.g. max 5%, 8%, 10%) preventing hearing fatigue.
- **Rich Audio Feedback**:
  - Modern On-Screen Display (OSD) overlay with smooth auto-fade.
  - Visual zone tint pulse on change.
  - Synthesized mechanical click/tick audio feedback via Web Audio API.
  - Live system tray tooltip volume reflection with external change synchronization.
- **Rules & Automation**:
  - Fullscreen & Game Detection: Automatically suppresses zones when games or fullscreen video players are active.
  - Time-Based Night Profiles: Enforces automatic volume ceilings (e.g., max 30% between 22:00 and 07:00) with midnight wraparound support.
  - Named Zone Profiles: Switch whole multi-zone layouts via tray or hotkey.
- **System Safety & Watchdog**:
  - **Emergency Panic Hotkey (`Ctrl+Alt+Shift+Escape`)**: Instantly removes all mouse hooks from memory.
  - **Heartbeat Watchdog**: Dedicated background thread monitors the message loop; if the hook stalls (>5.5s) or crashes, it automatically disengages hooks and alerts the user.
  - **Rotating Logs**: Thread-safe rotating logging in standard OS log folders.

---

## 📦 Installation & Download

Download prebuilt packages from the [Releases](https://github.com/arman-khan-bd/volume-3/releases) page or the latest [GitHub Actions](https://github.com/arman-khan-bd/volume-3/actions) workflow artifacts.

### Windows (10 / 11)
- **Standard Installer (NSIS)**: `Volume 3_<version>_x64-setup.exe`
  - Installs for current user in `%LOCALAPPDATA%\Volume 3` (No UAC / Admin required).
  - Supports silent installation:
    ```powershell
    "Volume 3_0.1.0_x64-setup.exe" /S /D=C:\CustomPath
    ```
- **Enterprise MSI (WiX)**: `Volume 3_<version>_x64_en-US.msi`
- **Portable Executable**: `Volume-3-portable-x64.exe`

### macOS (12+ Monterey, Ventura, Sonoma, Sequoia)
- **Universal DMG**: `Volume 3_<version>_universal.dmg` (Apple Silicon + Intel)
- **Universal App Archive**: `Volume-3-macOS-Universal.app.tar.gz`

> [!IMPORTANT]
> **macOS Accessibility & Input Monitoring Permissions**:
> 1. Open **System Settings** -> **Privacy & Security** -> **Accessibility**.
> 2. Enable **Volume 3** in the list.
> 3. Navigate to **Input Monitoring** and ensure **Volume 3** is enabled.
> 4. Restart Volume 3 if prompted.

### Linux (X11 & Wayland)
- **Debian / Ubuntu**: `volume-3_<version>_amd64.deb`
  ```bash
  sudo dpkg -i volume-3_0.1.0_amd64.deb
  sudo apt-get install -f
  ```
- **Fedora / RHEL**: `volume-3-<version>-1.x86_64.rpm`
  ```bash
  sudo dnf install ./volume-3-0.1.0-1.x86_64.rpm
  ```
- **Portable AppImage**: `volume-3_<version>_amd64.AppImage`
  ```bash
  chmod +x volume-3_0.1.0_amd64.AppImage
  ./volume-3_0.1.0_amd64.AppImage
  ```

> [!NOTE]
> **Linux Wayland Architecture & Limitations**:
> By security design, Wayland compositors (Mutter, KWin) prohibit unprivileged global pointer interception (`WH_MOUSE_LL` / X11 passive grab equivalents do not exist).
> On Wayland sessions:
> 1. VolZone detects the session via `XDG_SESSION_TYPE=wayland`.
> 2. Overlay zones function as transparent top-level Wayland surfaces that capture mouse wheel scroll directly.
> 3. *Note*: Clicks over a zone in Wayland surface mode will be absorbed by the zone overlay surface rather than passing through to the underlying window.
> 4. For full transparent click-through under Wayland, launch VolZone with access to the Linux `/dev/input` subsystem (add user to the `input` group: `sudo usermod -aG input $USER`).

---

## ⚙️ Configuration Reference (`config.json`)

Configuration files are stored in the OS standard directory:
- **Windows**: `%APPDATA%\Volume 3\config.json`
- **macOS**: `~/Library/Application Support/Volume 3/config.json`
- **Linux**: `~/.config/volume-3/config.json`

```json
{
  "edit_mode": false,
  "start_at_login": true,
  "run_as_admin": false,
  "active_profile_id": "default",
  "osd": {
    "enabled": true,
    "duration_ms": 1000,
    "position": "center",
    "hide_in_fullscreen": true,
    "theme": "auto"
  },
  "time_profile": {
    "enabled": true,
    "start_hour": 22,
    "end_hour": 7,
    "max_volume": 0.30
  },
  "fullscreen_rule": {
    "disable_in_fullscreen": true,
    "blacklisted_apps": []
  },
  "zones": [
    {
      "id": "zone-top-bar",
      "name": "Screen Top Bar",
      "monitor_id": null,
      "rect": { "x": 0, "y": 0, "width": 1920, "height": 28 },
      "shape": { "type": "screen_edge_strip", "edge": "top", "thickness": 28 },
      "visual_mode": "faint_tint",
      "opacity": 0.25,
      "target": { "kind": "master" },
      "step": 2.0,
      "acceleration": true,
      "invert": false,
      "modifiers": { "ctrl": false, "alt": false, "shift": false, "meta": false },
      "min_volume": 0.0,
      "max_volume": 1.0,
      "soft_start_limit": 0.08,
      "middle_click_to_mute": true,
      "coarse_modifier": "shift",
      "fine_modifier": "ctrl",
      "horizontal_action": "media_track",
      "tick_sound": true,
      "pulse_tint": true,
      "enabled": true
    }
  ]
}
```

---

## ⌨️ Global Shortcuts

| Shortcut | Action |
| :--- | :--- |
| **`Ctrl + Alt + V`** | Toggle Zone Edit Mode (move/resize handles visible). |
| **`Ctrl + Alt + Shift + Escape`** | **Emergency Panic**: Instantly uninstalls mouse hooks and disengages all zones. |
| **`Shift` + Scroll** | Coarse volume adjustment (2.5x step size). |
| **`Ctrl` + Scroll** | Fine volume adjustment (0.25x step size). |
| **Middle Click inside Zone** | Toggle Mute (when enabled). |
| **Horizontal Wheel Tilt** | Skip to Next Track / Previous Track (when enabled). |

---

## 🛠️ Building from Source

### Prerequisites
- [Rust](https://rustup.rs/) (v1.80+)
- [Node.js](https://nodejs.org/) (v20+) and `npm`
- Platform C++ build tools (Visual Studio C++ Build Tools on Windows, Xcode CLI tools on macOS, GCC/Clang on Linux)

```bash
# 1. Clone repository
git clone https://github.com/arman-khan-bd/volume-3.git
cd volume-3

# 2. Install frontend dependencies
npm ci

# 3. Build UI assets
npm run build

# 4. Run backend test suite (26 tests)
cargo test --manifest-path src-tauri/Cargo.toml

# 5. Run development build
npx @tauri-apps/cli dev

# 6. Build production binary
cargo build --release --manifest-path src-tauri/Cargo.toml
```

---

## 🤝 Contributing

We welcome community pull requests and feature proposals!
1. Fork the repository and create your feature branch (`git checkout -b feature/amazing-feature`).
2. Ensure all 26 backend unit tests pass: `cargo test --manifest-path src-tauri/Cargo.toml`.
3. Verify formatting: `cargo fmt --all --check` and lint clean: `cargo clippy --all-targets -- -D warnings`.
4. Open a Pull Request against `main`.
