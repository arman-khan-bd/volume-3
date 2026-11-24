#![allow(dead_code)]

use std::sync::atomic::{AtomicBool, AtomicU32};
use std::sync::Arc;

#[cfg(target_os = "windows")]
use std::sync::atomic::Ordering;
#[cfg(target_os = "windows")]
use std::thread;

pub struct HotkeyManager {
    active: Arc<AtomicBool>,
    thread_id: Arc<AtomicU32>,
}

impl HotkeyManager {
    pub fn new() -> Self {
        Self {
            active: Arc::new(AtomicBool::new(false)),
            thread_id: Arc::new(AtomicU32::new(0)),
        }
    }

    /// Registers the default global hotkeys:
    /// - `Ctrl+Alt+V`: Toggle Edit Mode
    /// - `Ctrl+Alt+Shift+Escape`: Emergency Panic Hotkey (instantly unhooks and disables all zones)
    pub fn register_defaults<F1, F2>(&mut self, on_toggle: F1, on_panic: F2) -> Result<(), String>
    where
        F1: Fn() + Send + Sync + 'static,
        F2: Fn() + Send + Sync + 'static,
    {
        #[cfg(target_os = "windows")]
        {
            use windows::Win32::Foundation::WPARAM;
            use windows::Win32::UI::Input::KeyboardAndMouse::{
                RegisterHotKey, UnregisterHotKey, MOD_ALT, MOD_CONTROL, MOD_NOREPEAT, MOD_SHIFT,
            };
            use windows::Win32::UI::WindowsAndMessaging::{
                DispatchMessageW, GetMessageW, TranslateMessage, MSG, WM_HOTKEY,
            };

            let active_flag = Arc::clone(&self.active);
            let thread_id_store = Arc::clone(&self.thread_id);
            let on_toggle = Arc::new(on_toggle);
            let on_panic = Arc::new(on_panic);

            let (tx, rx) = std::sync::mpsc::channel::<Result<(), String>>();

            thread::Builder::new()
                .name("volzone-hotkeys".to_string())
                .spawn(move || {
                    let tid = unsafe { windows::Win32::System::Threading::GetCurrentThreadId() };
                    thread_id_store.store(tid, Ordering::SeqCst);

                    // 1. Register Ctrl + Alt + V (0x56 = 'V')
                    let edit_hotkey_id = 1001;
                    // SAFETY: Registering thread-level hotkey with NULL HWND
                    let reg_edit = unsafe {
                        RegisterHotKey(
                            None,
                            edit_hotkey_id,
                            MOD_CONTROL | MOD_ALT | MOD_NOREPEAT,
                            0x56,
                        )
                    };

                    if let Err(err) = reg_edit {
                        log::error!("Failed to register Edit Mode hotkey Ctrl+Alt+V: {err}");
                    } else {
                        log::info!("Global hotkey Ctrl+Alt+V registered successfully");
                    }

                    // 2. Register Emergency Panic hotkey: Ctrl + Alt + Shift + Escape (0x1B = Escape)
                    let panic_hotkey_id = 1002;
                    // SAFETY: Registering emergency panic hotkey
                    let reg_panic = unsafe {
                        RegisterHotKey(
                            None,
                            panic_hotkey_id,
                            MOD_CONTROL | MOD_ALT | MOD_SHIFT | MOD_NOREPEAT,
                            0x1B, // VK_ESCAPE
                        )
                    };

                    let panic_registered = if reg_panic.is_err() {
                        // Fall back to Ctrl + Alt + Shift + P (0x50 = 'P')
                        unsafe {
                            RegisterHotKey(
                                None,
                                panic_hotkey_id,
                                MOD_CONTROL | MOD_ALT | MOD_SHIFT | MOD_NOREPEAT,
                                0x50, // 'P'
                            ).is_ok()
                        }
                    } else {
                        true
                    };

                    if panic_registered {
                        log::info!("Emergency Panic hotkey (Ctrl+Alt+Shift+Escape) registered successfully");
                    } else {
                        log::warn!("Could not register Emergency Panic hotkey");
                    }

                    active_flag.store(true, Ordering::SeqCst);
                    let _ = tx.send(Ok(()));

                    let mut msg = MSG::default();
                    // SAFETY: Standard message loop waiting for WM_HOTKEY on dedicated thread
                    unsafe {
                        while GetMessageW(&mut msg, None, 0, 0).as_bool() {
                            if msg.message == WM_HOTKEY {
                                if msg.wParam == WPARAM(edit_hotkey_id as usize) {
                                    log::info!("Global hotkey Ctrl+Alt+V pressed; toggling edit mode");
                                    on_toggle();
                                } else if msg.wParam == WPARAM(panic_hotkey_id as usize) {
                                    log::warn!("EMERGENCY PANIC hotkey pressed; removing all hooks immediately!");
                                    on_panic();
                                }
                            }
                            let _ = TranslateMessage(&msg);
                            DispatchMessageW(&msg);
                        }
                        // Cleanup hotkeys on thread exit
                        let _ = UnregisterHotKey(None, edit_hotkey_id);
                        let _ = UnregisterHotKey(None, panic_hotkey_id);
                    }
                    active_flag.store(false, Ordering::SeqCst);
                    log::debug!("Hotkey loop terminated");
                })
                .map_err(|e| format!("Failed to spawn hotkey thread: {e}"))?;

            rx.recv().map_err(|e| format!("Hotkey init error: {e}"))??;
            return Ok(());
        }

        #[cfg(not(target_os = "windows"))]
        {
            let _ = on_toggle;
            let _ = on_panic;
            log::info!("Global hotkey registration stubbed on non-Windows platform");
            Ok(())
        }
    }
}

impl Default for HotkeyManager {
    fn default() -> Self {
        Self::new()
    }
}
