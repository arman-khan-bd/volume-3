use crate::config::Settings;
use tauri::{
    menu::{Menu, MenuItem, PredefinedMenuItem, Submenu},
    tray::{MouseButton, MouseButtonState, TrayIcon, TrayIconBuilder, TrayIconEvent},
    AppHandle, Emitter, Wry,
};

pub fn setup_tray(app: &AppHandle, settings: &Settings) -> Result<TrayIcon<Wry>, tauri::Error> {
    let settings_item = MenuItem::with_id(app, "settings", "Open Settings...", true, None::<&str>)?;
    let edit_item = MenuItem::with_id(
        app,
        "toggle_edit",
        "Toggle Edit Mode (Ctrl+Alt+V)",
        true,
        None::<&str>,
    )?;

    let all_enabled = settings.zones.iter().any(|z| z.enabled);
    let toggle_zones_label = if all_enabled {
        "Disable All Zones"
    } else {
        "Enable All Zones"
    };
    let toggle_zones_item =
        MenuItem::with_id(app, "toggle_zones", toggle_zones_label, true, None::<&str>)?;

    // Build Profiles submenu
    let mut profile_items: Vec<MenuItem<Wry>> = Vec::new();
    for p in &settings.profiles {
        let prefix = if p.id == settings.active_profile_id {
            "✓ "
        } else {
            "   "
        };
        let label = format!("{prefix}{}", p.name);
        let item = MenuItem::with_id(app, format!("profile:{}", p.id), label, true, None::<&str>)?;
        profile_items.push(item);
    }

    let profile_refs: Vec<&dyn tauri::menu::IsMenuItem<Wry>> = profile_items
        .iter()
        .map(|item| item as &dyn tauri::menu::IsMenuItem<Wry>)
        .collect();
    let profiles_sub = Submenu::with_items(app, "Profiles", true, &profile_refs)?;

    let sep1 = PredefinedMenuItem::separator(app)?;
    let panic_item = MenuItem::with_id(
        app,
        "panic",
        "Emergency Panic (Unhook All)",
        true,
        None::<&str>,
    )?;
    let sep2 = PredefinedMenuItem::separator(app)?;
    let quit_item = MenuItem::with_id(app, "quit", "Quit VolZone", true, None::<&str>)?;

    let menu = Menu::with_items(
        app,
        &[
            &settings_item,
            &edit_item,
            &toggle_zones_item,
            &profiles_sub,
            &sep1,
            &panic_item,
            &sep2,
            &quit_item,
        ],
    )?;

    // Create a 16x16 high-contrast RGBA icon in memory for tray display
    let mut icon_rgba = Vec::with_capacity(16 * 16 * 4);
    for y in 0..16 {
        for x in 0..16 {
            let is_border = x == 0 || x == 15 || y == 0 || y == 15;
            let is_inner = x >= 4 && x <= 11 && y >= 4 && y <= 11;
            if is_border || is_inner {
                icon_rgba.extend_from_slice(&[41, 128, 185, 255]); // Blue accent
            } else {
                icon_rgba.extend_from_slice(&[255, 255, 255, 220]); // Light fill
            }
        }
    }
    let icon = tauri::image::Image::new_owned(icon_rgba, 16, 16);

    let tray = TrayIconBuilder::new()
        .icon(icon)
        .tooltip("VolZone - Master: Ready")
        .menu(&menu)
        .show_menu_on_left_click(false)
        .on_tray_icon_event(|tray, event| {
            if let TrayIconEvent::Click {
                button: MouseButton::Left,
                button_state: MouseButtonState::Up,
                ..
            } = event
            {
                let app = tray.app_handle();
                let _ = app.emit("tray-open-settings", ());
            }
        })
        .on_menu_event(move |app, event| {
            let id = event.id().as_ref();
            if id == "quit" {
                log::info!("Quit requested via tray menu");
                app.exit(0);
            } else if id == "toggle_edit" {
                let _ = app.emit("tray-toggle-edit", ());
            } else if id == "toggle_zones" {
                let _ = app.emit("tray-toggle-zones", ());
            } else if id == "settings" {
                let _ = app.emit("tray-open-settings", ());
            } else if id == "panic" {
                let _ = app.emit("tray-panic", ());
            } else if let Some(prof_id) = id.strip_prefix("profile:") {
                let _ = app.emit("tray-switch-profile", prof_id.to_string());
            }
        })
        .build(app)?;

    Ok(tray)
}
