#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use crate::config::Settings;
use crate::input::InputHook;
use crate::volume::{AppAudioSession, VolumeBackend};
use crate::zones::{apply_platform_window_traits, create_zone_window, Rect, VolumeTarget, Zone};
use std::path::PathBuf;
use std::sync::Mutex;
use tauri::{
    AppHandle, Emitter, Listener, Manager, PhysicalPosition, PhysicalSize, Position, Size, State,
    WebviewUrl, WebviewWindow, WebviewWindowBuilder,
};

mod config;
mod hotkeys;
mod input;
mod logger;
mod osd;
mod tray;
mod volume;
mod zones;

pub struct AppState {
    pub settings: Mutex<config::Settings>,
    pub input_hook: Mutex<Box<dyn InputHook>>,
}

pub fn open_settings_window(app: &AppHandle) -> Result<(), String> {
    if let Some(win) = app.get_webview_window("settings") {
        let _ = win.show();
        let _ = win.set_focus();
        return Ok(());
    }

    let url = WebviewUrl::App("index.html".into());
    WebviewWindowBuilder::new(app, "settings", url)
        .title("Volume 3")
        .inner_size(780.0, 560.0)
        .min_inner_size(640.0, 460.0)
        .resizable(true)
        .center()
        .build()
        .map_err(|e| format!("Failed to create settings window: {e}"))?;

    Ok(())
}

pub fn toggle_edit_mode_internal(app: &AppHandle, state: &AppState) -> Result<bool, String> {
    let mut settings = state.settings.lock().map_err(|e| e.to_string())?;
    settings.edit_mode = !settings.edit_mode;
    let edit_mode = settings.edit_mode;
    let _ = config::save_config(&settings);

    for zone in &settings.zones {
        if !zone.enabled {
            continue;
        }
        let label = zone.window_label();
        if let Some(win) = app.get_webview_window(&label) {
            let _ = apply_platform_window_traits(&win, edit_mode);
            let _ = win.show();
            if edit_mode {
                let _ = win.set_always_on_top(true);
            }
        } else {
            let _ = create_zone_window(app, zone, edit_mode);
        }
    }

    let _ = app.emit("edit-mode-changed", edit_mode);
    log::info!("Edit mode toggled: {edit_mode}");
    Ok(edit_mode)
}

pub fn panic_shutdown_internal(app: &AppHandle, state: &AppState) -> Result<(), String> {
    input::emergency_panic_unhook();

    if let Ok(mut hook) = state.input_hook.lock() {
        let _ = hook.stop();
    }

    if let Some(tray) = app.tray_by_id("main") {
        let _ = tray.set_tooltip(Some("Volume 3 [EMERGENCY PANIC: Hooks Removed]"));
    }

    let _ = app.emit("panic-triggered", ());
    log::warn!("EMERGENCY PANIC: Hooks stopped, zones disengaged.");
    Ok(())
}

pub fn unpanic_internal(app: &AppHandle, state: &AppState) -> Result<(), String> {
    input::reset_panic_state();

    let settings = state.settings.lock().map_err(|e| e.to_string())?.clone();
    if let Ok(mut hook) = state.input_hook.lock() {
        hook.update_zones(settings.zones.clone());
        let _ = hook.start();
    }

    if let Some(tray) = app.tray_by_id("main") {
        let _ = tray.set_tooltip(Some("Volume 3 - Master: Ready"));
    }

    let _ = app.emit("panic-cleared", ());
    log::info!("Emergency panic state reset; hooks resumed.");
    Ok(())
}

pub fn save_settings_internal(
    app: &AppHandle,
    state: &AppState,
    new_settings: Settings,
) -> Result<(), String> {
    config::save_config(&new_settings).map_err(|e| e.to_string())?;

    // 1. Immediately update in-memory state so any new window queries get the new zones
    {
        let mut settings = state.settings.lock().map_err(|e| e.to_string())?;
        *settings = new_settings.clone();
    }

    // 2. Update hooks
    if let Ok(hook) = state.input_hook.lock() {
        hook.update_zones(new_settings.zones.clone());
        hook.update_osd(new_settings.osd.clone());
        hook.update_time_profile(new_settings.time_profile.clone());
        hook.update_fullscreen_rule(new_settings.fullscreen_rule.clone());
    }

    let edit_mode = new_settings.edit_mode;
    let active_labels: Vec<String> = new_settings
        .zones
        .iter()
        .filter(|z| z.enabled)
        .map(|z| z.window_label())
        .collect();

    // 3. Close windows for deleted or disabled zones
    for (label, win) in app.webview_windows() {
        if label.starts_with("zone-") && !active_labels.contains(&label) {
            let _ = win.close();
        }
    }

    // 4. Update or spawn windows for enabled zones
    for zone in &new_settings.zones {
        if !zone.enabled {
            continue;
        }
        let label = zone.window_label();
        if let Some(win) = app.get_webview_window(&label) {
            let _ = win.set_position(Position::Physical(PhysicalPosition::new(
                zone.rect.x,
                zone.rect.y,
            )));
            let _ = win.set_size(Size::Physical(PhysicalSize::new(
                zone.rect.width,
                zone.rect.height,
            )));
            let _ = apply_platform_window_traits(&win, edit_mode);
            if edit_mode {
                let _ = win.show();
                let _ = win.set_always_on_top(true);
            }
        } else {
            match create_zone_window(app, zone, edit_mode) {
                Ok(win) => {
                    let _ = win.show();
                    log::info!("Created zone window for '{}'", zone.name);
                }
                Err(err) => {
                    log::error!("Failed to create window for zone '{}': {err}", zone.name);
                }
            }
        }
    }

    let _ = app.emit("settings-updated", ());
    log::info!("Settings saved and hot-reloaded successfully");
    Ok(())
}

pub fn toggle_all_zones_internal(app: &AppHandle, state: &AppState) -> Result<bool, String> {
    let mut settings = state.settings.lock().map_err(|e| e.to_string())?;
    let any_enabled = settings.zones.iter().any(|z| z.enabled);
    let new_state = !any_enabled;
    for z in &mut settings.zones {
        z.enabled = new_state;
    }
    let cloned = settings.clone();
    drop(settings);
    save_settings_internal(app, state, cloned)?;
    log::info!("All zones set to enabled: {new_state}");
    Ok(new_state)
}

#[tauri::command]
fn get_current_window_label(window: WebviewWindow) -> String {
    window.label().to_string()
}

#[tauri::command]
fn get_zone_config(state: State<AppState>, zone_id: String) -> Result<Option<Zone>, String> {
    let settings = state.settings.lock().map_err(|e| e.to_string())?;
    let clean_id = zone_id.trim_start_matches("zone-");
    Ok(settings
        .zones
        .iter()
        .find(|z| {
            z.id == zone_id
                || z.window_label() == zone_id
                || z.id == clean_id
                || z.window_label() == format!("zone-{}", zone_id)
        })
        .cloned())
}

#[tauri::command]
fn get_edit_mode(state: State<AppState>) -> Result<bool, String> {
    let settings = state.settings.lock().map_err(|e| e.to_string())?;
    Ok(settings.edit_mode)
}

#[tauri::command]
fn toggle_edit_mode(app: AppHandle, state: State<AppState>) -> Result<bool, String> {
    toggle_edit_mode_internal(&app, &state)
}

#[tauri::command]
fn set_edit_mode(app: AppHandle, state: State<AppState>, enabled: bool) -> Result<bool, String> {
    let mut settings = state.settings.lock().map_err(|e| e.to_string())?;
    settings.edit_mode = enabled;
    let _ = config::save_config(&settings);

    for zone in &settings.zones {
        if !zone.enabled {
            continue;
        }
        let label = zone.window_label();
        if let Some(win) = app.get_webview_window(&label) {
            let _ = apply_platform_window_traits(&win, enabled);
            let _ = win.show();
            if enabled {
                let _ = win.set_always_on_top(true);
            }
        } else {
            let _ = create_zone_window(&app, zone, enabled);
        }
    }

    let _ = app.emit("edit-mode-changed", enabled);
    log::info!("Edit mode set to: {enabled}");
    Ok(enabled)
}

#[tauri::command]
fn trigger_osd(
    app: AppHandle,
    state: State<AppState>,
    theme: Option<String>,
    position: Option<config::OsdPosition>,
    accent_color: Option<String>,
    scale: Option<f32>,
) -> Result<(), String> {
    let settings = state.settings.lock().map_err(|e| e.to_string())?;
    let mut osd_cfg = settings.osd.clone();
    if let Some(t) = theme {
        osd_cfg.theme = t;
    }
    if let Some(p) = position {
        osd_cfg.position = p;
    }
    if let Some(c) = accent_color {
        osd_cfg.accent_color = c;
    }
    if let Some(s) = scale {
        osd_cfg.scale = s;
    }
    osd_cfg.enabled = true;
    let vol = get_master_volume().unwrap_or(0.65);
    let muted = get_master_mute().unwrap_or(false);
    let osd_manager = osd::OsdManager::new();
    osd_manager.show_volume(&app, &osd_cfg, vol, muted, "Master Volume");
    Ok(())
}

#[tauri::command]
fn get_last_osd() -> Option<osd::OsdPayload> {
    osd::get_recent_osd_payload()
}

#[tauri::command]
fn hide_osd_window(app: AppHandle) {
    if let Some(win) = app.get_webview_window("volzone-osd") {
        let _ = win.hide();
    }
}

#[tauri::command]
fn osd_debug_log(msg: String) {
    log::info!("[OSD WebView] {msg}");
}

#[tauri::command]
fn open_settings(app: AppHandle) -> Result<(), String> {
    open_settings_window(&app)
}

#[tauri::command]
fn get_settings(state: State<AppState>) -> Result<Settings, String> {
    let settings = state.settings.lock().map_err(|e| e.to_string())?;
    Ok(settings.clone())
}

#[tauri::command]
fn save_settings(
    app: AppHandle,
    state: State<AppState>,
    new_settings: Settings,
) -> Result<(), String> {
    save_settings_internal(&app, &state, new_settings)
}

#[tauri::command]
fn switch_profile(
    app: AppHandle,
    state: State<AppState>,
    profile_id: String,
) -> Result<Settings, String> {
    let mut settings = state.settings.lock().map_err(|e| e.to_string())?;
    let zones_opt = settings
        .profiles
        .iter()
        .find(|p| p.id == profile_id)
        .map(|p| p.zones.clone());
    if let Some(zones) = zones_opt {
        settings.active_profile_id = profile_id;
        settings.zones = zones;
        let cloned = settings.clone();
        drop(settings);
        save_settings_internal(&app, &state, cloned.clone())?;
        return Ok(cloned);
    }
    Err(format!("Profile '{profile_id}' not found"))
}

#[tauri::command]
fn update_zone_rect(
    app: AppHandle,
    state: State<AppState>,
    zone_id: String,
    rect: Rect,
) -> Result<(), String> {
    let mut settings = state.settings.lock().map_err(|e| e.to_string())?;
    let clean_id = zone_id.trim_start_matches("zone-");
    if let Some(zone) = settings.zones.iter_mut().find(|z| {
        z.id == zone_id
            || z.window_label() == zone_id
            || z.id == clean_id
            || z.window_label() == format!("zone-{}", zone_id)
    }) {
        zone.rect = rect;

        if let Some(win) = app.get_webview_window(&zone.window_label()) {
            let _ = win.set_position(Position::Physical(PhysicalPosition::new(rect.x, rect.y)));
            let _ = win.set_size(Size::Physical(PhysicalSize::new(rect.width, rect.height)));
        }

        let _ = config::save_config(&settings);
        if let Ok(hook) = state.input_hook.lock() {
            hook.update_zones(settings.zones.clone());
        }
        let _ = app.emit("settings-updated", ());
    }
    Ok(())
}

#[tauri::command]
fn export_config(state: State<AppState>) -> Result<String, String> {
    let settings = state.settings.lock().map_err(|e| e.to_string())?;
    serde_json::to_string_pretty(&*settings).map_err(|e| e.to_string())
}

#[tauri::command]
fn import_config(
    app: AppHandle,
    state: State<AppState>,
    json_str: String,
) -> Result<Settings, String> {
    let imported: Settings =
        serde_json::from_str(&json_str).map_err(|e| format!("Invalid JSON: {e}"))?;
    save_settings_internal(&app, &state, imported.clone())?;
    Ok(imported)
}

#[tauri::command]
fn reset_config(app: AppHandle, state: State<AppState>) -> Result<Settings, String> {
    let defaults = Settings::default();
    save_settings_internal(&app, &state, defaults.clone())?;
    log::info!("Configuration reset to factory defaults");
    Ok(defaults)
}

#[tauri::command]
fn panic_shutdown(app: AppHandle, state: State<AppState>) -> Result<(), String> {
    panic_shutdown_internal(&app, &state)
}

#[tauri::command]
fn unpanic(app: AppHandle, state: State<AppState>) -> Result<(), String> {
    unpanic_internal(&app, &state)
}

#[tauri::command]
fn is_panic_disengaged() -> bool {
    input::is_panic_disengaged()
}

#[tauri::command]
fn open_logs_folder() -> Result<(), String> {
    logger::open_logs_folder()
}

#[tauri::command]
fn toggle_all_zones(app: AppHandle, state: State<AppState>) -> Result<bool, String> {
    let mut settings = state.settings.lock().map_err(|e| e.to_string())?;
    let any_enabled = settings.zones.iter().any(|z| z.enabled);
    let new_state = !any_enabled;
    for z in &mut settings.zones {
        z.enabled = new_state;
    }
    let cloned = settings.clone();
    drop(settings);
    save_settings(app, state, cloned)?;
    log::info!("Toggled all zones to enabled = {new_state}");
    Ok(new_state)
}

#[tauri::command]
fn is_autostart_enabled(app: AppHandle) -> Result<bool, String> {
    use tauri_plugin_autostart::ManagerExt;
    app.autolaunch().is_enabled().map_err(|e| e.to_string())
}

#[tauri::command]
fn set_autostart_enabled(
    app: AppHandle,
    state: State<AppState>,
    enabled: bool,
) -> Result<bool, String> {
    use tauri_plugin_autostart::ManagerExt;
    if enabled {
        app.autolaunch()
            .enable()
            .map_err(|e| format!("Failed to enable auto-start: {e}"))?;
    } else {
        app.autolaunch()
            .disable()
            .map_err(|e| format!("Failed to disable auto-start: {e}"))?;
    }

    let actual = app.autolaunch().is_enabled().unwrap_or(enabled);
    let mut settings = state.settings.lock().map_err(|e| e.to_string())?;
    settings.start_at_login = actual;
    settings.autostart_initialized = true;
    let _ = config::save_config(&settings);
    log::info!("Auto-start set to {actual} (requested {enabled})");
    Ok(actual)
}

fn create_volume_backend() -> Result<Box<dyn VolumeBackend>, String> {
    #[cfg(target_os = "windows")]
    return Ok(Box::new(volume::WindowsVolumeController::new()?));
    #[cfg(target_os = "macos")]
    return Ok(Box::new(volume::MacosVolumeController::new()?));
    #[cfg(target_os = "linux")]
    return Ok(Box::new(volume::LinuxVolumeController::new()?));
    #[cfg(not(any(target_os = "windows", target_os = "macos", target_os = "linux")))]
    return Ok(Box::new(volume::MockBackend::new()));
}

#[tauri::command]
fn get_master_volume() -> Result<f32, String> {
    create_volume_backend()?.get_volume(&VolumeTarget::Master)
}

#[tauri::command]
fn set_master_volume(level: f32) -> Result<(), String> {
    create_volume_backend()?.set_volume(&VolumeTarget::Master, level)
}

#[tauri::command]
fn get_master_mute() -> Result<bool, String> {
    create_volume_backend()?.get_mute(&VolumeTarget::Master)
}

#[tauri::command]
fn set_master_mute(muted: bool) -> Result<(), String> {
    create_volume_backend()?.set_mute(&VolumeTarget::Master, muted)
}

#[tauri::command]
fn toggle_master_mute() -> Result<bool, String> {
    let current = get_master_mute()?;
    set_master_mute(!current)?;
    Ok(!current)
}

#[tauri::command]
fn get_mic_volume() -> Result<f32, String> {
    create_volume_backend()?.get_volume(&VolumeTarget::Mic)
}

#[tauri::command]
fn set_mic_volume(level: f32) -> Result<(), String> {
    create_volume_backend()?.set_volume(&VolumeTarget::Mic, level)
}

#[tauri::command]
fn get_mic_mute() -> Result<bool, String> {
    create_volume_backend()?.get_mute(&VolumeTarget::Mic)
}

#[tauri::command]
fn set_mic_mute(muted: bool) -> Result<(), String> {
    create_volume_backend()?.set_mute(&VolumeTarget::Mic, muted)
}

#[tauri::command]
fn list_audio_apps() -> Result<Vec<AppAudioSession>, String> {
    create_volume_backend()?.list_apps()
}

#[tauri::command]
fn set_app_volume(app_id: String, level: f32) -> Result<(), String> {
    create_volume_backend()?.set_volume(&VolumeTarget::App(app_id), level)
}

#[tauri::command]
fn set_app_mute(app_id: String, muted: bool) -> Result<(), String> {
    create_volume_backend()?.set_mute(&VolumeTarget::App(app_id), muted)
}

#[tauri::command]
fn test_volume(
    app: AppHandle,
    state: State<AppState>,
    action: String,
    show_osd: Option<bool>,
) -> Result<f32, String> {
    handle_volume_test(&action)?;
    let vol = get_master_volume()?;
    if show_osd.unwrap_or(false) {
        if let Ok(settings) = state.settings.lock() {
            let muted = get_master_mute().unwrap_or(false);
            let osd_manager = osd::OsdManager::new();
            osd_manager.show_volume(&app, &settings.osd, vol, muted, "Master Volume");
        }
    }
    Ok(vol)
}

#[tauri::command]
fn is_elevated_admin() -> bool {
    #[cfg(target_os = "windows")]
    {
        input::WindowsInputHook::is_elevated()
    }
    #[cfg(not(target_os = "windows"))]
    {
        false
    }
}

#[tauri::command]
fn check_accessibility_permission() -> bool {
    #[cfg(target_os = "macos")]
    {
        input::macos::has_accessibility_permission()
    }
    #[cfg(not(target_os = "macos"))]
    {
        true
    }
}

#[tauri::command]
fn open_accessibility_settings() {
    #[cfg(target_os = "macos")]
    {
        input::macos::open_accessibility_privacy_settings();
    }
}

pub fn handle_volume_test(action: &str) -> Result<(), String> {
    #[cfg(target_os = "windows")]
    let backend = volume::WindowsVolumeController::new()?;
    #[cfg(target_os = "macos")]
    let backend = volume::MacosVolumeController::new()?;
    #[cfg(target_os = "linux")]
    let backend = volume::LinuxVolumeController::new()?;
    #[cfg(not(any(target_os = "windows", target_os = "macos", target_os = "linux")))]
    let backend = volume::MockBackend::new();

    let target = VolumeTarget::Master;
    let initial_vol = backend.get_volume(&target)?;
    let initial_mute = backend.get_mute(&target)?;

    println!("=== Volume 3 Volume Test ===");
    println!("Target: Master");
    println!(
        "Initial Volume: {:.1}% | Muted: {}",
        initial_vol * 100.0,
        initial_mute
    );
    println!("Action: {action}");

    match action {
        "up" => {
            let new_vol = (initial_vol + 0.05).min(1.0);
            backend.set_volume(&target, new_vol)?;
        }
        "down" => {
            let new_vol = (initial_vol - 0.05).max(0.0);
            backend.set_volume(&target, new_vol)?;
        }
        "mute" => {
            backend.set_mute(&target, !initial_mute)?;
        }
        other => return Err(format!("Unknown action '{other}'. Use up, down, or mute")),
    }

    let result_vol = backend.get_volume(&target)?;
    let result_mute = backend.get_mute(&target)?;
    println!(
        "Result Volume: {:.1}% | Muted: {}",
        result_vol * 100.0,
        result_mute
    );
    println!("Status: SUCCESS");
    Ok(())
}

fn initialize_zone_windows(app: &AppHandle, settings: &mut Settings) {
    for zone in &mut settings.zones {
        zones::adjust_zone_for_monitors(app, zone);
    }

    let edit_mode = settings.edit_mode;
    for zone in &settings.zones {
        if !zone.enabled {
            continue;
        }

        match create_zone_window(app, zone, edit_mode) {
            Ok(_) => {
                log::info!(
                    "Created zone window for '{}' (Shape: {:?})",
                    zone.name,
                    zone.shape
                );
            }
            Err(err) => {
                log::error!("Failed to create window for zone '{}': {err}", zone.name);
            }
        }
    }
}

fn main() {
    // Initialize rotating file logger in the OS standard directory
    let _ = logger::init_logging(None);

    let args: Vec<String> = std::env::args().collect();
    let is_minimized = args.iter().any(|arg| arg == "--minimized");
    let mut start_edit = false;
    let mut start_disabled = false;
    let mut custom_config: Option<PathBuf> = None;

    let mut i = 1;
    while i < args.len() {
        match args[i].as_str() {
            "--help" | "-h" => {
                println!("Volume 3 - Transparent Screen Zone Scroll-Wheel Audio Controller\n");
                println!("Usage: volume-3 [OPTIONS]\n");
                println!("Options:");
                println!("  --edit                 Launch directly in interactive Zone Edit Mode");
                println!("  --disable              Launch with all screen zones disabled");
                println!("  --config <PATH>        Load configuration from custom JSON file");
                println!("  --volume-test <ACTION> Test system audio backend (up | down | mute)");
                println!("  -h, --help             Print help information");
                return;
            }
            "--edit" => {
                start_edit = true;
            }
            "--disable" => {
                start_disabled = true;
            }
            "--config" => {
                if i + 1 < args.len() {
                    custom_config = Some(PathBuf::from(&args[i + 1]));
                    i += 1;
                }
            }
            "--volume-test" => {
                let action = args.get(i + 1).map(|s| s.as_str()).unwrap_or("up");
                if let Err(e) = handle_volume_test(action) {
                    eprintln!("Volume test failed: {e}");
                    std::process::exit(1);
                }
                return;
            }
            arg if arg.starts_with("--volume-test=") => {
                let action = arg.strip_prefix("--volume-test=").unwrap_or("up");
                if let Err(e) = handle_volume_test(action) {
                    eprintln!("Volume test failed: {e}");
                    std::process::exit(1);
                }
                return;
            }
            _ => {}
        }
        i += 1;
    }

    // Initialize rotating file logger
    let _ = logger::init_logging(None);

    #[cfg(target_os = "linux")]
    {
        let session = std::env::var("XDG_SESSION_TYPE").unwrap_or_else(|_| "unknown".to_string());
        log::info!("Linux session type: {session}");
    }

    log::info!("Starting Volume 3 desktop service...");

    if let Some(ref path) = custom_config {
        log::info!("Using custom configuration path: {}", path.display());
        config::set_custom_config_path(path.clone());
    }

    let mut settings = match config::load_config() {
        Ok(cfg) => {
            log::info!("Loaded configuration with {} zone(s)", cfg.zones.len());
            cfg
        }
        Err(err) => {
            log::error!("Failed to load configuration, using defaults: {err}");
            config::Settings::default()
        }
    };

    if start_edit {
        settings.edit_mode = true;
        log::info!("CLI flag --edit applied: launching in Edit Mode");
    }

    if start_disabled {
        for z in &mut settings.zones {
            z.enabled = false;
        }
        log::info!("CLI flag --disable applied: all zones disabled");
    }

    let app = tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, argv, _cwd| {
            log::info!("Single instance second launch forward: argv = {:?}", argv);
            if argv.iter().any(|arg| arg == "--edit") {
                let _ = app.emit("single-instance-edit", ());
            } else if argv.iter().any(|arg| arg == "--disable") {
                let _ = app.emit("single-instance-disable", ());
            } else if argv.iter().any(|arg| arg == "--test-osd") {
                let _ = app.emit("single-instance-test-osd", ());
            } else if !argv.iter().any(|arg| arg == "--minimized") {
                let _ = app.emit("single-instance-open-settings", ());
            }
        }))
        .plugin(tauri_plugin_autostart::init(
            tauri_plugin_autostart::MacosLauncher::LaunchAgent,
            Some(vec!["--minimized"]),
        ))
        .plugin(tauri_plugin_updater::Builder::new().build())
        .invoke_handler(tauri::generate_handler![
            get_current_window_label,
            get_zone_config,
            get_edit_mode,
            toggle_edit_mode,
            set_edit_mode,
            open_settings,
            get_settings,
            save_settings,
            switch_profile,
            update_zone_rect,
            export_config,
            import_config,
            reset_config,
            panic_shutdown,
            unpanic,
            is_panic_disengaged,
            open_logs_folder,
            toggle_all_zones,
            is_autostart_enabled,
            set_autostart_enabled,
            get_master_volume,
            set_master_volume,
            get_master_mute,
            set_master_mute,
            toggle_master_mute,
            get_mic_volume,
            set_mic_volume,
            get_mic_mute,
            set_mic_mute,
            list_audio_apps,
            set_app_volume,
            set_app_mute,
            test_volume,
            is_elevated_admin,
            check_accessibility_permission,
            open_accessibility_settings,
            trigger_osd,
            get_last_osd,
            hide_osd_window,
            osd_debug_log
        ])
        .setup(move |app| {
            use tauri_plugin_autostart::ManagerExt;
            let handle = app.handle().clone();

            // Automatically enable OS startup on first run, or keep registry path synced when enabled
            if !settings.autostart_initialized {
                match app.autolaunch().enable() {
                    Ok(()) => {
                        settings.start_at_login = true;
                        settings.autostart_initialized = true;
                        let _ = config::save_config(&settings);
                        log::info!("Auto-start enabled automatically for current user (--minimized)");
                    }
                    Err(err) => {
                        log::warn!("Could not register automatic startup: {err}");
                    }
                }
            } else if settings.start_at_login && !app.autolaunch().is_enabled().unwrap_or(false) {
                let _ = app.autolaunch().enable();
            }

            let _tray = tray::setup_tray(&handle, &settings)?;

            // Pre-initialize the OSD overlay window cleanly on the main thread
            osd::OsdManager::new().init_osd_window(&handle);

            initialize_zone_windows(&handle, &mut settings);

            if !is_minimized {
                let _ = open_settings_window(&handle);
            }

            // Setup input hook with app handle for event dispatching
            #[cfg(target_os = "windows")]
            let hook: Box<dyn InputHook> = {
                let mut win_hook = input::WindowsInputHook::new();
                win_hook.update_zones(settings.zones.clone());
                win_hook.update_osd(settings.osd.clone());
                win_hook.update_time_profile(settings.time_profile.clone());
                win_hook.update_fullscreen_rule(settings.fullscreen_rule.clone());
                if let Err(err) = win_hook.start_with_app(handle.clone()) {
                    log::error!("Failed to start input hook: {err}");
                }
                Box::new(win_hook)
            };

            #[cfg(target_os = "macos")]
            let hook: Box<dyn InputHook> = {
                let mut mac_hook = input::MacosInputHook::new();
                mac_hook.update_zones(settings.zones.clone());
                let _ = mac_hook.start();
                Box::new(mac_hook)
            };

            #[cfg(target_os = "linux")]
            let hook: Box<dyn InputHook> = {
                let mut lin_hook = input::LinuxInputHook::new();
                lin_hook.update_zones(settings.zones.clone());
                let _ = lin_hook.start();
                Box::new(lin_hook)
            };

            #[cfg(not(any(target_os = "windows", target_os = "macos", target_os = "linux")))]
            panic!("Unsupported OS");

            let app_state = AppState {
                settings: Mutex::new(settings),
                input_hook: Mutex::new(hook),
            };
            app.manage(app_state);

            // Real-time Audio Synchronization: Subscribe to system volume changes
            #[cfg(target_os = "windows")]
            {
                let handle_for_sync = handle.clone();
                if let Ok(vol_backend) = volume::WindowsVolumeController::new() {
                    let _ = vol_backend.subscribe_changes(Box::new(move |vol, muted| {
                        let pct = (vol * 100.0).round() as u32;
                        let mute_str = if muted { " (Muted)" } else { "" };
                        log::debug!("System volume synchronized: {pct}%{mute_str}");

                        // Update tray tooltip live
                        let _ = handle_for_sync.tray_by_id("main").map(|t| {
                            let _ = t.set_tooltip(Some(format!("Volume 3 - {pct}%{mute_str}")));
                        });

                        // Notify active UI windows
                        let _ = handle_for_sync.emit("volume-synced", (pct, muted));
                        let _ = handle_for_sync.emit("volume-changed", (vol, muted));
                    }));
                }
            }

            // Register global hotkeys: Ctrl+Alt+V (Edit Mode) and Ctrl+Alt+Shift+Escape (Panic)
            let handle_for_hotkey = handle.clone();
            let handle_for_panic = handle.clone();
            let mut hotkey_manager = hotkeys::HotkeyManager::new();
            if let Err(err) = hotkey_manager.register_defaults(
                move || {
                    let state = handle_for_hotkey.state::<AppState>();
                    let _ = toggle_edit_mode_internal(&handle_for_hotkey, &state);
                },
                move || {
                    let state = handle_for_panic.state::<AppState>();
                    let _ = panic_shutdown_internal(&handle_for_panic, &state);
                },
            ) {
                log::warn!("Global hotkey registration warning: {err}");
            }

            // Tray event listeners
            let handle_for_tray_edit = handle.clone();
            app.listen("tray-toggle-edit", move |_| {
                let state = handle_for_tray_edit.state::<AppState>();
                let _ = toggle_edit_mode_internal(&handle_for_tray_edit, &state);
            });

            let handle_for_tray_settings = handle.clone();
            app.listen("tray-open-settings", move |_| {
                let _ = open_settings_window(&handle_for_tray_settings);
            });

            let handle_for_tray_zones = handle.clone();
            app.listen("tray-toggle-zones", move |_| {
                let state = handle_for_tray_zones.state::<AppState>();
                let _ = toggle_all_zones_internal(&handle_for_tray_zones, &state);
            });

            let handle_for_tray_panic = handle.clone();
            app.listen("tray-panic", move |_| {
                let state = handle_for_tray_panic.state::<AppState>();
                let _ = panic_shutdown_internal(&handle_for_tray_panic, &state);
            });

            let handle_for_tray_profile = handle.clone();
            app.listen("tray-switch-profile", move |event: tauri::Event| {
                if let Ok(profile_id) = serde_json::from_str::<String>(event.payload()) {
                    let state = handle_for_tray_profile.state::<AppState>();
                    let _ = switch_profile(handle_for_tray_profile.clone(), state, profile_id);
                }
            });

            // Single-instance forwarding listeners
            let handle_for_si_settings = handle.clone();
            app.listen("single-instance-open-settings", move |_| {
                let _ = open_settings_window(&handle_for_si_settings);
            });

            let handle_for_si_edit = handle.clone();
            app.listen("single-instance-edit", move |_| {
                let state = handle_for_si_edit.state::<AppState>();
                let _ = set_edit_mode(handle_for_si_edit.clone(), state, true);
            });

            let handle_for_si_disable = handle.clone();
            app.listen("single-instance-disable", move |_| {
                let state = handle_for_si_disable.state::<AppState>();
                let _ = toggle_all_zones_internal(&handle_for_si_disable, &state);
            });

            let handle_for_si_osd = handle.clone();
            app.listen("single-instance-test-osd", move |_| {
                let state = handle_for_si_osd.state::<AppState>();
                let osd_cfg_opt = state.settings.lock().ok().map(|s| s.osd.clone());
                if let Some(mut osd_cfg) = osd_cfg_opt {
                    osd_cfg.enabled = true;
                    let vol = get_master_volume().unwrap_or(0.65);
                    let muted = get_master_mute().unwrap_or(false);
                    osd::OsdManager::new().show_volume(
                        &handle_for_si_osd,
                        &osd_cfg,
                        vol,
                        muted,
                        "Master Volume",
                    );
                }
            });

            // Watchdog stall alert listener
            let handle_for_watchdog = handle.clone();
            app.listen("watchdog-stall-detected", move |event| {
                log::error!("Watchdog alerted app: {:?}", event.payload());
                if let Some(tray) = handle_for_watchdog.tray_by_id("main") {
                    let _ = tray.set_tooltip(Some("Volume 3 [ERROR: Hook Stalled & Disengaged]"));
                }
                let _ = handle_for_watchdog.emit("panic-triggered", ());
            });

            log::info!(
                "System tray, zone windows, hotkeys, rotating logs, and safety watchdog active"
            );
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error while building tauri application");

    app.run(|_app_handle, event| {
        if let tauri::RunEvent::ExitRequested { api, .. } = event {
            api.prevent_exit();
        }
    });
}
