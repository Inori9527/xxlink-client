use super::CmdResult;
use crate::utils::window_manager::WindowManager;
use crate::{
    config::{Config, IProfiles, profiles::profiles_save_file_safe},
    core::{CoreManager, handle, tray::Tray},
    feat,
    process::AsyncHandler,
    utils::dirs,
};
use once_cell::sync::Lazy;
use smartstring::alias::String;
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::time::Duration;
use tokio::sync::Notify;
use xxlink_logging::{Type, logging};

static CURRENT_SWITCHING_PROFILE: AtomicBool = AtomicBool::new(false);
static PRIORITY_PROFILE_WAITERS: AtomicUsize = AtomicUsize::new(0);
static PROFILE_SWITCH_RELEASED: Lazy<Notify> = Lazy::new(Notify::new);

pub(crate) struct ProfileSwitchGuard;

impl Drop for ProfileSwitchGuard {
    fn drop(&mut self) {
        CURRENT_SWITCHING_PROFILE.store(false, Ordering::Release);
        PROFILE_SWITCH_RELEASED.notify_waiters();
    }
}

pub(crate) fn try_profile_switch_guard() -> Option<ProfileSwitchGuard> {
    CURRENT_SWITCHING_PROFILE
        .compare_exchange(false, true, Ordering::Acquire, Ordering::Relaxed)
        .ok()
        .map(|_| ProfileSwitchGuard)
}

pub(crate) async fn wait_profile_switch_guard() -> ProfileSwitchGuard {
    loop {
        let released = PROFILE_SWITCH_RELEASED.notified();
        tokio::pin!(released);
        released.as_mut().enable();
        if PRIORITY_PROFILE_WAITERS.load(Ordering::Acquire) == 0
            && let Some(guard) = try_profile_switch_guard()
        {
            return guard;
        }
        released.await;
    }
}

struct PriorityProfileWaiter;

impl Drop for PriorityProfileWaiter {
    fn drop(&mut self) {
        PRIORITY_PROFILE_WAITERS.fetch_sub(1, Ordering::AcqRel);
        PROFILE_SWITCH_RELEASED.notify_waiters();
    }
}

pub(crate) async fn wait_priority_profile_switch_guard() -> ProfileSwitchGuard {
    PRIORITY_PROFILE_WAITERS.fetch_add(1, Ordering::AcqRel);
    let waiter = PriorityProfileWaiter;
    loop {
        let released = PROFILE_SWITCH_RELEASED.notified();
        tokio::pin!(released);
        released.as_mut().enable();
        if let Some(guard) = try_profile_switch_guard() {
            drop(waiter);
            return guard;
        }
        released.await;
    }
}

fn require_profile_switch_guard() -> CmdResult<ProfileSwitchGuard> {
    try_profile_switch_guard().ok_or_else(|| "profile_busy".into())
}

/// 增强配置文件
#[tauri::command]
pub async fn enhance_profiles() -> CmdResult {
    let _guard = require_profile_switch_guard()?;
    match feat::enhance_profiles().await {
        Ok((true, _)) => {
            handle::Handle::refresh_clash();
            Ok(())
        }
        Ok((false, msg)) => {
            let message: String = if msg.is_empty() {
                "Failed to reactivate profiles".into()
            } else {
                msg
            };
            logging!(
                warn,
                Type::Cmd,
                "Reactivate profiles command failed validation: {}",
                message.as_str()
            );
            Err(message)
        }
        Err(e) => {
            logging!(error, Type::Cmd, "{}", e);
            Err(e.to_string().into())
        }
    }
}

/// 导入配置文件
/// 验证新配置文件的语法
async fn validate_new_profile(new_profile: &String) -> Result<(), ()> {
    logging!(info, Type::Cmd, "正在切换到新配置: {}", new_profile);

    // 获取目标配置文件路径
    let config_file_result = {
        let profiles_config = Config::profiles().await;
        let profiles_data = profiles_config.latest_arc();
        match profiles_data.get_item(new_profile) {
            Ok(item) => {
                if let Some(file) = &item.file {
                    let path = dirs::app_profiles_dir().map(|dir| dir.join(file.as_str()));
                    path.ok()
                } else {
                    None
                }
            }
            Err(e) => {
                logging!(error, Type::Cmd, "获取目标配置信息失败: {}", e);
                None
            }
        }
    };

    // 如果获取到文件路径，检查YAML语法
    if let Some(file_path) = config_file_result {
        if !file_path.exists() {
            logging!(error, Type::Cmd, "目标配置文件不存在: {}", file_path.display());
            handle::Handle::notice_message("config_validate::file_not_found", format!("{}", file_path.display()));
            return Err(());
        }

        // 超时保护
        let file_read_result =
            tokio::time::timeout(Duration::from_secs(5), tokio::fs::read_to_string(&file_path)).await;

        match file_read_result {
            Ok(Ok(content)) => {
                let yaml_parse_result =
                    AsyncHandler::spawn_blocking(move || serde_yaml_ng::from_str::<serde_yaml_ng::Value>(&content))
                        .await;

                match yaml_parse_result {
                    Ok(Ok(_)) => {
                        logging!(info, Type::Cmd, "目标配置文件语法正确");
                        Ok(())
                    }
                    Ok(Err(err)) => {
                        let error_msg = format!(" {err}");
                        logging!(error, Type::Cmd, "目标配置文件存在YAML语法错误:{}", error_msg);
                        handle::Handle::notice_message("config_validate::yaml_syntax_error", error_msg);
                        Err(())
                    }
                    Err(join_err) => {
                        let error_msg = format!("YAML解析任务失败: {join_err}");
                        logging!(error, Type::Cmd, "{}", error_msg);
                        handle::Handle::notice_message("config_validate::yaml_parse_error", error_msg);
                        Err(())
                    }
                }
            }
            Ok(Err(err)) => {
                let error_msg = format!("无法读取目标配置文件: {err}");
                logging!(error, Type::Cmd, "{}", error_msg);
                handle::Handle::notice_message("config_validate::file_read_error", error_msg);
                Err(())
            }
            Err(_) => {
                let error_msg = "读取配置文件超时(5秒)".to_string();
                logging!(error, Type::Cmd, "{}", error_msg);
                handle::Handle::notice_message("config_validate::file_read_timeout", error_msg);
                Err(())
            }
        }
    } else {
        Ok(())
    }
}

/// 执行配置更新并处理结果
async fn restore_previous_profile(prev_profile: &String) -> CmdResult<()> {
    logging!(info, Type::Cmd, "尝试恢复到之前的配置: {}", prev_profile);
    let restore_profiles = IProfiles {
        current: Some(prev_profile.to_owned()),
        items: None,
    };
    Config::profiles()
        .await
        .edit_draft(|d| d.patch_config(&restore_profiles));
    Config::profiles().await.apply();
    crate::process::AsyncHandler::spawn(|| async move {
        if let Err(e) = profiles_save_file_safe().await {
            logging!(warn, Type::Cmd, "Warning: 异步保存恢复配置文件失败: {e}");
        }
    });
    logging!(info, Type::Cmd, "成功恢复到之前的配置");
    Ok(())
}

async fn handle_success(current_value: Option<&String>) -> CmdResult<bool> {
    Config::profiles().await.apply();
    handle::Handle::refresh_clash();

    if let Err(e) = Tray::global().update_tooltip().await {
        logging!(warn, Type::Cmd, "Warning: 异步更新托盘提示失败: {e}");
    }

    if let Err(e) = Tray::global().update_menu().await {
        logging!(warn, Type::Cmd, "Warning: 异步更新托盘菜单失败: {e}");
    }

    if let Err(e) = profiles_save_file_safe().await {
        logging!(warn, Type::Cmd, "Warning: 异步保存配置文件失败: {e}");
    }

    if let Some(current) = current_value
        && WindowManager::get_main_window().is_some()
    {
        logging!(info, Type::Cmd, "向前端发送配置变更事件: {}", current);
        handle::Handle::notify_profile_changed(current);
    }

    Ok(true)
}

async fn handle_validation_failure(error_msg: String, current_profile: Option<&String>) -> CmdResult<bool> {
    // No masking here any more. Since the validator's own output stops at its
    // boundary, this string is already a fixed message plus an exit code, and
    // the only variable branch is the architecture sentinel below, whose text is
    // this repository's own copy rather than anything remote.
    // If the failure was flagged as an architecture mismatch, surface the
    // dedicated notice so the UI can tell the user to reinstall.
    if let Some(tail) = error_msg.strip_prefix(crate::core::validate::ARCH_MISMATCH_PREFIX) {
        let arch_msg: String = tail.into();
        logging!(error, Type::Cmd, "Sidecar 架构不匹配，中止配置切换: {}", arch_msg);
        Config::profiles().await.discard();
        if let Some(prev_profile) = current_profile {
            restore_previous_profile(prev_profile).await?;
        }
        handle::Handle::notice_message("config_validate::core_arch_mismatch", arch_msg);
        return Ok(false);
    }
    logging!(warn, Type::Cmd, "配置验证失败: {}", error_msg);
    Config::profiles().await.discard();
    if let Some(prev_profile) = current_profile {
        restore_previous_profile(prev_profile).await?;
    }
    handle::Handle::notice_message("config_validate::error", error_msg);
    Ok(false)
}

async fn handle_update_error<E: std::fmt::Display>(e: E) -> CmdResult<bool> {
    // Fixed message. The error derives from the core-config chain, which
    // carries the user's own config text; `os error 216` is still matched below
    // to classify, but nothing derived from the string is logged or shown.
    let rendered = e.to_string();
    logging!(warn, Type::Cmd, "更新过程发生错误");
    Config::profiles().await.discard();
    // Windows OS error 216 == ERROR_EXE_MACHINE_TYPE_MISMATCH: the sidecar
    // binary is the wrong architecture for this machine. Report it as such
    // instead of a generic boot error, so the UI can guide the user to
    // reinstall the correct build.
    //
    // The match reads the string; the string does not leave. Passing `rendered`
    // to the notice was the whole leak on this path -- the notice key already
    // says which of the two happened, so the payload only ever added the error
    // text the user must not be shown.
    if rendered.contains("os error 216") {
        handle::Handle::notice_message("config_validate::core_arch_mismatch", "");
    } else {
        handle::Handle::notice_message("config_validate::boot_error", "");
    }
    Ok(false)
}

async fn handle_timeout(current_profile: Option<&String>) -> CmdResult<bool> {
    let timeout_msg = "配置更新超时(30秒)，可能是配置验证或核心通信阻塞";
    logging!(error, Type::Cmd, "{}", timeout_msg);
    Config::profiles().await.discard();
    if let Some(prev_profile) = current_profile {
        restore_previous_profile(prev_profile).await?;
    }
    handle::Handle::notice_message("config_validate::timeout", timeout_msg);
    Ok(false)
}

async fn perform_config_update(current_value: Option<&String>, current_profile: Option<&String>) -> CmdResult<bool> {
    let update_result = tokio::time::timeout(Duration::from_secs(30), CoreManager::global().update_config()).await;

    match update_result {
        Ok(Ok((true, _))) => handle_success(current_value).await,
        Ok(Ok((false, error_msg))) => handle_validation_failure(error_msg, current_profile).await,
        Ok(Err(e)) => handle_update_error(e).await,
        Err(_) => handle_timeout(current_profile).await,
    }
}

/// 修改profiles的配置
async fn patch_profiles_config_inner(profiles: IProfiles, expected_current: Option<Option<String>>) -> CmdResult<bool> {
    let Some(_guard) = try_profile_switch_guard() else {
        logging!(info, Type::Cmd, "当前正在切换配置，放弃请求");
        return Ok(false);
    };

    let target_profile = profiles.current.as_ref();

    logging!(info, Type::Cmd, "开始修改配置文件，目标profile: {:?}", target_profile);

    // 保存当前配置，以便在验证失败时恢复
    let previous_profile = Config::profiles().await.data_arc().current.clone();
    if expected_current.is_some_and(|expected| expected != previous_profile) {
        return Ok(false);
    }
    logging!(info, Type::Cmd, "当前配置: {:?}", previous_profile);

    // 如果要切换配置，先检查目标配置文件是否有语法错误
    if let Some(switch_to_profile) = target_profile
        && previous_profile.as_ref() != Some(switch_to_profile)
        && validate_new_profile(switch_to_profile).await.is_err()
    {
        return Ok(false);
    }
    Config::profiles().await.edit_draft(|d| d.patch_config(&profiles));

    perform_config_update(target_profile, previous_profile.as_ref()).await
}

pub async fn patch_profiles_config(profiles: IProfiles) -> CmdResult<bool> {
    patch_profiles_config_inner(profiles, None).await
}

pub(crate) async fn patch_profiles_config_if_current_under_guard(
    profiles: IProfiles,
    expected_current: Option<String>,
) -> CmdResult<bool> {
    let target_profile = profiles.current.as_ref();
    let previous_profile = Config::profiles().await.data_arc().current.clone();
    if previous_profile != expected_current {
        return Ok(false);
    }
    if let Some(switch_to_profile) = target_profile
        && previous_profile.as_ref() != Some(switch_to_profile)
        && validate_new_profile(switch_to_profile).await.is_err()
    {
        return Ok(false);
    }
    Config::profiles()
        .await
        .edit_draft(|draft| draft.patch_config(&profiles));
    perform_config_update(target_profile, previous_profile.as_ref()).await
}

/// 根据profile name修改profiles
#[tauri::command]
pub async fn patch_profiles_config_by_profile_index(profile_index: String) -> CmdResult<bool> {
    logging!(info, Type::Cmd, "切换配置到: {}", profile_index);

    let profiles = IProfiles {
        current: Some(profile_index),
        items: None,
    };
    patch_profiles_config(profiles).await
}
