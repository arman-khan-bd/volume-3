#![allow(dead_code)]

use crossbeam_channel::{bounded, Receiver, Sender};
use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, AtomicIsize, AtomicU64, Ordering};
use std::sync::{Arc, Mutex, OnceLock, RwLock};
use std::thread;
use std::time::Instant;
use tauri::{AppHandle, Emitter};
use windows::Win32::Foundation::{HANDLE, HWND, LPARAM, LRESULT, POINT, WPARAM};
use windows::Win32::Security::{GetTokenInformation, TokenElevation, TOKEN_ELEVATION, TOKEN_QUERY};
use windows::Win32::System::Threading::{GetCurrentProcess, OpenProcessToken};
use windows::Win32::UI::Input::KeyboardAndMouse::{
    keybd_event, GetAsyncKeyState, KEYEVENTF_KEYUP, VK_CONTROL, VK_LWIN, VK_MEDIA_NEXT_TRACK,
    VK_MEDIA_PREV_TRACK, VK_MENU, VK_RWIN, VK_SHIFT,
};
use windows::Win32::UI::WindowsAndMessaging::{
    CallNextHookEx, DispatchMessageW, GetMessageW, GetWindowThreadProcessId, PostThreadMessageW,
    SetWindowsHookExW, TranslateMessage, UnhookWindowsHookEx, WindowFromPoint, HHOOK, MSG,
    MSLLHOOKSTRUCT, WH_MOUSE_LL, WM_MBUTTONDOWN, WM_MOUSEHWHEEL, WM_MOUSEWHEEL, WM_QUIT, WM_USER,
};

use crate::config::{FullscreenRule, OsdConfig, TimeProfile};
use crate::input::{compute_wheel_volume_delta, InputHook, WheelEvent};
use crate::osd::{is_foreground_fullscreen, OsdManager};
use crate::volume::{
    apply_volume_limits, calculate_acceleration, calculate_new_volume, VolumeBackend,
    WindowsVolumeController,
};
use crate::zones::{hit_test, HorizontalWheelAction, ModifierKey, VolumeTarget, Zone};

const WM_WATCHDOG_PING: u32 = WM_USER + 1042;

static PANIC_DISENGAGED: AtomicBool = AtomicBool::new(false);
static LAST_HEARTBEAT_MILLIS: AtomicU64 = AtomicU64::new(0);

pub fn emergency_panic_unhook() {
    PANIC_DISENGAGED.store(true, Ordering::SeqCst);
    let prev = HOOK_HANDLE.swap(0, Ordering::SeqCst);
    if prev != 0 {
        // SAFETY: Immediate emergency uninstallation of the low-level Windows hook
        unsafe {
            let _ = UnhookWindowsHookEx(HHOOK(prev as *mut _));
        }
    }
    log::warn!("EMERGENCY PANIC: Windows mouse hooks removed and Volume 3 disengaged.");
}

pub fn reset_panic_state() {
    PANIC_DISENGAGED.store(false, Ordering::SeqCst);
}

pub fn is_panic_disengaged() -> bool {
    PANIC_DISENGAGED.load(Ordering::SeqCst)
}

pub enum InputEvent {
    Wheel(WheelEvent),
    MuteToggle { zone_id: String },
}

struct GlobalHookState {
    zones: RwLock<Vec<Zone>>,
    fullscreen_rule: RwLock<FullscreenRule>,
    osd_config: RwLock<OsdConfig>,
    time_profile: RwLock<TimeProfile>,
    sender: RwLock<Sender<InputEvent>>,
}

static HOOK_STATE: OnceLock<GlobalHookState> = OnceLock::new();
static HOOK_HANDLE: AtomicIsize = AtomicIsize::new(0);

unsafe extern "system" fn low_level_mouse_proc(
    n_code: i32,
    w_param: WPARAM,
    l_param: LPARAM,
) -> LRESULT {
    if n_code < 0 || PANIC_DISENGAGED.load(Ordering::Relaxed) {
        // SAFETY: Chaining requirement for Windows hooks or emergency panic pass-through
        return unsafe { CallNextHookEx(None, n_code, w_param, l_param) };
    }

    let msg = w_param.0 as u32;

    if msg == WM_MOUSEWHEEL || msg == WM_MOUSEHWHEEL || msg == WM_MBUTTONDOWN {
        // SAFETY: l_param points to valid MSLLHOOKSTRUCT during low-level mouse hook invocation
        let info = unsafe { *(l_param.0 as *const MSLLHOOKSTRUCT) };
        let px = info.pt.x;
        let py = info.pt.y;

        if let Some(state) = HOOK_STATE.get() {
            // Check fullscreen rule: if disabled in fullscreen and foreground is fullscreen, pass through
            if let Ok(fs_rule) = state.fullscreen_rule.read() {
                if fs_rule.disable_in_fullscreen && is_foreground_fullscreen() {
                    return unsafe { CallNextHookEx(None, n_code, w_param, l_param) };
                }
            }

            // SAFETY: Asynchronous query of virtual modifier keys
            let (ctrl, shift, alt, meta) = unsafe {
                let c = (GetAsyncKeyState(VK_CONTROL.0 as i32) as u16 & 0x8000) != 0;
                let s = (GetAsyncKeyState(VK_SHIFT.0 as i32) as u16 & 0x8000) != 0;
                let a = (GetAsyncKeyState(VK_MENU.0 as i32) as u16 & 0x8000) != 0;
                let m = ((GetAsyncKeyState(VK_LWIN.0 as i32) as u16 & 0x8000) != 0)
                    || ((GetAsyncKeyState(VK_RWIN.0 as i32) as u16 & 0x8000) != 0);
                (c, s, a, m)
            };

            let matched_zone = if let Ok(zones_guard) = state.zones.read() {
                let res = hit_test(&zones_guard, px, py, ctrl, alt, shift, meta).cloned();
                if res.is_some() {
                    log::info!("MouseHook: wheel/click at ({px}, {py}) matched zone '{}'", res.as_ref().unwrap().name);
                } else if msg == WM_MOUSEWHEEL {
                    log::debug!("MouseHook: wheel at ({px}, {py}) did not match any zone (zones={})", zones_guard.len());
                }
                res
            } else {
                None
            };

            if let Some(zone) = matched_zone {
                if let Ok(sender_guard) = state.sender.read() {
                    // 1. Middle-click to mute
                    if msg == WM_MBUTTONDOWN {
                        if zone.middle_click_to_mute {
                            let _ = sender_guard.try_send(InputEvent::MuteToggle {
                                zone_id: zone.id.clone(),
                            });
                            return LRESULT(1); // Swallow middle click only when configured
                        }
                        return unsafe { CallNextHookEx(None, n_code, w_param, l_param) };
                    }

                    let raw_delta = (info.mouseData >> 16) as i16 as f32;

                    // 2. Horizontal wheel tilt handling
                    if msg == WM_MOUSEHWHEEL {
                        match zone.horizontal_action {
                            HorizontalWheelAction::MediaTrack => {
                                let next = raw_delta > 0.0;
                                send_media_key(next);
                                return LRESULT(1);
                            }
                            HorizontalWheelAction::Balance | HorizontalWheelAction::None => {
                                // Passed through or handled as horizontal
                            }
                        }
                    }

                    // 3. Vertical wheel event
                    let event = WheelEvent {
                        zone_id: zone.id.clone(),
                        raw_delta,
                        is_horizontal: msg == WM_MOUSEHWHEEL,
                        shift_down: shift,
                        ctrl_down: ctrl,
                        alt_down: alt,
                        meta_down: meta,
                        timestamp_ms: info.time as u64,
                    };

                    let res = sender_guard.try_send(InputEvent::Wheel(event));
                    if let Err(e) = res {
                        log::warn!("Low-level hook failed to send wheel event: {e}");
                    }
                    return LRESULT(1); // Swallow wheel inside zone
                }
            }
        }
    }

    // SAFETY: Forward non-wheel / non-zone events untouched
    unsafe { CallNextHookEx(None, n_code, w_param, l_param) }
}

fn send_media_key(next_track: bool) {
    let vk = if next_track {
        VK_MEDIA_NEXT_TRACK
    } else {
        VK_MEDIA_PREV_TRACK
    };
    // SAFETY: Synthesizing standard virtual media key press and release
    unsafe {
        keybd_event(vk.0 as u8, 0, Default::default(), 0);
        keybd_event(vk.0 as u8, 0, KEYEVENTF_KEYUP, 0);
    }
}

pub fn get_process_id_at_point(x: i32, y: i32) -> Option<u32> {
    // SAFETY: WindowFromPoint identifies the window beneath the physical coordinates
    unsafe {
        let pt = POINT { x, y };
        let hwnd = WindowFromPoint(pt);
        if hwnd.0.is_null() {
            return None;
        }
        let mut pid = 0u32;
        GetWindowThreadProcessId(hwnd, Some(&mut pid));
        if pid != 0 {
            Some(pid)
        } else {
            None
        }
    }
}

pub struct WindowsInputHook {
    active: bool,
    hook_thread_id: Option<u32>,
    worker_handle: Option<thread::JoinHandle<()>>,
    event_sender: Sender<InputEvent>,
    event_receiver: Option<Receiver<InputEvent>>,
    app_handle: Option<AppHandle>,
}

impl WindowsInputHook {
    pub fn new() -> Self {
        let (sender, receiver) = bounded::<InputEvent>(128);

        let _ = HOOK_STATE.set(GlobalHookState {
            zones: RwLock::new(Vec::new()),
            fullscreen_rule: RwLock::new(FullscreenRule::default()),
            osd_config: RwLock::new(OsdConfig::default()),
            time_profile: RwLock::new(TimeProfile::default()),
            sender: RwLock::new(sender.clone()),
        });

        Self {
            active: false,
            hook_thread_id: None,
            worker_handle: None,
            event_sender: sender,
            event_receiver: Some(receiver),
            app_handle: None,
        }
    }

    pub fn set_app_handle(&mut self, app: AppHandle) {
        self.app_handle = Some(app);
    }

    pub fn start_with_app(&mut self, app: AppHandle) -> Result<(), String> {
        self.app_handle = Some(app.clone());
        let receiver = if let Some(rx) = self.event_receiver.take() {
            rx
        } else {
            let (sender, receiver) = bounded::<InputEvent>(128);
            if let Some(state) = HOOK_STATE.get() {
                if let Ok(mut guard) = state.sender.write() {
                    *guard = sender.clone();
                }
            }
            self.event_sender = sender;
            receiver
        };

        let worker_app = app.clone();
        let worker_handle = thread::Builder::new()
            .name("volzone-input-worker".to_string())
            .spawn(move || {
                Self::run_worker_loop(receiver, worker_app);
            })
            .ok();

        self.worker_handle = worker_handle;
        self.start()?;

        // Spawn safety watchdog thread
        if let Some(thread_id) = self.hook_thread_id {
            let watchdog_app = app.clone();
            thread::Builder::new()
                .name("volzone-hook-watchdog".to_string())
                .spawn(move || {
                    let initial = std::time::SystemTime::now()
                        .duration_since(std::time::UNIX_EPOCH)
                        .unwrap_or_default()
                        .as_millis() as u64;
                    LAST_HEARTBEAT_MILLIS.store(initial, Ordering::SeqCst);

                    loop {
                        thread::sleep(std::time::Duration::from_millis(2000));

                        if PANIC_DISENGAGED.load(Ordering::SeqCst) {
                            break;
                        }

                        if HOOK_HANDLE.load(Ordering::SeqCst) == 0 {
                            continue;
                        }

                        // Ping hook thread
                        // SAFETY: PostThreadMessageW sends WM_WATCHDOG_PING to the hook thread message queue
                        let post_res = unsafe {
                            PostThreadMessageW(thread_id, WM_WATCHDOG_PING, WPARAM(0), LPARAM(0))
                        };

                        if post_res.is_err() {
                            log::error!("Watchdog: Hook thread {thread_id} dead or rejected ping; triggering emergency unhook.");
                            emergency_panic_unhook();
                            let _ = watchdog_app.emit("watchdog-stall-detected", "Hook thread terminated unexpectedly.");
                            break;
                        }

                        let now = std::time::SystemTime::now()
                            .duration_since(std::time::UNIX_EPOCH)
                            .unwrap_or_default()
                            .as_millis() as u64;
                        let last = LAST_HEARTBEAT_MILLIS.load(Ordering::Relaxed);

                        if now.saturating_sub(last) > 5500 {
                            log::error!("Watchdog: Hook thread {thread_id} stalled (>5s without heartbeat); emergency unhook executed.");
                            emergency_panic_unhook();
                            let _ = watchdog_app.emit("watchdog-stall-detected", "Hook thread stalled; hooks removed for system safety.");
                            break;
                        }
                    }
                    log::debug!("Hook watchdog monitor loop exited");
                })
                .ok();
        }

        Ok(())
    }

    fn run_worker_loop(receiver: Receiver<InputEvent>, app: AppHandle) {
        let backend = match WindowsVolumeController::new() {
            Ok(b) => b,
            Err(err) => {
                log::error!("Failed to initialize volume controller for worker: {err}");
                return;
            }
        };

        let osd_manager = OsdManager::new();
        let mut last_event_times: HashMap<String, Instant> = HashMap::new();

        while let Ok(msg) = receiver.recv() {
            let state = match HOOK_STATE.get() {
                Some(s) => s,
                None => continue,
            };

            match msg {
                InputEvent::MuteToggle { zone_id } => {
                    let zone = if let Ok(guard) = state.zones.read() {
                        guard.iter().find(|z| z.id == zone_id).cloned()
                    } else {
                        None
                    };

                    if let Some(zone) = zone {
                        let osd_cfg = if let Some(state) = HOOK_STATE.get() {
                            state.osd_config.read().map(|g| g.clone()).unwrap_or_default()
                        } else {
                            OsdConfig::default()
                        };
                        if let Ok(muted) = backend.get_mute(&zone.target) {
                            let _ = backend.set_mute(&zone.target, !muted);
                            if let Ok(vol) = backend.get_volume(&zone.target) {
                                osd_manager.show_volume(
                                    &app,
                                    &osd_cfg,
                                    vol,
                                    !muted,
                                    &zone.name,
                                );
                            }
                        }
                    }
                }
                InputEvent::Wheel(event) => {
                    let zone = if let Ok(guard) = state.zones.read() {
                        guard.iter().find(|z| z.id == event.zone_id).cloned()
                    } else {
                        None
                    };

                    let zone = match zone {
                        Some(z) => z,
                        None => continue,
                    };

                    let now = Instant::now();
                    let delta_ms = if let Some(last_time) = last_event_times.get(&zone.id) {
                        now.duration_since(*last_time).as_millis() as u64
                    } else {
                        1000
                    };
                    last_event_times.insert(zone.id.clone(), now);

                    let accel_mult = calculate_acceleration(delta_ms, zone.acceleration);

                    // Check remapped coarse/fine modifiers
                    let is_coarse = match zone.coarse_modifier {
                        ModifierKey::Shift => event.shift_down,
                        ModifierKey::Ctrl => event.ctrl_down,
                        ModifierKey::Alt => event.alt_down,
                        ModifierKey::None => false,
                    };
                    let is_fine = match zone.fine_modifier {
                        ModifierKey::Shift => event.shift_down,
                        ModifierKey::Ctrl => event.ctrl_down,
                        ModifierKey::Alt => event.alt_down,
                        ModifierKey::None => false,
                    };

                    let (is_up, step) = compute_wheel_volume_delta(
                        event.raw_delta,
                        zone.step,
                        is_coarse,
                        is_fine,
                        accel_mult,
                    );

                    // Resolve target (handles AppUnderCursor if needed)
                    let target = match zone.target {
                        VolumeTarget::AppUnderCursor => {
                            // Query process ID at cursor coordinates
                            // SAFETY: Getting cursor physical pos
                            let mut pt = POINT::default();
                            unsafe {
                                let _ =
                                    windows::Win32::UI::WindowsAndMessaging::GetCursorPos(&mut pt);
                            }
                            if let Some(pid) = get_process_id_at_point(pt.x, pt.y) {
                                VolumeTarget::App(pid.to_string())
                            } else {
                                VolumeTarget::Master
                            }
                        }
                        ref t => t.clone(),
                    };

                    if let Ok(curr_vol) = backend.get_volume(&target) {
                        let target_vol =
                            calculate_new_volume(curr_vol, step, is_up, zone.invert, 1.0);
                        let time_cap = state
                            .time_profile
                            .read()
                            .ok()
                            .and_then(|tp| tp.current_cap());
                        let final_vol = apply_volume_limits(
                            target_vol,
                            curr_vol,
                            zone.min_volume,
                            zone.max_volume,
                            zone.soft_start_limit,
                            time_cap,
                        );

                        if let Err(err) = backend.set_volume(&target, final_vol) {
                            log::warn!(
                                "Worker failed to set volume for zone '{}': {err}",
                                zone.name
                            );
                        } else {
                            log::info!(
                                "Volume updated for zone '{}': {:.0}% -> {:.0}%",
                                zone.name,
                                curr_vol * 100.0,
                                final_vol * 100.0
                            );

                            // Zone tint pulse feedback
                            if zone.pulse_tint {
                                let _ = app.emit("zone-pulse", zone.id.clone());
                            }

                            let osd_cfg = state
                                .osd_config
                                .read()
                                .map(|g| g.clone())
                                .unwrap_or_default();

                            // Show OSD feedback
                            osd_manager.show_volume(
                                &app,
                                &osd_cfg,
                                final_vol,
                                false,
                                &zone.name,
                            );
                        }
                    }
                }
            }
        }
    }

    pub fn is_elevated() -> bool {
        let mut token = HANDLE::default();
        // SAFETY: Querying current process token elevation status
        unsafe {
            if OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &mut token).is_ok() {
                let mut elevation = TOKEN_ELEVATION::default();
                let mut return_length = 0u32;
                let res = GetTokenInformation(
                    token,
                    TokenElevation,
                    Some(&mut elevation as *mut _ as *mut _),
                    std::mem::size_of::<TOKEN_ELEVATION>() as u32,
                    &mut return_length,
                );
                let _ = windows::Win32::Foundation::CloseHandle(token);
                if res.is_ok() {
                    return elevation.TokenIsElevated != 0;
                }
            }
        }
        false
    }
}

impl Default for WindowsInputHook {
    fn default() -> Self {
        Self::new()
    }
}

impl InputHook for WindowsInputHook {
    fn start(&mut self) -> Result<(), String> {
        if self.active {
            return Ok(());
        }

        let is_admin = Self::is_elevated();
        log::info!("Starting Windows WH_MOUSE_LL hook (Elevated: {is_admin})");

        let (tx, rx) = std::sync::mpsc::channel();

        thread::Builder::new()
            .name("volzone-mouse-hook".to_string())
            .spawn(move || {
                // SAFETY: Installing thread-level low-level mouse hook
                let hook =
                    unsafe { SetWindowsHookExW(WH_MOUSE_LL, Some(low_level_mouse_proc), None, 0) };

                let hook_handle = match hook {
                    Ok(h) => h,
                    Err(e) => {
                        let _ = tx.send(Err(format!("SetWindowsHookExW failed: {e}")));
                        return;
                    }
                };

                HOOK_HANDLE.store(hook_handle.0 as isize, Ordering::SeqCst);

                // SAFETY: Thread ID for posting WM_QUIT on cleanup
                let thread_id = unsafe { windows::Win32::System::Threading::GetCurrentThreadId() };
                let _ = tx.send(Ok(thread_id));

                log::debug!("Low-level mouse hook loop entering message pump");
                let mut msg = MSG::default();
                // SAFETY: Message pump processing mouse hook callbacks
                unsafe {
                    while GetMessageW(&mut msg, None, 0, 0).as_bool() {
                        if msg.message == WM_WATCHDOG_PING {
                            let now = std::time::SystemTime::now()
                                .duration_since(std::time::UNIX_EPOCH)
                                .unwrap_or_default()
                                .as_millis() as u64;
                            LAST_HEARTBEAT_MILLIS.store(now, Ordering::Relaxed);
                            continue;
                        }
                        let _ = TranslateMessage(&msg);
                        DispatchMessageW(&msg);
                    }
                }

                let prev = HOOK_HANDLE.swap(0, Ordering::SeqCst);
                if prev != 0 {
                    // SAFETY: Unhooking low-level hook on thread termination
                    unsafe {
                        let _ = UnhookWindowsHookEx(HHOOK(prev as *mut _));
                    }
                }
                log::debug!("Low-level mouse hook loop terminated");
            })
            .map_err(|e| format!("Failed to spawn mouse hook thread: {e}"))?;

        let thread_id = rx
            .recv()
            .map_err(|e| format!("Hook thread channel error: {e}"))??;

        self.hook_thread_id = Some(thread_id);
        self.active = true;
        Ok(())
    }

    fn stop(&mut self) -> Result<(), String> {
        if !self.active {
            return Ok(());
        }

        if let Some(thread_id) = self.hook_thread_id.take() {
            // SAFETY: Posting WM_QUIT terminates the GetMessageW pump cleanly
            unsafe {
                let _ = PostThreadMessageW(thread_id, WM_QUIT, WPARAM(0), LPARAM(0));
            }
        }

        self.active = false;
        Ok(())
    }

    fn update_zones(&self, zones: Vec<Zone>) {
        if let Some(state) = HOOK_STATE.get() {
            if let Ok(mut guard) = state.zones.write() {
                *guard = zones;
            }
        }
    }

    fn update_osd(&self, osd: OsdConfig) {
        if let Some(state) = HOOK_STATE.get() {
            if let Ok(mut guard) = state.osd_config.write() {
                *guard = osd;
            }
        }
    }

    fn update_time_profile(&self, tp: TimeProfile) {
        if let Some(state) = HOOK_STATE.get() {
            if let Ok(mut guard) = state.time_profile.write() {
                *guard = tp;
            }
        }
    }

    fn update_fullscreen_rule(&self, rule: FullscreenRule) {
        if let Some(state) = HOOK_STATE.get() {
            if let Ok(mut guard) = state.fullscreen_rule.write() {
                *guard = rule;
            }
        }
    }
}
