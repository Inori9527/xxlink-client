use super::CmdResult;
use crate::config::Config;
use serde_yaml_ng::Mapping;
use smartstring::alias::String;
use std::collections::HashMap;

/// 获取运行时配置
#[tauri::command]
pub async fn get_runtime_config() -> CmdResult<Option<Mapping>> {
    Ok(Config::runtime().await.latest_arc().config.clone())
}

/// 获取运行时日志
#[tauri::command]
pub async fn get_runtime_logs() -> CmdResult<HashMap<String, Vec<(String, String)>>> {
    Ok(Config::runtime().await.latest_arc().chain_logs.clone())
}
