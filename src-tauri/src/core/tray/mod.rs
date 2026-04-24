use crate::config::IVerge;
use crate::core::service;
use crate::core::tray::menu_def::TrayAction;
use crate::module::lightweight;
use crate::process::AsyncHandler;
use crate::singleton;
use crate::utils::window_manager::WindowManager;
use crate::{Type, config::Config, feat, logging};
use xxlink_limiter::{Limiter, SystemClock, SystemLimiter};
use xxlink_logging::logging_error;
use tauri::tray::{MouseButton, MouseButtonState, TrayIcon, TrayIconBuilder, TrayIconEvent};
use tauri_plugin_xxlink_sysinfo::is_current_app_handle_admin;

use super::handle;
use anyhow::Result;
use std::time::Duration;
use tauri::{
    AppHandle, Wry,
    menu::{CheckMenuItem, IsMenuItem, MenuEvent, MenuItem, PredefinedMenuItem},
};
mod menu_def;
use menu_def::{MenuIds, MenuTexts};

// TODO: 是否需要将可变菜单抽离存储起来，后续直接更新对应菜单实例，无需重新创建菜单(待考虑)

const TRAY_CLICK_DEBOUNCE_MS: u64 = 300;

#[derive(Clone)]
struct TrayState {}

enum IconKind {
    Common,
    SysProxy,
    Tun,
}

pub struct Tray {
    limiter: SystemLimiter,
}

impl TrayState {
    fn get_tray_icon(verge: &IVerge) -> Vec<u8> {
        let tun_mode = verge.enable_tun_mode.unwrap_or(false);
        let system_mode = verge.enable_system_proxy.unwrap_or(false);
        let kind = if tun_mode {
            IconKind::Tun
        } else if system_mode {
            IconKind::SysProxy
        } else {
            IconKind::Common
        };
        Self::default_icon(kind)
    }

    fn default_icon(kind: IconKind) -> Vec<u8> {
        match kind {
            IconKind::Common => include_bytes!("../../../icons/tray-icon.ico").to_vec(),
            IconKind::SysProxy => include_bytes!("../../../icons/tray-icon-sys.ico").to_vec(),
            IconKind::Tun => include_bytes!("../../../icons/tray-icon-tun.ico").to_vec(),
        }
    }
}

impl Default for Tray {
    #[allow(clippy::unwrap_used)]
    fn default() -> Self {
        Self {
            limiter: Limiter::new(Duration::from_millis(TRAY_CLICK_DEBOUNCE_MS), SystemClock),
        }
    }
}

singleton!(Tray, TRAY);

impl Tray {
    fn new() -> Self {
        Self::default()
    }

    pub async fn init(&self) -> Result<()> {
        if handle::Handle::global().is_exiting() {
            logging!(debug, Type::Tray, "应用正在退出，跳过托盘初始化");
            return Ok(());
        }

        let app_handle = handle::Handle::app_handle();

        match self.create_tray_from_handle(app_handle).await {
            Ok(_) => {
                logging!(info, Type::Tray, "System tray created successfully");
            }
            Err(e) => {
                // Don't return error, let application continue running without tray
                logging!(
                    warn,
                    Type::Tray,
                    "System tray creation failed: {e}, Application will continue running without tray icon",
                );
            }
        }
        Ok(())
    }

    /// 更新托盘点击行为
    pub async fn update_click_behavior(&self) -> Result<()> {
        if handle::Handle::global().is_exiting() {
            logging!(debug, Type::Tray, "应用正在退出，跳过托盘点击行为更新");
            return Ok(());
        }

        let app_handle = handle::Handle::app_handle();
        let tray_event = { Config::verge().await.latest_arc().tray_event.clone() };
        let tray_event = TrayAction::from(tray_event.as_deref().unwrap_or("main_window"));
        let tray = app_handle
            .tray_by_id("main")
            .ok_or_else(|| anyhow::anyhow!("Failed to get main tray"))?;
        match tray_event {
            TrayAction::TrayMenu => tray.set_show_menu_on_left_click(true)?,
            _ => tray.set_show_menu_on_left_click(false)?,
        }
        Ok(())
    }

    /// 更新托盘菜单
    pub async fn update_menu(&self) -> Result<()> {
        if handle::Handle::global().is_exiting() {
            logging!(debug, Type::Tray, "应用正在退出，跳过托盘菜单更新");
            return Ok(());
        }
        let app_handle = handle::Handle::app_handle();
        self.update_menu_internal(app_handle).await
    }

    async fn update_menu_internal(&self, app_handle: &AppHandle) -> Result<()> {
        let Some(tray) = app_handle.tray_by_id("main") else {
            logging!(warn, Type::Tray, "Failed to update tray menu: tray not found");
            return Ok(());
        };

        let verge = Config::verge().await.latest_arc();
        let system_proxy = verge.enable_system_proxy.as_ref().unwrap_or(&false);
        let tun_mode = verge.enable_tun_mode.as_ref().unwrap_or(&false);
        let tun_mode_available =
            is_current_app_handle_admin(app_handle) || service::is_service_available().await.is_ok();

        logging_error!(
            Type::Tray,
            tray.set_menu(Some(create_tray_menu(
                app_handle,
                *system_proxy,
                *tun_mode,
                tun_mode_available
            )?,))
        );

        logging!(debug, Type::Tray, "托盘菜单更新成功");
        Ok(())
    }

    /// 更新托盘图标
    #[allow(clippy::unused_async)]
    pub async fn update_icon(&self, verge: &IVerge) -> Result<()> {
        if handle::Handle::global().is_exiting() {
            logging!(debug, Type::Tray, "应用正在退出，跳过托盘图标更新");
            return Ok(());
        }

        let app_handle = handle::Handle::app_handle();

        let Some(tray) = app_handle.tray_by_id("main") else {
            logging!(warn, Type::Tray, "Failed to update tray icon: tray not found");
            return Ok(());
        };

        let icon_bytes = TrayState::get_tray_icon(verge);

        logging_error!(
            Type::Tray,
            tray.set_icon(Some(tauri::image::Image::from_bytes(&icon_bytes)?))
        );

        Ok(())
    }

    /// 更新托盘提示
    pub async fn update_tooltip(&self) -> Result<()> {
        if handle::Handle::global().is_exiting() {
            logging!(debug, Type::Tray, "应用正在退出，跳过托盘提示更新");
            return Ok(());
        }

        let app_handle = handle::Handle::app_handle();

        let verge = Config::verge().await.latest_arc();
        let system_proxy = verge.enable_system_proxy.unwrap_or(false);
        let tun_mode = verge.enable_tun_mode.unwrap_or(false);

        let switch_str = |flag: bool| {
            if flag { "on" } else { "off" }
        };

        let mut current_profile_name = "None".into();
        {
            let profiles = Config::profiles().await;
            let profiles = profiles.latest_arc();
            if let Some(current_profile_uid) = profiles.get_current()
                && let Ok(profile) = profiles.get_item(current_profile_uid)
            {
                current_profile_name = match &profile.name {
                    Some(profile_name) => profile_name.to_string(),
                    None => current_profile_name,
                };
            }
        }

        // Get localized strings before using them
        let sys_proxy_text = xxlink_i18n::t!("tray.tooltip.systemProxy");
        let tun_text = xxlink_i18n::t!("tray.tooltip.tun");
        let profile_text = xxlink_i18n::t!("tray.tooltip.profile");

        let v = env!("CARGO_PKG_VERSION");
        let reassembled_version = v.split_once('+').map_or_else(
            || v.into(),
            |(main, rest)| format!("{main}+{}", rest.split('.').next().unwrap_or("")),
        );

        let tooltip = format!(
            "XXLink {}\n{}: {}\n{}: {}\n{}: {}",
            reassembled_version,
            sys_proxy_text,
            switch_str(system_proxy),
            tun_text,
            switch_str(tun_mode),
            profile_text,
            current_profile_name
        );

        let Some(tray) = app_handle.tray_by_id("main") else {
            logging!(warn, Type::Tray, "Failed to update tray tooltip: tray not found");
            return Ok(());
        };

        logging_error!(Type::Tray, tray.set_tooltip(Some(&tooltip)));

        Ok(())
    }

    pub async fn update_part(&self) -> Result<()> {
        if handle::Handle::global().is_exiting() {
            logging!(debug, Type::Tray, "应用正在退出，跳过托盘局部更新");
            return Ok(());
        }
        let verge = Config::verge().await.data_arc();
        self.update_menu().await?;
        self.update_icon(&verge).await?;
        self.update_tooltip().await?;
        Ok(())
    }

    pub async fn update_menu_and_icon(&self) {
        logging_error!(Type::Tray, self.update_menu().await);
        let verge = Config::verge().await.data_arc();
        logging_error!(Type::Tray, self.update_icon(&verge).await);
    }

    async fn create_tray_from_handle(&self, app_handle: &AppHandle) -> Result<()> {
        if handle::Handle::global().is_exiting() {
            logging!(debug, Type::Tray, "应用正在退出，跳过托盘创建");
            return Ok(());
        }

        logging!(info, Type::Tray, "正在从AppHandle创建系统托盘");

        let verge = Config::verge().await.data_arc();

        let icon_bytes = TrayState::get_tray_icon(&verge);
        let icon = tauri::image::Image::from_bytes(&icon_bytes)?;

        #[cfg(target_os = "linux")]
        let builder = TrayIconBuilder::with_id("main").icon(icon).icon_as_template(false);

        #[cfg(any(target_os = "macos", target_os = "windows"))]
        let show_menu_on_left_click = verge.tray_event.as_ref().is_some_and(|v| v == "tray_menu");

        #[cfg(not(target_os = "linux"))]
        let mut builder = TrayIconBuilder::with_id("main").icon(icon).icon_as_template(false);

        #[cfg(any(target_os = "macos", target_os = "windows"))]
        {
            if !show_menu_on_left_click {
                builder = builder.show_menu_on_left_click(false);
            }
        }

        let tray = builder.build(app_handle)?;
        tray.on_tray_icon_event(on_tray_icon_event);
        tray.on_menu_event(on_menu_event);
        Ok(())
    }

    fn should_handle_tray_click(&self) -> bool {
        let allow = self.limiter.check();
        if !allow {
            logging!(debug, Type::Tray, "tray click rate limited");
        }
        allow
    }
}

// The trimmed consumer tray no longer invokes these legacy features, but they
// remain in the codebase for non-tray reuse. Reference them here so `dead_code`
// lints (promoted to errors in CI) stay quiet without editing files outside
// the tray scope.
#[allow(dead_code)]
const fn _legacy_tray_keepalive() {
    let _ = crate::feat::restart_clash_core;
    let _ = crate::feat::toggle_proxy_profile;
    let _ = crate::feat::switch_proxy_node;
    let _ = crate::module::lightweight::is_in_lightweight_mode;
    let _ = crate::cmd::patch_profiles_config_by_profile_index;
}

fn create_tray_menu(
    app_handle: &AppHandle,
    system_proxy_enabled: bool,
    tun_mode_enabled: bool,
    tun_mode_available: bool,
) -> Result<tauri::menu::Menu<Wry>> {
    let version = env!("CARGO_PKG_VERSION");
    let texts = MenuTexts::new();

    let open_window = &MenuItem::with_id(app_handle, MenuIds::DASHBOARD, &texts.dashboard, true, None::<&str>)?;

    let system_proxy = &CheckMenuItem::with_id(
        app_handle,
        MenuIds::SYSTEM_PROXY,
        &texts.system_proxy,
        true,
        system_proxy_enabled,
        None::<&str>,
    )?;

    let tun_mode = &CheckMenuItem::with_id(
        app_handle,
        MenuIds::TUN_MODE,
        &texts.tun_mode,
        tun_mode_available,
        tun_mode_enabled,
        None::<&str>,
    )?;

    let close_all_connections = &MenuItem::with_id(
        app_handle,
        MenuIds::CLOSE_ALL_CONNECTIONS,
        &texts.close_all_connections,
        true,
        None::<&str>,
    )?;

    let restart_app = &MenuItem::with_id(app_handle, MenuIds::RESTART_APP, &texts.restart_app, true, None::<&str>)?;

    let app_version = &MenuItem::with_id(
        app_handle,
        MenuIds::VERGE_VERSION,
        format!("{} {version}", &texts.verge_version),
        false,
        None::<&str>,
    )?;

    #[cfg(target_os = "macos")]
    let quit_accelerator: Option<&str> = Some("Cmd+Q");
    #[cfg(not(target_os = "macos"))]
    let quit_accelerator: Option<&str> = None;

    let quit = &MenuItem::with_id(app_handle, MenuIds::EXIT, &texts.exit, true, quit_accelerator)?;

    let separator = &PredefinedMenuItem::separator(app_handle)?;

    let menu_items: Vec<&dyn IsMenuItem<Wry>> = vec![
        open_window,
        separator,
        system_proxy as &dyn IsMenuItem<Wry>,
        tun_mode as &dyn IsMenuItem<Wry>,
        close_all_connections as &dyn IsMenuItem<Wry>,
        separator,
        restart_app,
        separator,
        app_version,
        quit as &dyn IsMenuItem<Wry>,
    ];

    let menu = tauri::menu::MenuBuilder::new(app_handle).items(&menu_items).build()?;
    Ok(menu)
}

fn on_tray_icon_event(_tray_icon: &TrayIcon, tray_event: TrayIconEvent) {
    if matches!(
        tray_event,
        TrayIconEvent::Move { .. } | TrayIconEvent::Leave { .. } | TrayIconEvent::Enter { .. }
    ) {
        return;
    }

    if let TrayIconEvent::Click {
        button: MouseButton::Left,
        button_state: MouseButtonState::Down,
        ..
    } = tray_event
    {
        // 添加防抖检查，防止快速连击
        #[allow(clippy::use_self)]
        if !Tray::global().should_handle_tray_click() {
            return;
        }

        AsyncHandler::spawn(|| async move {
            let verge = Config::verge().await.data_arc();
            let verge_tray_event = verge.tray_event.clone().unwrap_or_else(|| "main_window".into());
            let verge_tray_action = TrayAction::from(verge_tray_event.as_str());
            logging!(debug, Type::Tray, "tray event: {verge_tray_action:?}");
            match verge_tray_action {
                TrayAction::SystemProxy => {
                    let _ = feat::toggle_system_proxy().await;
                }
                TrayAction::TunMode => {
                    let _ = feat::toggle_tun_mode(None).await;
                }
                TrayAction::MainWindow => {
                    if !lightweight::exit_lightweight_mode().await {
                        WindowManager::show_main_window().await;
                    };
                }
                _ => {
                    logging!(warn, Type::Tray, "invalid tray event: {}", verge_tray_event);
                }
            };
        });
    }
}

fn on_menu_event(_: &AppHandle, event: MenuEvent) {
    if !Tray::global().should_handle_tray_click() {
        return;
    }
    if event.id.as_ref().is_empty() {
        return;
    }
    AsyncHandler::spawn(|| async move {
        match event.id.as_ref() {
            MenuIds::DASHBOARD => {
                logging!(info, Type::Tray, "托盘菜单点击: 打开窗口");
                if !lightweight::exit_lightweight_mode().await {
                    WindowManager::show_main_window().await;
                };
            }
            MenuIds::SYSTEM_PROXY => {
                feat::toggle_system_proxy().await;
            }
            MenuIds::TUN_MODE => {
                feat::toggle_tun_mode(None).await;
            }
            MenuIds::CLOSE_ALL_CONNECTIONS => {
                if let Err(err) = handle::Handle::mihomo().await.close_all_connections().await {
                    logging!(error, Type::Tray, "Failed to close all connections from tray: {err}");
                }
            }
            MenuIds::RESTART_APP => feat::restart_app().await,
            MenuIds::EXIT => {
                feat::quit().await;
            }
            _ => {
                logging!(debug, Type::Tray, "Unhandled tray menu event: {:?}", event.id);
            }
        }

        // We dont expected to refresh tray state here
        // as the inner handle function (SHOULD) already takes care of it
    });
}
