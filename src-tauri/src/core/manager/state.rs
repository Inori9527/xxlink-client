use super::{CoreManager, RunningMode};
use crate::{
    AsyncHandler,
    config::{Config, IClashTemp},
    core::{handle, logger::Logger, manager::CLASH_LOGGER, service},
    logging,
    utils::{arch_check, dirs},
};
use anyhow::{Result, anyhow};
use xxlink_logging::Type;
use compact_str::CompactString;
use log::Level;
use scopeguard::defer;
use tauri_plugin_shell::ShellExt as _;

impl CoreManager {
    pub async fn get_clash_logs(&self) -> Result<Vec<CompactString>> {
        match *self.get_running_mode() {
            RunningMode::Service => service::get_clash_logs_by_service().await,
            RunningMode::Sidecar => Ok(CLASH_LOGGER.get_logs().await),
            RunningMode::NotRunning => Ok(Vec::new()),
        }
    }

    pub(super) async fn start_core_by_sidecar(&self) -> Result<()> {
        logging!(info, Type::Core, "Starting core in sidecar mode");

        let config_file = Config::generate_file(crate::config::ConfigType::Run).await?;
        let app_handle = handle::Handle::app_handle();
        let clash_core = Config::verge().await.latest_arc().get_valid_clash_core();
        let config_dir = dirs::app_home_dir()?;

        // Pre-flight: if the bundled sidecar was built for a different CPU
        // architecture than this process, Windows will refuse to launch it
        // with OS error 216 and pop a modal dialog. Catch it upfront and
        // surface an actionable notice so the user knows to reinstall.
        if let Ok(Some(report)) = arch_check::check_sidecar_arch(clash_core.as_str()) {
            let msg = report.human_message();
            logging!(error, Type::Core, "{}", msg);
            handle::Handle::notice_message("config_validate::core_arch_mismatch", msg.clone());
            return Err(anyhow!(msg));
        }

        #[cfg(unix)]
        let previous_mask = unsafe { tauri_plugin_xxlink_sysinfo::libc::umask(0o007) };
        let spawn_result = app_handle
            .shell()
            .sidecar(clash_core.as_str())?
            .args([
                "-d",
                dirs::path_to_str(&config_dir)?,
                "-f",
                dirs::path_to_str(&config_file)?,
                if cfg!(windows) {
                    "-ext-ctl-pipe"
                } else {
                    "-ext-ctl-unix"
                },
                &IClashTemp::guard_external_controller_ipc(),
            ])
            .spawn();
        #[cfg(unix)]
        unsafe {
            tauri_plugin_xxlink_sysinfo::libc::umask(previous_mask)
        };
        let (mut rx, child) = match spawn_result {
            Ok(ok) => ok,
            Err(err) => {
                let rendered = err.to_string();
                // Backstop for arch mismatch if the pre-flight check above
                // was bypassed (path didn't resolve, race with installer,
                // etc).
                if rendered.contains("os error 216") {
                    logging!(error, Type::Core, "Sidecar 启动失败（架构不匹配）: {}", rendered);
                    handle::Handle::notice_message("config_validate::core_arch_mismatch", rendered);
                } else {
                    // Any other spawn failure reaches UI as a boot_error
                    // notice so the user isn't left with "暂无可用节点" and
                    // no explanation — this was the silent-failure path
                    // for the 1.0.2 incident.
                    logging!(error, Type::Core, "Sidecar spawn 失败: {}", rendered);
                    handle::Handle::notice_message("config_validate::boot_error", rendered);
                }
                return Err(err.into());
            }
        };

        let pid = child.pid();
        logging!(trace, Type::Core, "Sidecar started with PID: {}", pid);

        self.set_running_child_sidecar(child);
        self.set_running_mode(RunningMode::Sidecar);

        AsyncHandler::spawn(|| async move {
            while let Some(event) = rx.recv().await {
                match event {
                    tauri_plugin_shell::process::CommandEvent::Stdout(line)
                    | tauri_plugin_shell::process::CommandEvent::Stderr(line) => {
                        let message = CompactString::from(&*String::from_utf8_lossy(&line));
                        Logger::global().writer_sidecar_log(Level::Error, &message);
                        CLASH_LOGGER.append_log(message).await;
                    }
                    tauri_plugin_shell::process::CommandEvent::Terminated(term) => {
                        let message = if let Some(code) = term.code {
                            CompactString::from(format!("Process terminated with code: {}", code))
                        } else if let Some(signal) = term.signal {
                            CompactString::from(format!("Process terminated by signal: {}", signal))
                        } else {
                            CompactString::from("Process terminated")
                        };
                        Logger::global().writer_sidecar_log(Level::Info, &message);
                        CLASH_LOGGER.clear_logs().await;
                        break;
                    }
                    _ => {}
                }
            }
        });

        Ok(())
    }

    pub(super) fn stop_core_by_sidecar(&self) {
        logging!(info, Type::Core, "Stopping sidecar");
        defer! {
            self.set_running_mode(RunningMode::NotRunning);
        }
        if let Some(child) = self.take_child_sidecar() {
            let pid = child.pid();
            let result = child.kill();
            logging!(
                trace,
                Type::Core,
                "Sidecar stopped (PID: {:?}, Result: {:?})",
                pid,
                result
            );
        }
    }

    pub(super) async fn start_core_by_service(&self) -> Result<()> {
        logging!(info, Type::Core, "Starting core in service mode");
        let config_file = Config::generate_file(crate::config::ConfigType::Run).await?;
        service::run_core_by_service(&config_file).await?;
        self.set_running_mode(RunningMode::Service);
        Ok(())
    }

    pub(super) async fn stop_core_by_service(&self) -> Result<()> {
        logging!(info, Type::Core, "Stopping service");
        defer! {
            self.set_running_mode(RunningMode::NotRunning);
        }
        service::stop_core_by_service().await?;
        Ok(())
    }
}
