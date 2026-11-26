#![allow(dead_code)]

use log::{Level, LevelFilter, Metadata, Record};
use std::fs::{self, File, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

const MAX_LOG_SIZE_BYTES: u64 = 2 * 1024 * 1024; // 2 MB
const MAX_BACKUP_FILES: usize = 3;

/// Resolves the standard OS log directory for Volume 3:
/// - Windows: %LOCALAPPDATA%\Volume 3\logs
/// - macOS:   ~/Library/Logs/Volume 3
/// - Linux:   ~/.local/state/volume-3/logs or ~/.cache/volume-3/logs
pub fn get_log_dir() -> PathBuf {
    #[cfg(target_os = "windows")]
    {
        if let Some(dir) = dirs::data_local_dir() {
            return dir.join("Volume 3").join("logs");
        }
    }
    #[cfg(target_os = "macos")]
    {
        if let Some(dir) = dirs::home_dir() {
            return dir.join("Library").join("Logs").join("Volume 3");
        }
    }
    #[cfg(target_os = "linux")]
    {
        if let Some(dir) = dirs::state_dir().or_else(dirs::cache_dir) {
            return dir.join("volume-3").join("logs");
        }
    }
    PathBuf::from("./logs")
}

struct RotatingLoggerInner {
    log_dir: PathBuf,
    current_file: Option<File>,
    current_size: u64,
}

impl RotatingLoggerInner {
    fn new(log_dir: PathBuf) -> Result<Self, std::io::Error> {
        fs::create_dir_all(&log_dir)?;
        let main_path = log_dir.join("volume-3.log");
        let current_size = if main_path.exists() {
            fs::metadata(&main_path)?.len()
        } else {
            0
        };

        let file = OpenOptions::new()
            .create(true)
            .append(true)
            .open(&main_path)?;

        Ok(Self {
            log_dir,
            current_file: Some(file),
            current_size,
        })
    }

    fn rotate_if_needed(&mut self, next_bytes: u64) -> Result<(), std::io::Error> {
        if self.current_size + next_bytes <= MAX_LOG_SIZE_BYTES {
            return Ok(());
        }

        // Close current file handle
        self.current_file = None;

        let main_path = self.log_dir.join("volume-3.log");

        // Rotate existing backup files: .2 -> .3, .1 -> .2, main -> .1
        for i in (1..MAX_BACKUP_FILES).rev() {
            let src = self.log_dir.join(format!("volume-3.log.{i}"));
            let dst = self.log_dir.join(format!("volume-3.log.{}", i + 1));
            if src.exists() {
                let _ = fs::rename(&src, &dst);
            }
        }

        let first_backup = self.log_dir.join("volume-3.log.1");
        if main_path.exists() {
            let _ = fs::rename(&main_path, &first_backup);
        }

        // Open a new main log file
        let new_file = OpenOptions::new()
            .create(true)
            .write(true)
            .truncate(true)
            .open(&main_path)?;

        self.current_file = Some(new_file);
        self.current_size = 0;
        Ok(())
    }

    fn write_entry(&mut self, entry: &str) -> Result<(), std::io::Error> {
        let bytes = entry.as_bytes();
        self.rotate_if_needed(bytes.len() as u64)?;

        if let Some(ref mut file) = self.current_file {
            file.write_all(bytes)?;
            file.flush()?;
            self.current_size += bytes.len() as u64;
        }
        Ok(())
    }
}

pub struct RotatingLogger {
    inner: Mutex<RotatingLoggerInner>,
    log_dir: PathBuf,
}

impl RotatingLogger {
    pub fn new(log_dir: PathBuf) -> Result<Self, std::io::Error> {
        let inner = RotatingLoggerInner::new(log_dir.clone())?;
        Ok(Self {
            inner: Mutex::new(inner),
            log_dir,
        })
    }

    pub fn log_directory(&self) -> &Path {
        &self.log_dir
    }
}

impl log::Log for RotatingLogger {
    fn enabled(&self, metadata: &Metadata) -> bool {
        metadata.level() <= Level::Debug
    }

    fn log(&self, record: &Record) {
        if !self.enabled(record.metadata()) {
            return;
        }

        let now = std::time::SystemTime::now();
        let time_str = match now.duration_since(std::time::UNIX_EPOCH) {
            Ok(dur) => {
                let secs = dur.as_secs();
                let millis = dur.subsec_millis();
                format!("{secs}.{millis:03}")
            }
            Err(_) => "0.000".to_string(),
        };

        let formatted = format!(
            "[{time_str}] [{:<5}] [{}] {}\n",
            record.level(),
            record.target(),
            record.args()
        );

        // Output to stderr for console visibility
        eprint!("{formatted}");

        // Append to rotating log file
        if let Ok(mut guard) = self.inner.lock() {
            let _ = guard.write_entry(&formatted);
        }
    }

    fn flush(&self) {
        if let Ok(mut guard) = self.inner.lock() {
            if let Some(ref mut f) = guard.current_file {
                let _ = f.flush();
            }
        }
    }
}

static LOGGER_INITIALIZED: Mutex<bool> = Mutex::new(false);

/// Initializes the global rotating logger writing to the specified or default log directory.
pub fn init_logging(custom_dir: Option<PathBuf>) -> Result<PathBuf, String> {
    let mut init_guard = LOGGER_INITIALIZED.lock().map_err(|e| e.to_string())?;
    let log_dir = custom_dir.unwrap_or_else(get_log_dir);

    if *init_guard {
        return Ok(log_dir);
    }

    let logger = RotatingLogger::new(log_dir.clone())
        .map_err(|e| format!("Failed to create rotating logger: {e}"))?;

    log::set_boxed_logger(Box::new(logger))
        .map_err(|e| format!("Failed to set global logger: {e}"))?;
    log::set_max_level(LevelFilter::Debug);

    *init_guard = true;
    log::info!("Rotating file logger initialized at: {}", log_dir.display());
    Ok(log_dir)
}

/// Opens the OS file manager pointing to the logs directory.
pub fn open_logs_folder() -> Result<(), String> {
    let dir = get_log_dir();
    if !dir.exists() {
        let _ = fs::create_dir_all(&dir);
    }

    #[cfg(target_os = "windows")]
    {
        std::process::Command::new("explorer.exe")
            .arg(dir.as_os_str())
            .spawn()
            .map_err(|e| format!("Failed to open explorer: {e}"))?;
        Ok(())
    }

    #[cfg(target_os = "macos")]
    {
        std::process::Command::new("open")
            .arg(dir.as_os_str())
            .spawn()
            .map_err(|e| format!("Failed to open finder: {e}"))?;
        Ok(())
    }

    #[cfg(target_os = "linux")]
    {
        std::process::Command::new("xdg-open")
            .arg(dir.as_os_str())
            .spawn()
            .map_err(|e| format!("Failed to open file manager: {e}"))?;
        Ok(())
    }

    #[cfg(not(any(target_os = "windows", target_os = "macos", target_os = "linux")))]
    {
        Err("Unsupported operating system for opening file manager".to_string())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_log_directory_resolution() {
        let dir = get_log_dir();
        assert!(!dir.as_os_str().is_empty());
        assert!(dir.to_string_lossy().contains("logs") || dir.to_string_lossy().contains("Logs"));
    }

    #[test]
    fn test_rotating_logger_creation_and_write() {
        let temp_dir =
            std::env::temp_dir().join(format!("volzone_test_log_{}", uuid::Uuid::new_v4()));
        let mut inner =
            RotatingLoggerInner::new(temp_dir.clone()).expect("Failed to create logger inner");

        // Write sample entry
        let sample = "Test log line\n";
        inner
            .write_entry(sample)
            .expect("Failed to write log entry");

        let log_file = temp_dir.join("volume-3.log");
        assert!(log_file.exists());
        let content = fs::read_to_string(&log_file).expect("Failed to read log file");
        assert_eq!(content, sample);

        // Clean up
        let _ = fs::remove_dir_all(&temp_dir);
    }
}
