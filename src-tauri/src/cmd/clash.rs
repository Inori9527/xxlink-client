use super::CmdResult;
use crate::feat;
use crate::{
    cmd::StringifyErr as _,
    config::{ClashInfo, Config},
    core::{CoreManager, handle},
};
use serde_yaml_ng::Mapping;
use xxlink_logging::{Type, logging_error};

/// 获取Clash信息
#[tauri::command]
pub async fn get_clash_info() -> CmdResult<ClashInfo> {
    Ok(Config::clash().await.data_arc().get_client_info())
}

/// 修改Clash配置
#[tauri::command]
pub async fn patch_clash_config(payload: Mapping) -> CmdResult {
    feat::patch_clash(&payload).await.stringify_err()
}

/// 启动核心
#[tauri::command]
pub async fn start_core() -> CmdResult {
    let result = CoreManager::global().start_core().await.stringify_err();
    if result.is_ok() {
        handle::Handle::refresh_clash();
    }
    result
}

/// 关闭核心
#[tauri::command]
pub async fn stop_core() -> CmdResult {
    logging_error!(Type::Core, Config::profiles().await.data_arc().save_file().await);
    let result = CoreManager::global().stop_core().await.stringify_err();
    if result.is_ok() {
        handle::Handle::refresh_clash();
    }
    result
}

/// 重启核心
#[tauri::command]
pub async fn restart_core() -> CmdResult {
    logging_error!(Type::Core, Config::profiles().await.data_arc().save_file().await);
    let result = CoreManager::global().restart_core().await.stringify_err();
    if result.is_ok() {
        handle::Handle::refresh_clash();
    }
    result
}

pub(super) async fn diagnostics_log_summary(
    max_items: usize,
) -> super::runtime_action_controller::DiagnosticLogSummary {
    let logs = CoreManager::global().get_clash_logs().await.unwrap_or_default();
    let component_count = usize::from(!logs.is_empty());
    let entries = logs
        .iter()
        .map(|entry| parse_clash_log(entry.as_str()))
        .collect::<Vec<_>>();
    super::runtime_action_controller::summarize_diagnostic_entries(
        super::runtime_action_controller::DiagnosticLogSource::Clash,
        component_count,
        entries,
        max_items,
    )
}

fn parse_clash_log(value: &str) -> (&str, &str) {
    if let Some(level_start) = value.find(" level=") {
        let level = &value[level_start + 7..];
        if let Some(message_start) = level.find(" msg=\"") {
            let message = &level[message_start + 6..];
            return (&level[..message_start], message.strip_suffix('"').unwrap_or(message));
        }
    }

    let trimmed = value.trim();
    let Some(first_end) = trimmed.find(char::is_whitespace) else {
        return ("unknown", value);
    };
    let rest = trimmed[first_end..].trim_start();
    let Some(level_end) = rest.find(char::is_whitespace) else {
        return ("unknown", value);
    };
    (rest[..level_end].trim(), rest[level_end..].trim_start())
}

#[cfg(test)]
mod tests {
    use super::parse_clash_log;

    #[test]
    fn parses_structured_and_plain_clash_logs() {
        assert_eq!(
            parse_clash_log(r#"time="2026-07-22T12:00:00Z" level=warning msg="network timeout""#),
            ("warning", "network timeout")
        );
        assert_eq!(
            parse_clash_log("07-22T12:00:00   error   profile sync failed"),
            ("error", "profile sync failed")
        );
    }
}
