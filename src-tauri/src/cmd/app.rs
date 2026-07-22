use crate::core::handle;
use crate::utils::resolve::ui::{self, UiReadyStage};
use xxlink_logging::{Type, logging};

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
