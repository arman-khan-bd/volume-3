#![allow(dead_code)]
// windows::core::implement macro expands #[inline(always)] and &self -> ptr conversions
#![allow(clippy::inline_always, clippy::ref_as_ptr)]

use crate::volume::{clamp_volume, AppAudioSession, VolumeBackend};
use crate::zones::VolumeTarget;
use std::collections::HashSet;
use std::sync::{Arc, Mutex};
use windows::Win32::Foundation::{CloseHandle, PROPERTYKEY};
use windows::Win32::Media::Audio::Endpoints::{
    IAudioEndpointVolume, IAudioEndpointVolumeCallback, IAudioEndpointVolumeCallback_Impl,
};
use windows::Win32::Media::Audio::{
    eCapture, eConsole, eMultimedia, eRender, EDataFlow, ERole, IAudioSessionControl2,
    IAudioSessionManager2, IMMDeviceEnumerator, IMMNotificationClient, IMMNotificationClient_Impl,
    ISimpleAudioVolume, MMDeviceEnumerator, AUDIO_VOLUME_NOTIFICATION_DATA, DEVICE_STATE,
};
use windows::Win32::System::Com::{
    CoCreateInstance, CoInitializeEx, CLSCTX_ALL, COINIT_MULTITHREADED,
};
use windows::Win32::System::Threading::{
    OpenProcess, QueryFullProcessImageNameW, PROCESS_NAME_WIN32, PROCESS_QUERY_LIMITED_INFORMATION,
};
use windows_core::{implement, Interface, PCWSTR};

fn resolve_process_name(pid: u32) -> Option<String> {
    if pid == 0 {
        return None;
    }
    // SAFETY: Querying process image path for friendly mixer labels using limited query access
    unsafe {
        let handle = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid).ok()?;
        let mut buf = [0u16; 260];
        let mut size = buf.len() as u32;
        let ok = QueryFullProcessImageNameW(
            handle,
            PROCESS_NAME_WIN32,
            windows_core::PWSTR(buf.as_mut_ptr()),
            &mut size,
        )
        .is_ok();
        let _ = CloseHandle(handle);
        if !ok || size == 0 {
            return None;
        }
        let path = String::from_utf16_lossy(&buf[..size as usize]);
        let exe = std::path::Path::new(&path).file_stem()?.to_str()?;
        let mut chars = exe.chars();
        let first = chars.next()?;
        let friendly = first.to_uppercase().collect::<String>() + chars.as_str();
        Some(friendly)
    }
}

type VolumeSubscriber = Box<dyn Fn(f32, bool) + Send + Sync>;

#[implement(IAudioEndpointVolumeCallback)]
struct VolumeChangeCallback {
    subscribers: Arc<Mutex<Vec<VolumeSubscriber>>>,
}

impl IAudioEndpointVolumeCallback_Impl for VolumeChangeCallback_Impl {
    fn OnNotify(&self, pnotify: *mut AUDIO_VOLUME_NOTIFICATION_DATA) -> windows_core::Result<()> {
        if !pnotify.is_null() {
            // SAFETY: The pointer pnotify is provided by Windows WASAPI and points to a valid
            // AUDIO_VOLUME_NOTIFICATION_DATA struct for the duration of this callback invocation.
            unsafe {
                let data = &*pnotify;
                let vol = data.fMasterVolume;
                let muted = data.bMuted.as_bool();
                if let Ok(subs) = self.subscribers.lock() {
                    for sub in subs.iter() {
                        sub(vol, muted);
                    }
                }
            }
        }
        Ok(())
    }
}

#[implement(IMMNotificationClient)]
struct DeviceChangeNotifier {
    active_master_endpoint: Arc<Mutex<Option<IAudioEndpointVolume>>>,
    enumerator: IMMDeviceEnumerator,
    subscribers: Arc<Mutex<Vec<VolumeSubscriber>>>,
    registered_callback: Arc<Mutex<Option<IAudioEndpointVolumeCallback>>>,
}

impl IMMNotificationClient_Impl for DeviceChangeNotifier_Impl {
    fn OnDeviceStateChanged(
        &self,
        _pwstrdeviceid: &PCWSTR,
        _dwnewstate: DEVICE_STATE,
    ) -> windows_core::Result<()> {
        Ok(())
    }

    fn OnDeviceAdded(&self, _pwstrdeviceid: &PCWSTR) -> windows_core::Result<()> {
        Ok(())
    }

    fn OnDeviceRemoved(&self, _pwstrdeviceid: &PCWSTR) -> windows_core::Result<()> {
        Ok(())
    }

    fn OnDefaultDeviceChanged(
        &self,
        flow: EDataFlow,
        role: ERole,
        _pwstrdefaultdeviceid: &PCWSTR,
    ) -> windows_core::Result<()> {
        // When the default render device changes for multimedia/console, re-bind the active endpoint
        if flow == eRender && (role == eConsole || role == eMultimedia) {
            log::info!("Default audio render device changed; updating WASAPI endpoint");
            // SAFETY: enumerator is a valid COM interface initialized in multithreaded apartment
            let new_endpoint = unsafe {
                if let Ok(device) = self.enumerator.GetDefaultAudioEndpoint(eRender, eConsole) {
                    device
                        .Activate::<IAudioEndpointVolume>(CLSCTX_ALL, None)
                        .ok()
                } else {
                    None
                }
            };

            if let Some(ref ep) = new_endpoint {
                if let Ok(cb_guard) = self.registered_callback.lock() {
                    if let Some(ref cb) = *cb_guard {
                        // SAFETY: Valid COM endpoint and callback interface
                        unsafe {
                            let _ = ep.RegisterControlChangeNotify(cb);
                        }
                    }
                }
            }

            if let Ok(mut guard) = self.active_master_endpoint.lock() {
                *guard = new_endpoint;
            }
        }
        Ok(())
    }

    fn OnPropertyValueChanged(
        &self,
        _pwstrdeviceid: &PCWSTR,
        _key: &PROPERTYKEY,
    ) -> windows_core::Result<()> {
        Ok(())
    }
}

pub struct WindowsVolumeController {
    enumerator: IMMDeviceEnumerator,
    active_master_endpoint: Arc<Mutex<Option<IAudioEndpointVolume>>>,
    subscribers: Arc<Mutex<Vec<VolumeSubscriber>>>,
    registered_callback: Arc<Mutex<Option<IAudioEndpointVolumeCallback>>>,
    _device_notifier: Option<IMMNotificationClient>,
}

// SAFETY: Windows COM interfaces in WindowsVolumeController are initialized under COINIT_MULTITHREADED
// apartment and all internal shared state is synchronized with Arc/Mutex primitives.
unsafe impl Send for WindowsVolumeController {}
unsafe impl Sync for WindowsVolumeController {}

impl WindowsVolumeController {
    pub fn new() -> Result<Self, String> {
        // Initialize COM library for current thread if not already initialized
        // SAFETY: CoInitializeEx is safe with multithreaded concurrency model
        unsafe {
            let _ = CoInitializeEx(None, COINIT_MULTITHREADED);
        }

        // SAFETY: CoCreateInstance instantiates standard Windows MMDeviceEnumerator COM object
        let enumerator: IMMDeviceEnumerator = unsafe {
            CoCreateInstance(&MMDeviceEnumerator, None, CLSCTX_ALL)
                .map_err(|e| format!("Failed to create MMDeviceEnumerator: {e}"))?
        };

        // SAFETY: Querying default audio endpoint from valid MMDeviceEnumerator COM object
        let master_endpoint: Option<IAudioEndpointVolume> = unsafe {
            enumerator
                .GetDefaultAudioEndpoint(eRender, eConsole)
                .and_then(|dev| dev.Activate::<IAudioEndpointVolume>(CLSCTX_ALL, None))
                .ok()
        };

        #[allow(clippy::arc_with_non_send_sync)]
        let active_master_endpoint = Arc::new(Mutex::new(master_endpoint));
        let subscribers = Arc::new(Mutex::new(Vec::new()));
        #[allow(clippy::arc_with_non_send_sync)]
        let registered_callback = Arc::new(Mutex::new(None));

        let notifier: IMMNotificationClient = DeviceChangeNotifier {
            active_master_endpoint: Arc::clone(&active_master_endpoint),
            enumerator: enumerator.clone(),
            subscribers: Arc::clone(&subscribers),
            registered_callback: Arc::clone(&registered_callback),
        }
        .into();

        // SAFETY: Registering endpoint notification callback on valid enumerator COM interface
        unsafe {
            let _ = enumerator.RegisterEndpointNotificationCallback(&notifier);
        }

        Ok(Self {
            enumerator,
            active_master_endpoint,
            subscribers,
            registered_callback,
            _device_notifier: Some(notifier),
        })
    }

    fn get_endpoint(&self, target: &VolumeTarget) -> Result<IAudioEndpointVolume, String> {
        match target {
            VolumeTarget::Master => {
                if let Ok(guard) = self.active_master_endpoint.lock() {
                    if let Some(ref ep) = *guard {
                        return Ok(ep.clone());
                    }
                }
                // SAFETY: Fallback re-acquisition of default audio endpoint
                unsafe {
                    let dev = self
                        .enumerator
                        .GetDefaultAudioEndpoint(eRender, eConsole)
                        .map_err(|e| format!("Default audio render device not available: {e}"))?;
                    dev.Activate::<IAudioEndpointVolume>(CLSCTX_ALL, None)
                        .map_err(|e| format!("Failed to activate IAudioEndpointVolume: {e}"))
                }
            }
            VolumeTarget::Mic => {
                // SAFETY: Acquisition of default capture/microphone endpoint
                unsafe {
                    let dev = self
                        .enumerator
                        .GetDefaultAudioEndpoint(eCapture, eConsole)
                        .map_err(|e| format!("Default capture/mic device not available: {e}"))?;
                    dev.Activate::<IAudioEndpointVolume>(CLSCTX_ALL, None)
                        .map_err(|e| format!("Failed to activate Mic IAudioEndpointVolume: {e}"))
                }
            }
            VolumeTarget::App(_) | VolumeTarget::AppUnderCursor => {
                Err("Direct endpoint access not applicable for per-app target".to_string())
            }
        }
    }
}

impl VolumeBackend for WindowsVolumeController {
    fn get_volume(&self, target: &VolumeTarget) -> Result<f32, String> {
        match target {
            VolumeTarget::Master | VolumeTarget::Mic => {
                let endpoint = self.get_endpoint(target)?;
                // SAFETY: Calling GetMasterVolumeLevelScalar on valid activated COM interface
                unsafe {
                    endpoint
                        .GetMasterVolumeLevelScalar()
                        .map_err(|e| format!("Failed to get volume level: {e}"))
                }
            }
            VolumeTarget::App(app_id) => {
                let apps = self.list_apps()?;
                apps.into_iter()
                    .find(|a| {
                        a.id.eq_ignore_ascii_case(app_id) || a.name.eq_ignore_ascii_case(app_id)
                    })
                    .map(|a| a.volume)
                    .ok_or_else(|| format!("Application audio session '{app_id}' not found"))
            }
            VolumeTarget::AppUnderCursor => self.get_volume(&VolumeTarget::Master),
        }
    }

    fn set_volume(&self, target: &VolumeTarget, level: f32) -> Result<(), String> {
        let clamped = clamp_volume(level);
        match target {
            VolumeTarget::Master | VolumeTarget::Mic => {
                let endpoint = self.get_endpoint(target)?;
                // SAFETY: Passing valid clamped float (0.0..=1.0) and null event context to WASAPI endpoint
                unsafe {
                    endpoint
                        .SetMasterVolumeLevelScalar(clamped, std::ptr::null())
                        .map_err(|e| format!("Failed to set volume level: {e}"))
                }
            }
            VolumeTarget::App(app_id) => self.set_app_volume(app_id, clamped),
            VolumeTarget::AppUnderCursor => self.set_volume(&VolumeTarget::Master, clamped),
        }
    }

    fn get_mute(&self, target: &VolumeTarget) -> Result<bool, String> {
        match target {
            VolumeTarget::Master | VolumeTarget::Mic => {
                let endpoint = self.get_endpoint(target)?;
                // SAFETY: Calling GetMute on valid activated COM interface
                unsafe {
                    endpoint
                        .GetMute()
                        .map(windows_core::BOOL::as_bool)
                        .map_err(|e| format!("Failed to get mute status: {e}"))
                }
            }
            VolumeTarget::App(app_id) => {
                let apps = self.list_apps()?;
                apps.into_iter()
                    .find(|a| {
                        a.id.eq_ignore_ascii_case(app_id) || a.name.eq_ignore_ascii_case(app_id)
                    })
                    .map(|a| a.muted)
                    .ok_or_else(|| format!("Application audio session '{app_id}' not found"))
            }
            VolumeTarget::AppUnderCursor => self.get_mute(&VolumeTarget::Master),
        }
    }

    fn set_mute(&self, target: &VolumeTarget, muted: bool) -> Result<(), String> {
        match target {
            VolumeTarget::Master | VolumeTarget::Mic => {
                let endpoint = self.get_endpoint(target)?;
                // SAFETY: Setting mute status with null event context on valid WASAPI endpoint
                unsafe {
                    endpoint
                        .SetMute(muted, std::ptr::null())
                        .map_err(|e| format!("Failed to set mute status: {e}"))
                }
            }
            VolumeTarget::AppUnderCursor => self.set_mute(&VolumeTarget::Master, muted),
            VolumeTarget::App(app_id) => {
                // SAFETY: Querying default render device to access audio session manager
                let device = unsafe {
                    self.enumerator
                        .GetDefaultAudioEndpoint(eRender, eConsole)
                        .map_err(|e| format!("Default device not available: {e}"))?
                };
                // SAFETY: Activating IAudioSessionManager2 on valid IMMDevice
                let manager: IAudioSessionManager2 = unsafe {
                    device
                        .Activate(CLSCTX_ALL, None)
                        .map_err(|e| format!("Failed to activate session manager: {e}"))?
                };
                // SAFETY: Getting session enumerator from valid IAudioSessionManager2
                let session_enum = unsafe {
                    manager
                        .GetSessionEnumerator()
                        .map_err(|e| format!("Failed to get session enumerator: {e}"))?
                };
                let count = unsafe { session_enum.GetCount().unwrap_or(0) };
                let mut updated = false;

                for i in 0..count {
                    // SAFETY: Enumerating session at index i
                    let Ok(session) = (unsafe { session_enum.GetSession(i) }) else {
                        continue;
                    };
                    if let Ok(control2) = session.cast::<IAudioSessionControl2>() {
                        let pid = unsafe { control2.GetProcessId().unwrap_or(0) };
                        let matches_name = resolve_process_name(pid)
                            .is_some_and(|n| n.eq_ignore_ascii_case(app_id.as_str()));
                        if pid.to_string() == app_id.as_str() || matches_name {
                            if let Ok(simple_vol) = session.cast::<ISimpleAudioVolume>() {
                                // SAFETY: Setting mute on target session
                                unsafe {
                                    simple_vol
                                        .SetMute(muted, std::ptr::null())
                                        .map_err(|e| format!("Failed to mute session: {e}"))?;
                                }
                                updated = true;
                            }
                        }
                    }
                }
                if updated {
                    Ok(())
                } else {
                    Err(format!("Application audio session '{app_id}' not found"))
                }
            }
        }
    }

    fn subscribe_changes(
        &self,
        callback: Box<dyn Fn(f32, bool) + Send + Sync>,
    ) -> Result<(), String> {
        let mut subs = self.subscribers.lock().map_err(|e| e.to_string())?;
        subs.push(callback);

        let mut cb_guard = self.registered_callback.lock().map_err(|e| e.to_string())?;
        if cb_guard.is_none() {
            let callback_impl: IAudioEndpointVolumeCallback = VolumeChangeCallback {
                subscribers: Arc::clone(&self.subscribers),
            }
            .into();

            if let Ok(endpoint) = self.get_endpoint(&VolumeTarget::Master) {
                // SAFETY: Registering valid COM notification callback
                unsafe {
                    endpoint
                        .RegisterControlChangeNotify(&callback_impl)
                        .map_err(|e| format!("Failed to register control change notify: {e}"))?;
                }
            }
            *cb_guard = Some(callback_impl);
        }

        Ok(())
    }

    fn list_apps(&self) -> Result<Vec<AppAudioSession>, String> {
        // SAFETY: Querying default audio render device
        let device = unsafe {
            self.enumerator
                .GetDefaultAudioEndpoint(eRender, eConsole)
                .map_err(|e| format!("Audio render device not available: {e}"))?
        };

        // SAFETY: Activating IAudioSessionManager2
        let manager: IAudioSessionManager2 = unsafe {
            device
                .Activate(CLSCTX_ALL, None)
                .map_err(|e| format!("Failed to activate audio session manager: {e}"))?
        };

        // SAFETY: Getting session enumerator
        let session_enum = unsafe {
            manager
                .GetSessionEnumerator()
                .map_err(|e| format!("Failed to get session enumerator: {e}"))?
        };

        let count = unsafe { session_enum.GetCount().unwrap_or(0) };
        let mut result = Vec::with_capacity(count as usize);
        let mut seen_pids = HashSet::new();

        for i in 0..count {
            // SAFETY: Accessing session at index i
            let Ok(session) = (unsafe { session_enum.GetSession(i) }) else {
                continue;
            };

            let Ok(control2) = session.cast::<IAudioSessionControl2>() else {
                continue;
            };

            let pid = unsafe { control2.GetProcessId().unwrap_or(0) };
            if pid == 0 || !seen_pids.insert(pid) {
                continue;
            }

            let Ok(simple_vol) = session.cast::<ISimpleAudioVolume>() else {
                continue;
            };

            // SAFETY: Calling GetMasterVolume and GetMute on valid ISimpleAudioVolume
            let (vol, muted) = unsafe {
                let v = simple_vol.GetMasterVolume().unwrap_or(1.0);
                let m = simple_vol.GetMute().is_ok_and(windows_core::BOOL::as_bool);
                (v, m)
            };

            let name = resolve_process_name(pid).unwrap_or_else(|| format!("App #{pid}"));
            result.push(AppAudioSession {
                id: pid.to_string(),
                name,
                volume: vol,
                muted,
            });
        }

        Ok(result)
    }

    fn set_app_volume(&self, app_id: &str, level: f32) -> Result<(), String> {
        let clamped = clamp_volume(level);
        // SAFETY: Querying default render device
        let device = unsafe {
            self.enumerator
                .GetDefaultAudioEndpoint(eRender, eConsole)
                .map_err(|e| format!("Audio render device not available: {e}"))?
        };

        // SAFETY: Activating IAudioSessionManager2
        let manager: IAudioSessionManager2 = unsafe {
            device
                .Activate(CLSCTX_ALL, None)
                .map_err(|e| format!("Failed to activate audio session manager: {e}"))?
        };

        // SAFETY: Getting session enumerator
        let session_enum = unsafe {
            manager
                .GetSessionEnumerator()
                .map_err(|e| format!("Failed to get session enumerator: {e}"))?
        };

        let count = unsafe { session_enum.GetCount().unwrap_or(0) };
        let mut updated = false;
        for i in 0..count {
            // SAFETY: Accessing session at index i
            let Ok(session) = (unsafe { session_enum.GetSession(i) }) else {
                continue;
            };

            if let Ok(control2) = session.cast::<IAudioSessionControl2>() {
                let pid = unsafe { control2.GetProcessId().unwrap_or(0) };
                let matches_name =
                    resolve_process_name(pid).is_some_and(|n| n.eq_ignore_ascii_case(app_id));
                if pid.to_string() == app_id || matches_name {
                    if let Ok(simple_vol) = session.cast::<ISimpleAudioVolume>() {
                        // SAFETY: Setting session volume on valid ISimpleAudioVolume with null event context
                        unsafe {
                            simple_vol
                                .SetMasterVolume(clamped, std::ptr::null())
                                .map_err(|e| format!("Failed to set session volume: {e}"))?;
                        }
                        updated = true;
                    }
                }
            }
        }

        if updated {
            Ok(())
        } else {
            Err(format!("Application audio session '{app_id}' not found"))
        }
    }
}
