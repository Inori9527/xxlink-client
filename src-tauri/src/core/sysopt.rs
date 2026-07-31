use crate::{
    config::{Config, IVerge},
    singleton,
};
use anyhow::{Result, anyhow};
use parking_lot::RwLock;
use scopeguard::defer;
#[cfg(target_os = "windows")]
use serde::{Deserialize, Serialize};
use smartstring::alias::String;
use std::{
    net::IpAddr,
    str::FromStr as _,
    sync::{
        Arc,
        atomic::{AtomicBool, Ordering},
    },
    time::Duration,
};
use sysproxy::{Autoproxy, GuardMonitor, GuardType, Sysproxy};
use tokio::sync::Mutex as TokioMutex;
use xxlink_logging::{Type, logging};

const MAX_PROXY_HOST_BYTES: usize = 255;

pub(crate) fn normalize_proxy_host(value: &str) -> Option<String> {
    if value.is_empty()
        || value.len() > MAX_PROXY_HOST_BYTES
        || value
            .chars()
            .any(|character| character.is_control() || character.is_whitespace())
    {
        return None;
    }

    if value.starts_with('[') || value.ends_with(']') {
        let inner = value.strip_prefix('[')?.strip_suffix(']')?;
        return match IpAddr::from_str(inner).ok()? {
            IpAddr::V6(address) => Some(format!("[{address}]").into()),
            IpAddr::V4(_) => None,
        };
    }

    if let Ok(address) = IpAddr::from_str(value) {
        return Some(match address {
            IpAddr::V4(address) => address.to_string().into(),
            IpAddr::V6(address) => format!("[{address}]").into(),
        });
    }

    if value.contains(':')
        || value.starts_with('.')
        || value.ends_with('.')
        || (value.contains('.') && value.bytes().all(|byte| byte.is_ascii_digit() || byte == b'.'))
    {
        return None;
    }

    let labels_are_valid = value.split('.').all(|label| {
        !label.is_empty()
            && label.len() <= 63
            && label.bytes().all(|byte| byte.is_ascii_alphanumeric() || byte == b'-')
            && !label.starts_with('-')
            && !label.ends_with('-')
    });
    labels_are_valid.then(|| value.to_ascii_lowercase().into())
}

#[cfg(target_os = "windows")]
const WINDOWS_PROXY_RECOVERY_KEY: &str = r"Software\XXLink\ProxyRecovery";
#[cfg(target_os = "windows")]
const WINDOWS_PROXY_RECOVERY_VALUE: &str = "StateV1";
#[cfg(target_os = "windows")]
const WINDOWS_PROXY_RECOVERY_VERSION: u8 = 1;

#[cfg(target_os = "windows")]
#[derive(Debug, Clone, PartialEq, Eq, Deserialize, Serialize)]
struct WindowsProxySnapshot {
    proxy_enable: Option<u32>,
    proxy_server: Option<std::string::String>,
    proxy_override: Option<std::string::String>,
    auto_config_url: Option<std::string::String>,
}

#[cfg(target_os = "windows")]
#[derive(Debug, Clone, Deserialize, Serialize)]
struct WindowsProxyRecoveryRecord {
    version: u8,
    previous: WindowsProxySnapshot,
    owned: Option<WindowsProxySnapshot>,
    pending: Option<WindowsProxySnapshot>,
    #[serde(default)]
    mutation_start: Option<WindowsProxySnapshot>,
    #[serde(default)]
    rollback_target: Option<WindowsProxySnapshot>,
    #[serde(default)]
    rollback_retain_ownership: bool,
}

#[cfg(target_os = "windows")]
const fn win_registry_disabled_snapshot() -> WindowsProxySnapshot {
    WindowsProxySnapshot {
        proxy_enable: Some(0),
        proxy_server: None,
        proxy_override: None,
        auto_config_url: None,
    }
}

#[cfg(target_os = "windows")]
fn win_registry_initial_previous_snapshot(
    current: &WindowsProxySnapshot,
    expected: &WindowsProxySnapshot,
) -> WindowsProxySnapshot {
    if current == expected {
        win_registry_disabled_snapshot()
    } else {
        current.clone()
    }
}

#[cfg(target_os = "windows")]
fn win_registry_record_owns_current(record: &WindowsProxyRecoveryRecord, current: &WindowsProxySnapshot) -> bool {
    if record.owned.as_ref() == Some(current) || record.pending.as_ref() == Some(current) {
        return true;
    }

    let Some(pending) = record.pending.as_ref() else {
        return false;
    };
    let mutation_start = record
        .mutation_start
        .as_ref()
        .or(record.owned.as_ref())
        .unwrap_or(&record.previous);
    if mutation_start == current {
        return true;
    }
    win_registry_snapshot_is_transition(current, mutation_start, pending)
}

#[cfg(target_os = "windows")]
fn win_registry_snapshot_is_transition(
    current: &WindowsProxySnapshot,
    start: &WindowsProxySnapshot,
    expected: &WindowsProxySnapshot,
) -> bool {
    current != start
        && (current.proxy_enable == start.proxy_enable || current.proxy_enable == expected.proxy_enable)
        && (current.proxy_server == start.proxy_server || current.proxy_server == expected.proxy_server)
        && (current.proxy_override == start.proxy_override || current.proxy_override == expected.proxy_override)
        && (current.auto_config_url == start.auto_config_url || current.auto_config_url == expected.auto_config_url)
}

#[cfg(target_os = "windows")]
fn win_registry_abort_target(record: &WindowsProxyRecoveryRecord) -> (WindowsProxySnapshot, bool) {
    if let Some(target) = record.rollback_target.as_ref() {
        return (target.clone(), record.rollback_retain_ownership);
    }
    let target = record
        .mutation_start
        .clone()
        .or_else(|| record.owned.clone())
        .unwrap_or_else(|| record.previous.clone());
    let retain_ownership = record.owned.as_ref() == Some(&target) && target != record.previous;
    (target, retain_ownership)
}

#[cfg(target_os = "windows")]
enum WindowsProxyMutationPreparation {
    ReconcileInterrupted,
    Ready(Box<WindowsProxyRecoveryRecord>),
}

#[cfg(target_os = "windows")]
fn win_registry_prepare_proxy_mutation_record(
    existing: Option<WindowsProxyRecoveryRecord>,
    current: &WindowsProxySnapshot,
    expected: WindowsProxySnapshot,
) -> Result<WindowsProxyMutationPreparation> {
    let Some(mut record) = existing else {
        return Ok(WindowsProxyMutationPreparation::Ready(Box::new(
            WindowsProxyRecoveryRecord {
                version: WINDOWS_PROXY_RECOVERY_VERSION,
                previous: win_registry_initial_previous_snapshot(current, &expected),
                owned: None,
                pending: Some(expected),
                mutation_start: Some(current.clone()),
                rollback_target: None,
                rollback_retain_ownership: false,
            },
        )));
    };

    if record.rollback_target.is_some() {
        if !win_registry_record_owns_current(&record, current) {
            return Err(anyhow!("Windows proxy rollback state is no longer owned by XXLink"));
        }
        return Ok(WindowsProxyMutationPreparation::ReconcileInterrupted);
    }

    let state_is_owned = record.owned.as_ref() == Some(current);
    let pending_completed = record.pending.as_ref() == Some(current);
    let state_is_unchanged = record.previous == *current;
    let state_is_transition = win_registry_record_owns_current(&record, current);
    if !state_is_owned && !pending_completed && !state_is_unchanged && !state_is_transition {
        return Err(anyhow!("Windows proxy settings are no longer owned by XXLink"));
    }
    if state_is_transition && !state_is_owned && !pending_completed && !state_is_unchanged {
        return Ok(WindowsProxyMutationPreparation::ReconcileInterrupted);
    }
    if pending_completed {
        record.owned = Some(current.clone());
    }
    record.mutation_start = Some(current.clone());
    record.pending = Some(expected);
    record.rollback_target = None;
    record.rollback_retain_ownership = false;
    Ok(WindowsProxyMutationPreparation::Ready(Box::new(record)))
}

#[cfg(target_os = "windows")]
fn win_registry_open_internet_settings() -> Result<winreg::RegKey> {
    use winreg::RegKey;
    use winreg::enums::HKEY_CURRENT_USER;

    let hkcu = RegKey::predef(HKEY_CURRENT_USER);
    let (key, _) = hkcu.create_subkey("Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings")?;
    Ok(key)
}

#[cfg(target_os = "windows")]
fn win_registry_read_proxy_snapshot() -> Result<WindowsProxySnapshot> {
    let key = win_registry_open_internet_settings()?;

    Ok(WindowsProxySnapshot {
        proxy_enable: win_registry_read_optional_value(&key, "ProxyEnable")?,
        proxy_server: win_registry_read_optional_value(&key, "ProxyServer")?,
        proxy_override: win_registry_read_optional_value(&key, "ProxyOverride")?,
        auto_config_url: win_registry_read_optional_value(&key, "AutoConfigURL")?,
    })
}

#[cfg(target_os = "windows")]
fn win_registry_read_optional_value<T: winreg::types::FromRegValue>(
    key: &winreg::RegKey,
    name: &str,
) -> Result<Option<T>> {
    match key.get_value(name) {
        Ok(value) => Ok(Some(value)),
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(err) => Err(err.into()),
    }
}

#[cfg(target_os = "windows")]
fn win_registry_delete_value_if_missing(
    key: &winreg::RegKey,
    name: &str,
    value: &Option<std::string::String>,
) -> Result<()> {
    if value.is_none() {
        match key.delete_value(name) {
            Ok(_) => {}
            Err(err) if err.kind() == std::io::ErrorKind::NotFound => {}
            Err(err) => return Err(err.into()),
        }
    }
    Ok(())
}

#[cfg(target_os = "windows")]
fn win_registry_restore_proxy_snapshot(snapshot: WindowsProxySnapshot) -> Result<()> {
    let key = win_registry_open_internet_settings()?;

    if let Some(value) = snapshot.proxy_enable {
        key.set_value("ProxyEnable", &value)?;
    } else {
        match key.delete_value("ProxyEnable") {
            Ok(_) => {}
            Err(err) if err.kind() == std::io::ErrorKind::NotFound => {}
            Err(err) => return Err(err.into()),
        }
    }

    if let Some(value) = &snapshot.proxy_server {
        key.set_value("ProxyServer", value)?;
    }
    win_registry_delete_value_if_missing(&key, "ProxyServer", &snapshot.proxy_server)?;

    if let Some(value) = &snapshot.proxy_override {
        key.set_value("ProxyOverride", value)?;
    }
    win_registry_delete_value_if_missing(&key, "ProxyOverride", &snapshot.proxy_override)?;

    if let Some(value) = &snapshot.auto_config_url {
        key.set_value("AutoConfigURL", value)?;
    }
    win_registry_delete_value_if_missing(&key, "AutoConfigURL", &snapshot.auto_config_url)?;

    win_registry_refresh()?;
    Ok(())
}

#[cfg(target_os = "windows")]
fn win_registry_read_recovery_record() -> Result<Option<WindowsProxyRecoveryRecord>> {
    use winreg::{
        RegKey,
        enums::{HKEY_CURRENT_USER, KEY_READ},
    };

    let hkcu = RegKey::predef(HKEY_CURRENT_USER);
    let key = match hkcu.open_subkey_with_flags(WINDOWS_PROXY_RECOVERY_KEY, KEY_READ) {
        Ok(key) => key,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(error.into()),
    };
    let Some(serialized): Option<std::string::String> =
        win_registry_read_optional_value(&key, WINDOWS_PROXY_RECOVERY_VALUE)?
    else {
        return Ok(None);
    };
    let record: WindowsProxyRecoveryRecord = serde_json::from_str(&serialized)?;
    if record.version != WINDOWS_PROXY_RECOVERY_VERSION {
        return Err(anyhow!("unsupported Windows proxy recovery state"));
    }
    Ok(Some(record))
}

#[cfg(target_os = "windows")]
fn win_registry_write_recovery_record(record: &WindowsProxyRecoveryRecord) -> Result<()> {
    use winreg::{RegKey, enums::HKEY_CURRENT_USER};

    let hkcu = RegKey::predef(HKEY_CURRENT_USER);
    let (key, _) = hkcu.create_subkey(WINDOWS_PROXY_RECOVERY_KEY)?;
    key.set_value(WINDOWS_PROXY_RECOVERY_VALUE, &serde_json::to_string(record)?)?;
    Ok(())
}

#[cfg(target_os = "windows")]
fn win_registry_delete_recovery_record() -> Result<()> {
    use winreg::{RegKey, enums::HKEY_CURRENT_USER};

    let hkcu = RegKey::predef(HKEY_CURRENT_USER);
    let key = match hkcu.open_subkey_with_flags(WINDOWS_PROXY_RECOVERY_KEY, winreg::enums::KEY_SET_VALUE) {
        Ok(key) => key,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        Err(error) => return Err(error.into()),
    };
    match key.delete_value(WINDOWS_PROXY_RECOVERY_VALUE) {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(error.into()),
    }
}

#[cfg(target_os = "windows")]
fn win_registry_begin_proxy_mutation(expected: WindowsProxySnapshot) -> Result<()> {
    let mut reconciled_interrupted_mutation = false;
    loop {
        let current = win_registry_read_proxy_snapshot()?;
        match win_registry_prepare_proxy_mutation_record(
            win_registry_read_recovery_record()?,
            &current,
            expected.clone(),
        )? {
            WindowsProxyMutationPreparation::ReconcileInterrupted => {
                if reconciled_interrupted_mutation {
                    return Err(anyhow!("Windows proxy recovery state could not be stabilized"));
                }
                win_registry_abort_proxy_mutation()?;
                reconciled_interrupted_mutation = true;
            }
            WindowsProxyMutationPreparation::Ready(record) => {
                win_registry_write_recovery_record(&record)?;
                break;
            }
        }
    }
    logging!(info, Type::Core, "Prepared durable Windows proxy recovery state");
    Ok(())
}

#[cfg(target_os = "windows")]
fn win_registry_commit_proxy_mutation() -> Result<()> {
    let mut record =
        win_registry_read_recovery_record()?.ok_or_else(|| anyhow!("Windows proxy recovery state is missing"))?;
    let current = win_registry_read_proxy_snapshot()?;
    if record.pending.as_ref() != Some(&current) {
        return Err(anyhow!("Windows proxy mutation did not reach its expected state"));
    }
    record.owned = record.pending.take();
    record.mutation_start = None;
    record.rollback_target = None;
    record.rollback_retain_ownership = false;
    win_registry_write_recovery_record(&record)?;
    logging!(info, Type::Core, "Committed Windows proxy ownership state");
    Ok(())
}

#[cfg(target_os = "windows")]
fn win_registry_restore_recorded_previous(mut record: WindowsProxyRecoveryRecord) -> Result<()> {
    let current = win_registry_read_proxy_snapshot()?;
    if current == record.previous {
        win_registry_refresh()?;
        if win_registry_read_proxy_snapshot()? != record.previous {
            return Err(anyhow!("Windows proxy settings changed during restore"));
        }
        win_registry_delete_recovery_record()?;
        return Ok(());
    }
    if !win_registry_record_owns_current(&record, &current) {
        return Err(anyhow!("Windows proxy settings are no longer owned by XXLink"));
    }

    // Restoring is itself a multi-value registry transaction. Persist its
    // start and target so a crash between writes can resume safely.
    record.mutation_start = Some(current);
    record.pending = Some(record.previous.clone());
    record.rollback_target = Some(record.previous.clone());
    record.rollback_retain_ownership = false;
    win_registry_write_recovery_record(&record)?;
    win_registry_restore_proxy_snapshot(record.previous.clone())?;
    if win_registry_read_proxy_snapshot()? != record.previous {
        return Err(anyhow!("Windows proxy settings changed during restore"));
    }
    win_registry_delete_recovery_record()?;
    logging!(info, Type::Core, "Restored durable Windows proxy recovery state");
    Ok(())
}

#[cfg(target_os = "windows")]
fn win_registry_abort_proxy_mutation() -> Result<()> {
    let Some(mut record) = win_registry_read_recovery_record()? else {
        return Ok(());
    };
    let current = win_registry_read_proxy_snapshot()?;
    let (target, retain_ownership) = win_registry_abort_target(&record);

    if current == target {
        win_registry_finalize_aborted_proxy_mutation(record, target, retain_ownership)?;
        logging!(info, Type::Core, "Finalized completed Windows proxy rollback");
        return Ok(());
    }
    if !win_registry_record_owns_current(&record, &current) {
        return Err(anyhow!("Windows proxy settings are no longer owned by XXLink"));
    }

    record.mutation_start = Some(current);
    record.pending = Some(target.clone());
    record.rollback_target = Some(target.clone());
    record.rollback_retain_ownership = retain_ownership;
    win_registry_write_recovery_record(&record)?;
    win_registry_restore_proxy_snapshot(target.clone())?;
    if win_registry_read_proxy_snapshot()? != target {
        return Err(anyhow!("Windows proxy settings changed during rollback"));
    }

    win_registry_finalize_aborted_proxy_mutation(record, target, retain_ownership)?;
    logging!(info, Type::Core, "Rolled back Windows proxy mutation");
    Ok(())
}

#[cfg(target_os = "windows")]
fn win_registry_finalize_aborted_proxy_mutation(
    mut record: WindowsProxyRecoveryRecord,
    target: WindowsProxySnapshot,
    retain_ownership: bool,
) -> Result<()> {
    if retain_ownership {
        record.owned = Some(target);
        record.pending = None;
        record.mutation_start = None;
        record.rollback_target = None;
        record.rollback_retain_ownership = false;
        win_registry_write_recovery_record(&record)
    } else {
        win_registry_delete_recovery_record()
    }
}

#[cfg(target_os = "windows")]
fn win_registry_try_restore_proxy_snapshot() -> Result<bool> {
    let Some(record) = win_registry_read_recovery_record()? else {
        return Ok(false);
    };
    win_registry_restore_recorded_previous(record)?;
    Ok(true)
}

#[cfg(target_os = "windows")]
fn win_registry_refresh() -> Result<()> {
    unsafe {
        use windows::Win32::Networking::WinInet::{
            INTERNET_OPTION_PROXY_SETTINGS_CHANGED, INTERNET_OPTION_REFRESH, InternetSetOptionW,
        };
        InternetSetOptionW(None, INTERNET_OPTION_PROXY_SETTINGS_CHANGED, None, 0)?;
        InternetSetOptionW(None, INTERNET_OPTION_REFRESH, None, 0)?;
    }
    Ok(())
}

/// Directly write proxy state to the Windows registry for reliability.
/// The sysproxy crate uses InternetSetOptionW which sometimes doesn't
/// persist to the registry on certain Windows versions.
#[cfg(target_os = "windows")]
fn win_registry_set_system_proxy(server: &str, bypass: &str) -> Result<()> {
    let key = win_registry_open_internet_settings()?;

    key.set_value("ProxyEnable", &1u32)?;
    key.set_value("ProxyServer", &server)?;
    key.set_value("ProxyOverride", &bypass)?;
    match key.delete_value("AutoConfigURL") {
        Ok(()) => {}
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
        Err(error) => return Err(error.into()),
    }

    win_registry_refresh()?;

    Ok(())
}

#[cfg(target_os = "windows")]
fn win_registry_set_auto_proxy(url: &str) -> Result<()> {
    let key = win_registry_open_internet_settings()?;
    key.set_value("ProxyEnable", &0u32)?;
    key.set_value("AutoConfigURL", &url)?;
    for name in ["ProxyServer", "ProxyOverride"] {
        match key.delete_value(name) {
            Ok(()) => {}
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(error) => return Err(error.into()),
        }
    }
    win_registry_refresh()
}

pub struct Sysopt {
    update_lock: TokioMutex<()>,
    reset_sysproxy: AtomicBool,
    inner_proxy: Arc<RwLock<(Sysproxy, Autoproxy)>>,
    guard: Arc<RwLock<GuardMonitor>>,
}

impl Default for Sysopt {
    fn default() -> Self {
        Self {
            update_lock: TokioMutex::new(()),
            reset_sysproxy: AtomicBool::new(false),
            inner_proxy: Arc::new(RwLock::new((Sysproxy::default(), Autoproxy::default()))),
            guard: Arc::new(RwLock::new(GuardMonitor::new(GuardType::None, Duration::from_secs(30)))),
        }
    }
}

#[cfg(target_os = "windows")]
static DEFAULT_BYPASS: &str = "localhost;127.*;192.168.*;10.*;172.16.*;172.17.*;172.18.*;172.19.*;172.20.*;172.21.*;172.22.*;172.23.*;172.24.*;172.25.*;172.26.*;172.27.*;172.28.*;172.29.*;172.30.*;172.31.*;<local>";
#[cfg(target_os = "linux")]
static DEFAULT_BYPASS: &str = "localhost,127.0.0.1,192.168.0.0/16,10.0.0.0/8,172.16.0.0/12,::1";
#[cfg(target_os = "macos")]
static DEFAULT_BYPASS: &str =
    "127.0.0.1,192.168.0.0/16,10.0.0.0/8,172.16.0.0/12,localhost,*.local,*.crashlytics.com,<local>";

async fn get_bypass() -> String {
    let use_default = Config::verge().await.latest_arc().use_default_bypass.unwrap_or(true);
    let res = {
        let verge = Config::verge().await;
        let verge = verge.latest_arc();
        verge.system_proxy_bypass.clone()
    };
    let custom_bypass = match res {
        Some(bypass) => bypass,
        None => "".into(),
    };

    if custom_bypass.is_empty() {
        DEFAULT_BYPASS.into()
    } else if use_default {
        format!("{DEFAULT_BYPASS},{custom_bypass}").into()
    } else {
        custom_bypass
    }
}

singleton!(Sysopt, SYSOPT);

impl Sysopt {
    fn new() -> Self {
        Self::default()
    }

    fn access_guard(&self) -> Arc<RwLock<GuardMonitor>> {
        Arc::clone(&self.guard)
    }

    pub async fn refresh_guard(&self) {
        logging!(info, Type::Core, "Refreshing system proxy guard...");
        let verge = Config::verge().await.latest_arc();
        if !verge.enable_system_proxy.unwrap_or_default() {
            logging!(info, Type::Core, "System proxy is disabled.");
            self.access_guard().write().stop();
            return;
        }
        if !verge.enable_proxy_guard.unwrap_or_default() {
            logging!(info, Type::Core, "System proxy guard is disabled.");
            return;
        }
        logging!(
            info,
            Type::Core,
            "Updating system proxy with duration: {} seconds",
            verge.proxy_guard_duration.unwrap_or(30)
        );
        {
            let guard = self.access_guard();
            guard
                .write()
                .set_interval(Duration::from_secs(verge.proxy_guard_duration.unwrap_or(30)));
        }
        logging!(info, Type::Core, "Starting system proxy guard...");
        {
            let guard = self.access_guard();
            guard.write().start();
        }
    }

    /// init the sysproxy
    pub async fn update_sysproxy(&self) -> Result<()> {
        let _lock = self.update_lock.lock().await;

        let verge = Config::verge().await.latest_arc();
        let sys_enable = verge.enable_system_proxy.unwrap_or_default();
        let port = match verge.verge_mixed_port {
            Some(port) => port,
            None if sys_enable => {
                let clash = Config::clash().await.latest_arc();
                if clash.source_read_failed() {
                    return Err(anyhow!("runtime configuration is unavailable"));
                }
                clash.get_mixed_port()
            }
            None => self.inner_proxy.read().0.port,
        };
        let pac_port = IVerge::get_singleton_port();
        let proxy_host = if sys_enable {
            normalize_proxy_host(verge.proxy_host.as_deref().unwrap_or("127.0.0.1"))
                .ok_or_else(|| anyhow!("invalid system proxy host"))?
        } else {
            String::from("127.0.0.1")
        };
        let (pac_enable, proxy_guard) = (
            verge.proxy_auto_config.unwrap_or_default(),
            verge.enable_proxy_guard.unwrap_or_default(),
        );
        // 先 await, 避免持有锁导致的 Send 问题
        let bypass = get_bypass().await;

        let (sys, auto, guard_type) = {
            let (sys, auto) = &mut *self.inner_proxy.write();
            sys.host = proxy_host.clone().into();
            sys.port = port;
            sys.bypass = bypass.into();
            auto.url = format!("http://{proxy_host}:{pac_port}/commands/pac");

            // `enable_system_proxy` is the master switch.
            // When disabled, force clear both global proxy and PAC at OS level.
            let guard_type = if !sys_enable {
                sys.enable = false;
                auto.enable = false;
                GuardType::None
            } else if pac_enable {
                sys.enable = false;
                auto.enable = true;
                if proxy_guard {
                    GuardType::Autoproxy(auto.clone())
                } else {
                    GuardType::None
                }
            } else {
                sys.enable = true;
                auto.enable = false;
                if proxy_guard {
                    GuardType::Sysproxy(sys.clone())
                } else {
                    GuardType::None
                }
            };

            (sys.clone(), auto.clone(), guard_type)
        };

        self.access_guard().write().set_guard_type(guard_type);

        logging!(
            info,
            Type::Core,
            "Setting system proxy: enable={}, host_validated=true, port={}, bypass_len={}",
            sys.enable,
            sys.port,
            sys.bypass.len()
        );

        tokio::task::spawn_blocking(move || -> Result<()> {
            if sys.enable && !auto.enable {
                // System proxy mode: set via sysproxy + registry for reliability
                #[cfg(target_os = "windows")]
                {
                    let server = format!("{}:{}", sys.host, sys.port);
                    win_registry_begin_proxy_mutation(WindowsProxySnapshot {
                        proxy_enable: Some(1),
                        proxy_server: Some(server.clone()),
                        proxy_override: Some(sys.bypass.to_string()),
                        auto_config_url: None,
                    })?;
                    let mutation = (|| -> Result<()> {
                        win_registry_set_system_proxy(&server, &sys.bypass)?;
                        win_registry_commit_proxy_mutation()
                    })();
                    if let Err(error) = mutation {
                        if win_registry_abort_proxy_mutation().is_err() {
                            return Err(anyhow!("Windows proxy mutation rollback failed"));
                        }
                        return Err(error);
                    }
                }
                #[cfg(not(target_os = "windows"))]
                sys.set_system_proxy()?;
                logging!(info, Type::Core, "System proxy set successfully");
            } else if auto.enable {
                #[cfg(target_os = "windows")]
                {
                    win_registry_begin_proxy_mutation(WindowsProxySnapshot {
                        proxy_enable: Some(0),
                        proxy_server: None,
                        proxy_override: None,
                        auto_config_url: Some(auto.url.to_string()),
                    })?;
                    let mutation = (|| -> Result<()> {
                        win_registry_set_auto_proxy(&auto.url)?;
                        win_registry_commit_proxy_mutation()
                    })();
                    if let Err(error) = mutation {
                        if win_registry_abort_proxy_mutation().is_err() {
                            return Err(anyhow!("Windows proxy mutation rollback failed"));
                        }
                        return Err(error);
                    }
                }
                #[cfg(not(target_os = "windows"))]
                auto.set_auto_proxy()?;
                logging!(info, Type::Core, "Auto proxy (PAC) set successfully");
            } else {
                #[cfg(target_os = "windows")]
                {
                    if win_registry_try_restore_proxy_snapshot()? {
                        logging!(info, Type::Core, "All proxies restored");
                        return Ok(());
                    }
                    logging!(info, Type::Core, "No XXLink-owned Windows proxy state to clear");
                    return Ok(());
                }

                // Both disabled: clear via sysproxy.
                #[cfg(not(target_os = "windows"))]
                {
                    sys.set_system_proxy()?;
                    logging!(info, Type::Core, "All proxies cleared");
                }
            }
            Ok(())
        })
        .await??;

        Ok(())
    }

    /// reset the sysproxy
    pub async fn reset_sysproxy(&self) -> Result<()> {
        let _lock = self.update_lock.lock().await;
        if self
            .reset_sysproxy
            .compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst)
            .is_err()
        {
            return Ok(());
        }
        defer! {
            self.reset_sysproxy.store(false, Ordering::SeqCst);
        }

        // close proxy guard
        self.access_guard().write().set_guard_type(GuardType::None);

        // 直接关闭所有代理
        #[cfg(target_os = "windows")]
        {
            let (sys, auto) = &mut *self.inner_proxy.write();
            sys.enable = false;
            auto.enable = false;
        }
        #[cfg(not(target_os = "windows"))]
        let sys = {
            let (sys, auto) = &mut *self.inner_proxy.write();
            sys.enable = false;
            auto.enable = false;
            sys.clone()
        };

        tokio::task::spawn_blocking(move || -> Result<()> {
            #[cfg(target_os = "windows")]
            {
                if win_registry_try_restore_proxy_snapshot()? {
                    logging!(
                        info,
                        Type::Core,
                        "System proxy reset restored previous Windows settings"
                    );
                } else {
                    logging!(info, Type::Core, "No XXLink-owned Windows proxy state to reset");
                }
                Ok(())
            }

            #[cfg(not(target_os = "windows"))]
            {
                sys.set_system_proxy()?;
                logging!(info, Type::Core, "System proxy reset successfully");
                Ok(())
            }
        })
        .await??;

        Ok(())
    }
}

#[cfg(test)]
mod runtime_boundary_tests {
    use super::normalize_proxy_host;
    #[cfg(target_os = "windows")]
    use super::{
        WINDOWS_PROXY_RECOVERY_VERSION, WindowsProxyMutationPreparation, WindowsProxyRecoveryRecord,
        WindowsProxySnapshot, win_registry_abort_target, win_registry_disabled_snapshot,
        win_registry_initial_previous_snapshot, win_registry_prepare_proxy_mutation_record,
        win_registry_record_owns_current, win_registry_snapshot_is_transition,
    };

    #[test]
    fn proxy_host_normalization_accepts_only_host_values() {
        assert_eq!(normalize_proxy_host("LOCALHOST").as_deref(), Some("localhost"));
        assert_eq!(normalize_proxy_host("127.0.0.1").as_deref(), Some("127.0.0.1"));
        assert_eq!(normalize_proxy_host("::1").as_deref(), Some("[::1]"));
        assert_eq!(normalize_proxy_host("[::1]").as_deref(), Some("[::1]"));
        assert!(normalize_proxy_host("http://127.0.0.1").is_none());
        assert!(normalize_proxy_host("127.0.0.1:7897").is_none());
        assert!(normalize_proxy_host("127.0.0.999").is_none());
        assert!(normalize_proxy_host("host/path").is_none());
    }

    #[cfg(target_os = "windows")]
    #[test]
    fn proxy_recovery_preserves_user_state_and_recognizes_owned_transitions() {
        let user_state = WindowsProxySnapshot {
            proxy_enable: Some(1),
            proxy_server: Some("user-proxy.invalid:8080".into()),
            proxy_override: Some("localhost;*.internal".into()),
            auto_config_url: None,
        };
        let xxlink_state = WindowsProxySnapshot {
            proxy_enable: Some(1),
            proxy_server: Some("127.0.0.1:7897".into()),
            proxy_override: Some("<local>".into()),
            auto_config_url: None,
        };
        assert_eq!(
            win_registry_initial_previous_snapshot(&user_state, &xxlink_state),
            user_state
        );
        assert_eq!(
            win_registry_initial_previous_snapshot(&xxlink_state, &xxlink_state),
            win_registry_disabled_snapshot()
        );

        let pending = WindowsProxyRecoveryRecord {
            version: WINDOWS_PROXY_RECOVERY_VERSION,
            previous: user_state.clone(),
            owned: None,
            pending: Some(xxlink_state.clone()),
            mutation_start: Some(user_state.clone()),
            rollback_target: None,
            rollback_retain_ownership: false,
        };
        assert!(win_registry_record_owns_current(&pending, &xxlink_state));
        assert!(win_registry_record_owns_current(&pending, &user_state));

        let partial_state = WindowsProxySnapshot {
            proxy_enable: xxlink_state.proxy_enable,
            proxy_server: xxlink_state.proxy_server.clone(),
            proxy_override: user_state.proxy_override.clone(),
            auto_config_url: user_state.auto_config_url.clone(),
        };
        assert!(win_registry_snapshot_is_transition(
            &partial_state,
            &user_state,
            &xxlink_state
        ));
        assert!(win_registry_record_owns_current(&pending, &partial_state));
        assert!(matches!(
            win_registry_prepare_proxy_mutation_record(
                Some(pending.clone()),
                &partial_state,
                WindowsProxySnapshot {
                    proxy_server: Some("127.0.0.1:7898".into()),
                    ..xxlink_state.clone()
                }
            ),
            Ok(WindowsProxyMutationPreparation::ReconcileInterrupted)
        ));

        let external_state = WindowsProxySnapshot {
            proxy_server: Some("external-change.invalid:3128".into()),
            ..partial_state
        };
        assert!(!win_registry_record_owns_current(&pending, &external_state));

        let restoring = WindowsProxyRecoveryRecord {
            version: WINDOWS_PROXY_RECOVERY_VERSION,
            previous: user_state.clone(),
            owned: Some(xxlink_state.clone()),
            pending: Some(user_state.clone()),
            mutation_start: Some(xxlink_state.clone()),
            rollback_target: Some(user_state.clone()),
            rollback_retain_ownership: false,
        };
        let partial_restore = WindowsProxySnapshot {
            proxy_enable: user_state.proxy_enable,
            proxy_server: xxlink_state.proxy_server.clone(),
            proxy_override: user_state.proxy_override.clone(),
            auto_config_url: xxlink_state.auto_config_url.clone(),
        };
        assert!(win_registry_record_owns_current(&restoring, &partial_restore));
        assert!(!win_registry_record_owns_current(&restoring, &external_state));
        assert!(matches!(
            win_registry_prepare_proxy_mutation_record(Some(restoring), &partial_restore, xxlink_state.clone()),
            Ok(WindowsProxyMutationPreparation::ReconcileInterrupted)
        ));

        let refresh = WindowsProxyRecoveryRecord {
            version: WINDOWS_PROXY_RECOVERY_VERSION,
            previous: user_state.clone(),
            owned: Some(xxlink_state.clone()),
            pending: Some(WindowsProxySnapshot {
                proxy_server: Some("127.0.0.1:7898".into()),
                proxy_override: Some("localhost;*.xxlink.invalid".into()),
                ..xxlink_state.clone()
            }),
            mutation_start: Some(xxlink_state.clone()),
            rollback_target: None,
            rollback_retain_ownership: false,
        };
        assert_eq!(win_registry_abort_target(&refresh), (xxlink_state.clone(), true));
        let partial_refresh = WindowsProxySnapshot {
            proxy_enable: xxlink_state.proxy_enable,
            proxy_server: refresh.pending.as_ref().and_then(|state| state.proxy_server.clone()),
            proxy_override: xxlink_state.proxy_override.clone(),
            auto_config_url: xxlink_state.auto_config_url.clone(),
        };
        assert!(matches!(
            win_registry_prepare_proxy_mutation_record(
                Some(refresh.clone()),
                &partial_refresh,
                WindowsProxySnapshot {
                    proxy_enable: Some(0),
                    proxy_server: None,
                    proxy_override: None,
                    auto_config_url: Some("http://127.0.0.1:33331/commands/pac".into()),
                }
            ),
            Ok(WindowsProxyMutationPreparation::ReconcileInterrupted)
        ));
        let pac_state = WindowsProxySnapshot {
            proxy_enable: Some(0),
            proxy_server: None,
            proxy_override: None,
            auto_config_url: Some("http://127.0.0.1:33331/commands/pac".into()),
        };
        let pac_transition = WindowsProxyRecoveryRecord {
            version: WINDOWS_PROXY_RECOVERY_VERSION,
            previous: user_state.clone(),
            owned: Some(xxlink_state.clone()),
            pending: Some(pac_state.clone()),
            mutation_start: Some(xxlink_state.clone()),
            rollback_target: None,
            rollback_retain_ownership: false,
        };
        let partial_pac = WindowsProxySnapshot {
            proxy_enable: pac_state.proxy_enable,
            proxy_server: xxlink_state.proxy_server.clone(),
            proxy_override: xxlink_state.proxy_override.clone(),
            auto_config_url: pac_state.auto_config_url.clone(),
        };
        assert!(matches!(
            win_registry_prepare_proxy_mutation_record(Some(pac_transition), &partial_pac, xxlink_state.clone()),
            Ok(WindowsProxyMutationPreparation::ReconcileInterrupted)
        ));
        assert!(matches!(
            win_registry_prepare_proxy_mutation_record(
                Some(refresh),
                &xxlink_state,
                pac_state
            ),
            Ok(WindowsProxyMutationPreparation::Ready(record))
                if record.mutation_start.as_ref() == Some(&xxlink_state)
                    && record.owned.as_ref() == Some(&xxlink_state)
        ));

        let first_enable = WindowsProxyRecoveryRecord {
            version: WINDOWS_PROXY_RECOVERY_VERSION,
            previous: user_state.clone(),
            owned: None,
            pending: Some(xxlink_state),
            mutation_start: Some(user_state.clone()),
            rollback_target: None,
            rollback_retain_ownership: false,
        };
        assert!(win_registry_record_owns_current(&first_enable, &user_state));
        assert_eq!(win_registry_abort_target(&first_enable), (user_state, false));
    }

    #[cfg(target_os = "windows")]
    #[test]
    fn proxy_recovery_keeps_stable_target_across_repeated_interruptions() {
        let user_state = WindowsProxySnapshot {
            proxy_enable: Some(1),
            proxy_server: Some("user-proxy.invalid:8080".into()),
            proxy_override: Some("localhost;*.internal".into()),
            auto_config_url: None,
        };
        let xxlink_state = WindowsProxySnapshot {
            proxy_enable: Some(1),
            proxy_server: Some("127.0.0.1:7897".into()),
            proxy_override: Some("<local>".into()),
            auto_config_url: None,
        };
        let pac_state = WindowsProxySnapshot {
            proxy_enable: Some(0),
            proxy_server: None,
            proxy_override: None,
            auto_config_url: Some("http://127.0.0.1:33331/commands/pac".into()),
        };
        let first_partial = WindowsProxySnapshot {
            proxy_enable: pac_state.proxy_enable,
            proxy_server: xxlink_state.proxy_server.clone(),
            proxy_override: xxlink_state.proxy_override.clone(),
            auto_config_url: pac_state.auto_config_url,
        };
        let rollback_retry = WindowsProxyRecoveryRecord {
            version: WINDOWS_PROXY_RECOVERY_VERSION,
            previous: user_state,
            owned: Some(xxlink_state.clone()),
            pending: Some(xxlink_state.clone()),
            mutation_start: Some(first_partial.clone()),
            rollback_target: Some(xxlink_state.clone()),
            rollback_retain_ownership: true,
        };
        let second_partial = WindowsProxySnapshot {
            proxy_enable: xxlink_state.proxy_enable,
            proxy_server: xxlink_state.proxy_server.clone(),
            proxy_override: xxlink_state.proxy_override.clone(),
            auto_config_url: first_partial.auto_config_url,
        };

        assert!(win_registry_record_owns_current(&rollback_retry, &second_partial));
        assert_eq!(win_registry_abort_target(&rollback_retry), (xxlink_state.clone(), true));
        assert!(matches!(
            win_registry_prepare_proxy_mutation_record(Some(rollback_retry), &second_partial, xxlink_state),
            Ok(WindowsProxyMutationPreparation::ReconcileInterrupted)
        ));
    }
}
