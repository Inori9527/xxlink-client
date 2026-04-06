use crate::{
    config::{Config, IVerge},
    singleton,
};
use anyhow::Result;
use clash_verge_logging::{Type, logging};
use parking_lot::RwLock;
use scopeguard::defer;
use smartstring::alias::String;
use std::{
    sync::{
        Arc,
        atomic::{AtomicBool, Ordering},
    },
    time::Duration,
};
use sysproxy::{Autoproxy, GuardMonitor, GuardType, Sysproxy};
use tokio::sync::Mutex as TokioMutex;

/// Directly write proxy state to the Windows registry for reliability.
/// The sysproxy crate uses InternetSetOptionW which sometimes doesn't
/// persist to the registry on certain Windows versions.
#[cfg(target_os = "windows")]
fn win_registry_set_proxy(enable: bool, server: &str, bypass: &str) -> Result<()> {
    use winreg::enums::*;
    use winreg::RegKey;

    let hkcu = RegKey::predef(HKEY_CURRENT_USER);
    let (key, _) = hkcu.create_subkey(
        "Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings",
    )?;

    key.set_value("ProxyEnable", &(if enable { 1u32 } else { 0u32 }))?;

    if enable {
        key.set_value("ProxyServer", &server)?;
        key.set_value("ProxyOverride", &bypass)?;
    }

    // Signal WinInet to pick up changes
    unsafe {
        use windows::Win32::Networking::WinInet::{
            InternetSetOptionW, INTERNET_OPTION_PROXY_SETTINGS_CHANGED,
            INTERNET_OPTION_REFRESH,
        };
        let _ = InternetSetOptionW(None, INTERNET_OPTION_PROXY_SETTINGS_CHANGED, None, 0);
        let _ = InternetSetOptionW(None, INTERNET_OPTION_REFRESH, None, 0);
    }

    Ok(())
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
        let port = match verge.verge_mixed_port {
            Some(port) => port,
            None => Config::clash().await.latest_arc().get_mixed_port(),
        };
        let pac_port = IVerge::get_singleton_port();
        let (sys_enable, pac_enable, proxy_host, proxy_guard) = (
            verge.enable_system_proxy.unwrap_or_default(),
            verge.proxy_auto_config.unwrap_or_default(),
            verge.proxy_host.clone().unwrap_or_else(|| String::from("127.0.0.1")),
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
            "Setting system proxy: enable={}, host={}, port={}, bypass_len={}",
            sys.enable,
            sys.host,
            sys.port,
            sys.bypass.len()
        );

        tokio::task::spawn_blocking(move || -> Result<()> {
            if sys.enable && !auto.enable {
                // System proxy mode: set via sysproxy + registry for reliability
                if let Err(e) = sys.set_system_proxy() {
                    logging!(error, Type::Core, "Failed to set system proxy: {:?}", e);
                    return Err(e.into());
                }
                #[cfg(target_os = "windows")]
                {
                    let server = format!("{}:{}", sys.host, sys.port);
                    let bypass_str: std::string::String = sys.bypass.into();
                    if let Err(e) = win_registry_set_proxy(true, &server, &bypass_str) {
                        logging!(error, Type::Core, "Failed to write proxy registry: {:?}", e);
                    }
                }
                logging!(info, Type::Core, "System proxy set successfully");
            } else if auto.enable {
                // PAC mode: only set auto proxy
                if let Err(e) = auto.set_auto_proxy() {
                    logging!(error, Type::Core, "Failed to set auto proxy: {:?}", e);
                    return Err(e.into());
                }
                logging!(info, Type::Core, "Auto proxy (PAC) set successfully");
            } else {
                // Both disabled: clear via sysproxy + registry
                if let Err(e) = sys.set_system_proxy() {
                    logging!(error, Type::Core, "Failed to clear system proxy: {:?}", e);
                    return Err(e.into());
                }
                #[cfg(target_os = "windows")]
                {
                    if let Err(e) = win_registry_set_proxy(false, "", "") {
                        logging!(error, Type::Core, "Failed to clear proxy registry: {:?}", e);
                    }
                }
                logging!(info, Type::Core, "All proxies cleared");
            }
            Ok(())
        })
        .await??;

        Ok(())
    }

    /// reset the sysproxy
    pub async fn reset_sysproxy(&self) -> Result<()> {
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
        let sys = {
            let (sys, auto) = &mut *self.inner_proxy.write();
            sys.enable = false;
            auto.enable = false;
            sys.clone()
        };

        tokio::task::spawn_blocking(move || -> Result<()> {
            sys.set_system_proxy()?;
            #[cfg(target_os = "windows")]
            {
                if let Err(e) = win_registry_set_proxy(false, "", "") {
                    logging!(error, Type::Core, "Failed to clear proxy registry on reset: {:?}", e);
                }
            }
            logging!(info, Type::Core, "System proxy reset successfully");
            Ok(())
        })
        .await??;

        Ok(())
    }
}
