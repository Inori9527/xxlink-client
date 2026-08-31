use crate::WriterConfig;
use crate::core::ClashConfig;
use crate::core::logger::{get_writer, set_or_update_writer};
use anyhow::{Result, anyhow};
use compact_str::CompactString;
use flexi_logger::writers::LogWriter;
use flexi_logger::{DeferredNow, Record};
use once_cell::sync::Lazy;
use std::process::Stdio;
use std::sync::Arc;
use std::time::{Duration, Instant};
use tokio::io::AsyncBufReadExt;
use tokio::{io::BufReader, process::Command};
use tokio::{process::Child, sync::Mutex, task::JoinHandle};
use tracing::{error, info, warn};
use xxlink_logging::AsyncLogger;

#[derive(Debug)]
pub struct CoreExitInfo {
    pub exit_code: Option<i32>,
    #[cfg(unix)]
    pub signal: Option<i32>,
    pub uptime: Duration,
}

impl CoreExitInfo {
    pub fn diagnosis(&self) -> &'static str {
        #[cfg(unix)]
        {
            if let Some(sig) = self.signal {
                return match sig {
                    9 => "Killed by OOM killer or admin (SIGKILL)",
                    11 => "Segmentation fault (SIGSEGV)",
                    15 => "Graceful shutdown (SIGTERM)",
                    6 => "Aborted (SIGABRT)",
                    _ => "Terminated by signal",
                };
            }
        }
        match self.exit_code {
            Some(0) => "Normal exit",
            Some(_) => "Abnormal exit",
            None => "Unknown exit reason",
        }
    }
}

pub struct ChildGuard {
    child: Option<Child>,
    readers: Vec<JoinHandle<()>>,
}

impl ChildGuard {
    fn inner(&mut self) -> Option<&mut Child> {
        self.child.as_mut()
    }

    fn take(mut self) -> Option<Child> {
        self.child.take()
    }
}

impl Drop for ChildGuard {
    fn drop(&mut self) {
        for reader in self.readers.drain(..) {
            reader.abort();
        }
        if let Some(mut child) = self.child.take() {
            tokio::spawn(async move {
                if let Err(e) = child.kill().await {
                    warn!("Failed to kill child ({:?}): {e}", child.id());
                } else {
                    info!("Successfully killed child ({:?})", child.id());
                }
            });
        } else {
            info!("No running core process found");
        }
    }
}

struct WatchdogConfig {
    max_restarts: u32,
    restart_window: Duration,
    max_backoff: Duration,
}

impl Default for WatchdogConfig {
    fn default() -> Self {
        Self {
            max_restarts: 10,
            restart_window: Duration::from_secs(600),
            max_backoff: Duration::from_secs(30),
        }
    }
}

fn backoff_delay(attempt: u32, max: Duration) -> Duration {
    let base = Duration::from_secs(1u64 << attempt.min(5));
    base.min(max)
}

pub struct CoreManager {
    running_child: Arc<Mutex<Option<ChildGuard>>>,
    running_config: Arc<Mutex<Option<ClashConfig>>>,
    core_start_time: Arc<Mutex<Option<Instant>>>,
    watchdog_handle: Arc<Mutex<Option<JoinHandle<()>>>>,
}

impl CoreManager {
    fn new() -> Self {
        CoreManager {
            running_child: Arc::new(Mutex::new(None)),
            running_config: Arc::new(Mutex::new(None)),
            core_start_time: Arc::new(Mutex::new(None)),
            watchdog_handle: Arc::new(Mutex::new(None)),
        }
    }

    pub async fn start_core(&self, config: ClashConfig) -> Result<()> {
        // The caller names the executable this privileged process will run.
        // It has to: the service is installed separately and does not know
        // where the app lives, so `core_path` arrives in the request body
        // (src-tauri/src/core/service.rs computes it next to the app binary).
        // What must not happen is running it unexamined -- that turned the
        // endpoint into "make SYSTEM execute anything" (2026-08-28 audit).
        validate_core_path(&config.core_config.core_path)?;

        let value = self.running_child.lock().await.take();
        if let Some(child) = value {
            info!("Core is already running, stopping existing instance");
            drop(child);
            LOGGER_MANAGER.clear_logs().await;
        }

        info!("Starting core with config: {:?}", config);

        let args = vec![
            "-d",
            config.core_config.config_dir.as_str(),
            "-f",
            config.core_config.config_path.as_str(),
            if cfg!(windows) {
                "-ext-ctl-pipe"
            } else {
                "-ext-ctl-unix"
            },
            config.core_config.core_ipc_path.as_str(),
        ];

        let child_guard = run_with_logging(&config.core_config.core_path, &args, &config.log_config).await?;

        {
            let mut child_lock = self.running_child.lock().await;
            *child_lock = Some(child_guard);
            *self.core_start_time.lock().await = Some(Instant::now());
        }

        *self.running_config.lock().await = Some(config);

        self.start_watchdog().await;

        Ok(())
    }

    pub async fn stop_core(&self) -> Result<()> {
        info!("Stopping core");
        LOGGER_MANAGER.clear_logs().await;

        self.stop_watchdog().await;

        let child_guard = self.running_child.lock().await.take();
        drop(child_guard);

        *self.core_start_time.lock().await = None;

        let start_clash = self.running_config.lock().await.take();
        if let Some(config) = start_clash {
            info!("Clearing running config: {:?}", config);
        } else {
            info!("No running config to clear");
        }

        self.after_stop().await;

        Ok(())
    }

    async fn start_watchdog(&self) {
        let child_arc = Arc::clone(&self.running_child);
        let config_arc = Arc::clone(&self.running_config);
        let start_time_arc = Arc::clone(&self.core_start_time);
        let watchdog_config = WatchdogConfig::default();

        let handle = tokio::spawn(async move {
            let mut restart_timestamps: Vec<Instant> = Vec::new();
            let mut consecutive_attempt = 0u32;

            loop {
                tokio::time::sleep(Duration::from_secs(3)).await;

                let mut child_lock = child_arc.lock().await;
                let child_opt = child_lock.as_mut();

                if let Some(guard) = child_opt {
                    if let Some(child) = guard.inner() {
                        match child.try_wait() {
                            Ok(Some(status)) => {
                                let uptime = start_time_arc.lock().await.map(|t| t.elapsed()).unwrap_or_default();

                                let exit_info = CoreExitInfo {
                                    exit_code: status.code(),
                                    #[cfg(unix)]
                                    signal: {
                                        #[cfg(unix)]
                                        {
                                            use std::os::unix::process::ExitStatusExt;
                                            status.signal()
                                        }
                                    },
                                    uptime,
                                };

                                error!(
                                    "Core exited unexpectedly — code: {:?}, diagnosis: {}, uptime: {:.1}s",
                                    exit_info.exit_code,
                                    exit_info.diagnosis(),
                                    exit_info.uptime.as_secs_f64()
                                );

                                #[cfg(unix)]
                                if let Some(sig) = exit_info.signal {
                                    error!("Core terminated by signal: {}", sig);
                                }

                                let dead_guard = child_lock.take();
                                if let Some(guard) = dead_guard {
                                    let _ = guard.take();
                                }
                                drop(child_lock);

                                let now = Instant::now();
                                restart_timestamps.retain(|t| now.duration_since(*t) < watchdog_config.restart_window);
                                restart_timestamps.push(now);

                                if restart_timestamps.len() as u32 > watchdog_config.max_restarts {
                                    error!(
                                        "Core restarted {} times in {}s, giving up",
                                        restart_timestamps.len(),
                                        watchdog_config.restart_window.as_secs()
                                    );
                                    break;
                                }

                                let delay = backoff_delay(consecutive_attempt, watchdog_config.max_backoff);
                                info!(
                                    "Restart attempt #{} after {}ms backoff",
                                    consecutive_attempt + 1,
                                    delay.as_millis()
                                );
                                tokio::time::sleep(delay).await;

                                let config_guard = config_arc.lock().await;
                                if let Some(config) = config_guard.as_ref() {
                                    let args = vec![
                                        "-d",
                                        config.core_config.config_dir.as_str(),
                                        "-f",
                                        config.core_config.config_path.as_str(),
                                        if cfg!(windows) {
                                            "-ext-ctl-pipe"
                                        } else {
                                            "-ext-ctl-unix"
                                        },
                                        config.core_config.core_ipc_path.as_str(),
                                    ];

                                    match run_with_logging(&config.core_config.core_path, &args, &config.log_config)
                                        .await
                                    {
                                        Ok(new_guard) => {
                                            let mut lock = child_arc.lock().await;
                                            *lock = Some(new_guard);
                                            *start_time_arc.lock().await = Some(Instant::now());
                                            consecutive_attempt += 1;
                                            info!("Core restarted successfully (attempt #{})", consecutive_attempt);
                                        }
                                        Err(e) => {
                                            error!("Failed to restart core: {}", e);
                                            consecutive_attempt += 1;
                                        }
                                    }
                                } else {
                                    warn!("No saved config for restart, watchdog stopping");
                                    break;
                                }
                            }
                            Ok(None) => {
                                consecutive_attempt = 0;
                            }
                            Err(e) => {
                                warn!("Failed to check child process status: {}", e);
                            }
                        }
                    }
                } else {
                    break;
                }
            }
        });

        *self.watchdog_handle.lock().await = Some(handle);
    }

    async fn stop_watchdog(&self) {
        if let Some(handle) = self.watchdog_handle.lock().await.take() {
            handle.abort();
            info!("Watchdog stopped");
        }
    }

    pub async fn after_stop(&self) {
        #[cfg(unix)]
        {
            use std::path::Path;
            use tokio::fs;

            let target = Path::new("/tmp/xxlink/xxlink-mihomo.sock");
            info!("Removing socket file {:?}", target);
            if !target.exists() {
                info!("{:?} does not exist, no need to remove", target);
                return;
            }
            match fs::remove_file(target).await {
                Ok(_) => info!("Successfully removed {:?}", target),
                Err(e) => warn!("Failed to remove {:?}: {}", target, e),
            }
        }
        LOGGER_MANAGER.clear_logs().await;
    }
}

pub async fn run_with_logging(bin_path: &str, args: &Vec<&str>, writer_config: &WriterConfig) -> Result<ChildGuard> {
    set_or_update_writer(writer_config).await?;

    #[cfg(not(unix))]
    let child = Command::new(bin_path)
        .args(args)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()?;

    #[cfg(unix)]
    let child = unsafe {
        Command::new(bin_path)
            .args(args)
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .pre_exec(|| {
                // Sole authority for the mode of the core's -ext-ctl-unix
                // control socket. The core creates that socket itself, so the
                // only way to keep `other` off it is to deny those bits here,
                // before exec. after_start() used to chmod it back to 0o777
                // two hundred milliseconds later -- handing every local
                // account full control of a root-owned RESTful control API --
                // which is why that hook is gone rather than narrowed.
                platform_lib::umask(0o007);
                Ok(())
            })
            .spawn()?
    };

    let mut child_guard = ChildGuard {
        child: Some(child),
        readers: Vec::new(),
    };

    let (Some(stdout), Some(stderr)) = (
        child_guard.inner().and_then(|c| c.stdout.take()),
        child_guard.inner().and_then(|c| c.stderr.take()),
    ) else {
        return Err(anyhow!("Failed to capture child output"));
    };

    let stdout_handle = tokio::spawn(async move {
        let mut stdout_reader = BufReader::new(stdout).lines();
        while let Ok(Some(line)) = stdout_reader.next_line().await {
            let message = CompactString::from(line.as_str());
            {
                if let Some(shared_writer) = get_writer() {
                    let w = shared_writer.lock().await;
                    let mut now = DeferredNow::default();
                    let arg = format_args!("{}", line);
                    let record = Record::builder()
                        .args(arg)
                        .level(log::Level::Info)
                        .target("service")
                        .build();
                    let _ = w.write(&mut now, &record);
                }
            }
            LOGGER_MANAGER.append_log(message).await;
        }
    });

    let stderr_handle = tokio::spawn(async move {
        let mut stderr_reader = BufReader::new(stderr).lines();
        while let Ok(Some(line)) = stderr_reader.next_line().await {
            let message = CompactString::from(line.as_str());
            {
                if let Some(shared_writer) = get_writer() {
                    let w = shared_writer.lock().await;
                    let mut now = DeferredNow::default();
                    let arg = format_args!("{}", line);
                    let record = Record::builder()
                        .args(arg)
                        .level(log::Level::Error)
                        .target("service")
                        .build();
                    let _ = w.write(&mut now, &record);
                }
            }
            LOGGER_MANAGER.append_log(message).await;
        }
    });

    child_guard.readers.push(stdout_handle);
    child_guard.readers.push(stderr_handle);

    Ok(child_guard)
}

/// Executable names this service will launch. The app ships one proxy core;
/// the historical names are accepted so an older installation still starts.
pub(crate) const ALLOWED_CORE_FILE_STEMS: &[&str] = &["xxlink-mihomo", "mihomo", "mihomo-alpha", "verge-mihomo"];

/// Decide whether a caller-supplied executable may be run by this privileged
/// process. Rejection is the default: every branch that cannot establish the
/// path is safe returns an error rather than falling through to a launch.
pub(crate) fn validate_core_path(core_path: &str) -> Result<()> {
    use std::path::Path;

    let path = Path::new(core_path);

    if !path.is_absolute() {
        return Err(anyhow!("core path must be absolute: {core_path}"));
    }

    let stem = path
        .file_stem()
        .and_then(|s| s.to_str())
        .ok_or_else(|| anyhow!("core path has no file name: {core_path}"))?;
    if !ALLOWED_CORE_FILE_STEMS.contains(&stem) {
        return Err(anyhow!("core executable is not allow-listed: {stem}"));
    }

    #[cfg(windows)]
    if path.extension().and_then(|e| e.to_str()) != Some("exe") {
        return Err(anyhow!("core executable must be .exe on windows: {core_path}"));
    }

    let meta =
        std::fs::symlink_metadata(path).map_err(|err| anyhow!("core path is not readable: {core_path}: {err}"))?;
    if meta.file_type().is_symlink() {
        return Err(anyhow!("core path is a symlink: {core_path}"));
    }
    if !meta.is_file() {
        return Err(anyhow!("core path is not a regular file: {core_path}"));
    }

    // A binary an unprivileged account can replace is the same escalation by a
    // slower route, so the directory holding it must not be group- or
    // world-writable. Windows has no mode bits; there the equivalent check
    // needs the security APIs this crate does not depend on, and its absence
    // is why the allow-list above is not the only guard on that platform.
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let parent = path
            .parent()
            .ok_or_else(|| anyhow!("core path has no parent directory: {core_path}"))?;
        let parent_meta =
            std::fs::metadata(parent).map_err(|err| anyhow!("core directory is not readable: {parent:?}: {err}"))?;
        let mode = parent_meta.permissions().mode();
        if mode & 0o022 != 0 {
            return Err(anyhow!(
                "core directory {parent:?} is writable by group or other (mode {mode:o})"
            ));
        }
    }

    Ok(())
}

pub static CORE_MANAGER: Lazy<Arc<Mutex<CoreManager>>> = Lazy::new(|| Arc::new(Mutex::new(CoreManager::new())));

pub static LOGGER_MANAGER: Lazy<Arc<AsyncLogger>> = Lazy::new(|| Arc::new(AsyncLogger::new()));

#[cfg(test)]
mod runtime_boundary_tests {
    use super::*;
    use std::io::Write;

    // The name of this module is load-bearing: the client CI runs
    // `cargo test --workspace --all-features --lib runtime_boundary_tests`,
    // so a test outside it -- including anything under tests/ -- never runs.

    fn temp_core(stem: &str, ext: &str) -> (tempdirs::Guard, std::path::PathBuf) {
        let guard = tempdirs::Guard::new();
        let path = guard.path().join(format!("{stem}{ext}"));
        let mut f = std::fs::File::create(&path).expect("create fake core");
        f.write_all(b"not a real binary").expect("write fake core");
        (guard, path)
    }

    #[cfg(windows)]
    const EXT: &str = ".exe";
    #[cfg(not(windows))]
    const EXT: &str = "";

    #[test]
    fn allow_listed_core_in_place_is_accepted() {
        let (_g, path) = temp_core("xxlink-mihomo", EXT);
        // On unix the temp directory must not be group/other writable for the
        // parent-directory rule; Guard creates it 0o700.
        assert!(
            validate_core_path(path.to_str().unwrap()).is_ok(),
            "the installed core must still start"
        );
    }

    #[test]
    fn arbitrary_executable_is_rejected() {
        let (_g, path) = temp_core("payload", EXT);
        let err = validate_core_path(path.to_str().unwrap())
            .expect_err("a non-allow-listed executable must not be run as SYSTEM/root");
        assert!(
            err.to_string().contains("not allow-listed"),
            "unexpected rejection reason: {err}"
        );
    }

    #[test]
    fn relative_path_is_rejected() {
        let err = validate_core_path("xxlink-mihomo")
            .expect_err("a relative path must not be resolved against the service's cwd");
        assert!(err.to_string().contains("absolute"), "unexpected reason: {err}");
    }

    #[test]
    fn missing_file_is_rejected_not_ignored() {
        let guard = tempdirs::Guard::new();
        let path = guard.path().join(format!("xxlink-mihomo{EXT}"));
        let err = validate_core_path(path.to_str().unwrap()).expect_err("a path that does not exist must fail closed");
        assert!(err.to_string().contains("not readable"), "unexpected reason: {err}");
    }

    /// The endpoint's access control is the boundary; this pins what it grants.
    #[test]
    fn endpoint_permissions_exclude_everyone() {
        #[cfg(windows)]
        {
            let sd = crate::core::server::IPC_PIPE_SECURITY_DESCRIPTOR;
            for wide in [";WD)", ";AU)", ";AN)", ";WD;", ";AU;"] {
                assert!(!sd.contains(wide), "security descriptor must not admit {wide}: {sd}");
            }
            assert!(sd.contains("(A;;GA;;;SY)"), "SYSTEM must keep full control: {sd}");
            assert!(sd.starts_with("D:P"), "inherited ACEs must be blocked: {sd}");
        }
        #[cfg(unix)]
        {
            let mode = crate::core::server::IPC_SOCKET_MODE;
            assert_eq!(
                mode & 0o007,
                0,
                "socket must not be accessible to other (mode {mode:o})"
            );
            assert_eq!(mode, 0o660, "socket mode must be exactly 0o660");
        }
    }

    mod tempdirs {
        use std::path::{Path, PathBuf};
        use std::sync::atomic::{AtomicU64, Ordering};

        static N: AtomicU64 = AtomicU64::new(0);

        pub struct Guard(PathBuf);

        impl Guard {
            pub fn new() -> Self {
                let n = N.fetch_add(1, Ordering::Relaxed);
                let dir = std::env::temp_dir().join(format!("xxlink-ipc-boundary-{}-{n}", std::process::id()));
                std::fs::create_dir_all(&dir).expect("create temp dir");
                #[cfg(unix)]
                {
                    use std::os::unix::fs::PermissionsExt;
                    std::fs::set_permissions(&dir, std::fs::Permissions::from_mode(0o700)).expect("tighten temp dir");
                }
                Guard(dir)
            }
            pub fn path(&self) -> &Path {
                &self.0
            }
        }

        impl Drop for Guard {
            fn drop(&mut self) {
                let _ = std::fs::remove_dir_all(&self.0);
            }
        }
    }

    // Strip comment lines before matching. These tests read the very files
    // they guard, so a needle written literally in an assertion -- or merely
    // mentioned in a comment explaining the old defect -- would match itself
    // and report a regression that is not there. Needles are also assembled
    // with concat! for the same reason.
    fn code_only(source: &str) -> String {
        source
            .lines()
            .filter(|l| !l.trim_start().starts_with("//"))
            .collect::<Vec<_>>()
            .join(
                "
",
            )
    }

    // The mihomo core's -ext-ctl-unix control socket is a root-owned RESTful
    // API. It is created by the core itself, so the only lever on its mode is
    // the umask set before exec. after_start() used to chmod it to 0o777 two
    // hundred milliseconds after every start_core, handing that API to every
    // local account -- unconditionally, no race to win and nothing to
    // pre-plant. Asserted on the source rather than a live socket because this
    // crate's CI runners cannot observe one: a Windows runner never compiles
    // the path, so an observation-based test would pass without looking.
    #[test]
    fn core_socket_is_not_widened_after_start() {
        let source = code_only(include_str!("manager.rs"));

        assert!(
            !source.contains(concat!("pub async fn ", "after_start")),
            "after_start is back; it existed only to widen the core control socket"
        );
        assert!(
            !source.contains(concat!("self.", "after_start().await")),
            "after_start is being called again"
        );
        // Catch a reintroduction under any other name: no chmod in this file
        // may set a mode carrying `other` bits.
        for bad in ["0o777", "0o666", "0o707", "0o776"] {
            for line in source.lines() {
                assert!(
                    !(line.contains("from_mode") && line.contains(bad)),
                    "a chmod grants `other` bits ({bad}): {line}"
                );
            }
        }
        assert!(
            source.contains("platform_lib::umask(0o007)"),
            "the umask before exec is the only thing keeping `other` off the core socket"
        );
    }

    // The IPC directory used to be adopted whatever its owner: the guards asked
    // what it was, never whose it was, and the chown passes uid_t::MAX, POSIX's
    // "leave the owner alone" sentinel. An unprivileged user who created
    // /tmp/xxlink first therefore kept it, and -- exercised on Ubuntu 24.04
    // with a second unprivileged user refused the same steps as a control --
    // could unlink the root-owned socket inside it and remove the directory
    // even under a sticky 1777 /tmp, because sticky exempts the entry's owner.
    #[test]
    fn ipc_directory_is_refused_when_not_ours() {
        let source = code_only(include_str!("server.rs"));

        // Every binding of `expected` must come from geteuid, not just one of
        // them. There are two comparison sites -- the adopt path and the
        // re-check after the non-exclusive create -- and an earlier version of
        // this assertion only required the string to appear somewhere in the
        // file, so neutering either site alone still passed. Mutation testing
        // caught that; this form catches it.
        let bindings: Vec<&str> = source.lines().filter(|l| l.contains("let expected")).collect();
        assert!(
            bindings.len() >= 2,
            "expected an owner comparison at both the adopt and post-create paths, found {}",
            bindings.len()
        );
        for line in &bindings {
            assert!(
                line.contains("geteuid()"),
                "an owner comparison is not against our euid: {line}"
            );
        }
        assert!(
            source.contains("owned by uid {owner}, expected {expected}"),
            "the ownership refusal is gone from make_ipc_dir"
        );
        assert!(
            source.contains("lost the create race"),
            "create_dir_all is not exclusive; the post-create owner re-check must stay"
        );

        // The watchdog must recreate through make_ipc_dir. Doing it inline is
        // how it skipped the symlink refusal and left the directory 0o777.
        let watchdog = source
            .split(concat!("pub fn ", "spawn_socket_dir_watchdog"))
            .nth(1)
            .expect("watchdog missing");
        let watchdog = watchdog
            .split(
                "
async fn ",
            )
            .next()
            .unwrap_or(watchdog);
        assert!(
            watchdog.contains("make_ipc_dir().await"),
            "the watchdog recreates the directory itself instead of via make_ipc_dir"
        );
        assert!(
            !watchdog.contains("create_dir_all"),
            "the watchdog still creates the directory inline"
        );
    }
}
