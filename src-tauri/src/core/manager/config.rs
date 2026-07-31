use super::CoreManager;
use crate::{
    config::{Config, ConfigType, runtime::IRuntime},
    constants::timing,
    core::{handle, validate::CoreConfigValidator},
    utils::{dirs, help},
};
use anyhow::{Result, anyhow};
use smartstring::alias::String;
use std::{collections::HashSet, path::PathBuf, time::Instant};
use tauri_plugin_mihomo::Error as MihomoError;
use tokio::{
    sync::{Mutex, MutexGuard},
    time::{Duration, timeout},
};
use xxlink_logging::{Type, logging};

const CORE_RELOAD_TIMEOUT: Duration = Duration::from_secs(8);
const CORE_RESTART_TIMEOUT: Duration = Duration::from_secs(12);
static CONFIG_TRANSACTION_LOCK: Mutex<()> = Mutex::const_new(());

impl CoreManager {
    pub async fn use_default_config(&self, error_key: &str, error_msg: &str) -> Result<()> {
        use crate::constants::files::RUNTIME_CONFIG;

        let runtime_path = dirs::app_home_dir()?.join(RUNTIME_CONFIG);
        let clash_config = &Config::clash().await.latest_arc().0;

        Config::runtime().await.edit_draft(|d| {
            *d = IRuntime {
                config: Some(clash_config.to_owned()),
                exists_keys: HashSet::new(),
                chain_logs: Default::default(),
            }
        });

        help::save_yaml(&runtime_path, &clash_config, Some("# XXLink Runtime")).await?;
        handle::Handle::notice_message(error_key, error_msg);
        Ok(())
    }

    pub async fn update_config(&self) -> Result<(bool, String)> {
        let _transaction_guard = Self::begin_config_transaction().await;
        if !self.should_update_config() {
            return Ok((true, String::new()));
        }
        self.force_update_config_in_transaction().await
    }

    pub(crate) async fn begin_config_transaction() -> MutexGuard<'static, ()> {
        CONFIG_TRANSACTION_LOCK.lock().await
    }

    pub(crate) async fn force_update_config_in_transaction(&self) -> Result<(bool, String)> {
        if handle::Handle::global().is_exiting() {
            return Ok((true, String::new()));
        }

        self.perform_config_update_in_transaction().await
    }

    fn should_update_config(&self) -> bool {
        let now = Instant::now();
        let last = self.get_last_update();

        if let Some(last_time) = last
            && now.duration_since(*last_time) < timing::CONFIG_UPDATE_DEBOUNCE
        {
            return false;
        }

        self.set_last_update(now);
        true
    }

    async fn perform_config_update_in_transaction(&self) -> Result<(bool, String)> {
        Config::generate().await?;
        self.apply_generate_config_in_transaction().await
    }

    pub(crate) async fn apply_generate_config_in_transaction(&self) -> Result<(bool, String)> {
        match CoreConfigValidator::global().validate_config().await {
            Ok((true, _)) => {
                let run_path = Config::generate_file(ConfigType::Run).await?;
                self.apply_config(run_path).await?;
                Ok((true, String::new()))
            }
            Ok((false, error_msg)) => {
                Config::runtime().await.discard();
                Ok((false, error_msg))
            }
            Err(e) => {
                Config::runtime().await.discard();
                Err(e)
            }
        }
    }

    async fn apply_config(&self, path: PathBuf) -> Result<()> {
        let path = dirs::path_to_str(&path)?;
        let reload_result = timeout(CORE_RELOAD_TIMEOUT, self.reload_config(path)).await;
        match reload_result {
            Ok(Ok(_)) => {
                Config::runtime().await.apply();
                logging!(info, Type::Core, "Configuration applied");
                Ok(())
            }
            Ok(Err(err)) => {
                logging!(
                    warn,
                    Type::Core,
                    "Failed to apply configuration by mihomo api, restart core to apply it, error msg: {err}"
                );
                self.apply_config_by_restart().await
            }
            Err(_) => {
                logging!(
                    warn,
                    Type::Core,
                    "Applying configuration by mihomo api timed out, restart core to apply it"
                );
                self.apply_config_by_restart().await
            }
        }
    }

    async fn apply_config_by_restart(&self) -> Result<()> {
        match timeout(CORE_RESTART_TIMEOUT, self.restart_core()).await {
            Ok(Ok(_)) => {
                Config::runtime().await.apply();
                logging!(info, Type::Core, "Configuration applied after restart");
                Ok(())
            }
            Ok(Err(err)) => {
                logging!(error, Type::Core, "Failed to restart core: {}", err);
                Config::runtime().await.discard();
                Err(anyhow!("Failed to apply config: {}", err))
            }
            Err(_) => {
                logging!(error, Type::Core, "Restarting core timed out");
                Config::runtime().await.discard();
                Err(anyhow!("Failed to apply config: core restart timed out"))
            }
        }
    }

    async fn reload_config(&self, path: &str) -> Result<(), MihomoError> {
        handle::Handle::mihomo().await.reload_config(true, path).await
    }
}
