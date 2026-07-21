use super::CmdResult;
use crate::core::{autostart, handle};
use crate::utils::resolve::ui::{self, UiReadyStage};
use crate::{cmd::StringifyErr as _, feat, utils::dirs};
use smartstring::alias::String;
use xxlink_logging::{Type, logging};

/// 重启应用
#[tauri::command]
pub async fn restart_app() -> CmdResult<()> {
    feat::restart_app().await;
    Ok(())
}

/// 获取应用目录
#[tauri::command]
pub fn get_app_dir() -> CmdResult<String> {
    let app_home_dir = dirs::app_home_dir().stringify_err()?.to_string_lossy().into();
    Ok(app_home_dir)
}

/// 获取当前自启动状态
#[tauri::command]
pub fn get_auto_launch_status() -> CmdResult<bool> {
    autostart::get_launch_status().stringify_err()
}

/// 通知UI已准备就绪
#[tauri::command]
pub async fn notify_ui_ready() {
    logging!(info, Type::Cmd, "前端UI已准备就绪");
    ui::mark_ui_ready();
    crate::core::notification::NotificationSystem::flush_pending_events();

    handle::Handle::refresh_clash();
    let delayed_refresh_delay = std::time::Duration::from_millis(1500);
    tokio::time::sleep(delayed_refresh_delay).await;
    handle::Handle::refresh_clash();
}

/// UI加载阶段
#[tauri::command]
pub fn update_ui_stage(stage: UiReadyStage) {
    logging!(info, Type::Cmd, "UI加载阶段更新: {:?}", &stage);
    ui::update_ui_ready_stage(stage);
}
