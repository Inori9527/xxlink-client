use super::CmdResult;
use crate::{
    config::{Config, IVerge, PrfItem, PrfSelected, profiles::profiles_patch_item_safe},
    core::{handle, tray},
    feat,
};
use once_cell::sync::Lazy;
use serde::{Deserialize, Serialize};
use serde_yaml_ng::{Mapping, Value};
use smartstring::alias::String;
use std::time::Duration;
use tauri::AppHandle;
use tauri_plugin_updater::{Update, UpdaterExt as _};
use tokio::sync::Mutex;

const MAX_NODE_LABEL_BYTES: usize = 512;
static PENDING_UPDATE: Lazy<Mutex<Option<Update>>> = Lazy::new(|| Mutex::new(None));

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ApprovedUpdateView {
    version: String,
    body: Option<String>,
    date: Option<String>,
}

#[derive(Clone, Copy, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum RuntimeConnectMode {
    System,
    Both,
    Smart,
}

impl RuntimeConnectMode {
    const fn as_str(self) -> &'static str {
        match self {
            Self::System => "system",
            Self::Both => "both",
            Self::Smart => "smart",
        }
    }

    const fn clash_mode(self) -> &'static str {
        match self {
            Self::Smart => "rule",
            Self::System | Self::Both => "global",
        }
    }
}

fn safe_error() -> String {
    "runtime_action_failed".into()
}

fn validate_node_label(value: &str) -> CmdResult<()> {
    if value.is_empty() || value.len() > MAX_NODE_LABEL_BYTES || value.chars().any(char::is_control) {
        Err("invalid_node_selection".into())
    } else {
        Ok(())
    }
}

async fn patch_clash_mode(mode: RuntimeConnectMode) -> CmdResult<()> {
    let mut patch = Mapping::new();
    patch.insert(Value::from("mode"), Value::from(mode.clash_mode()));
    feat::patch_clash(&patch).await.map_err(|_| safe_error())
}

async fn patch_connection_state(mode: RuntimeConnectMode, enabled: bool) -> CmdResult<()> {
    if enabled {
        patch_clash_mode(mode).await?;
    }
    let (enable_tun_mode, enable_system_proxy) = match mode {
        RuntimeConnectMode::System => (false, enabled),
        RuntimeConnectMode::Both | RuntimeConnectMode::Smart => (enabled, enabled),
    };
    feat::patch_verge(
        &IVerge {
            enable_tun_mode: Some(enable_tun_mode),
            enable_system_proxy: Some(enable_system_proxy),
            connect_mode: Some(mode.as_str().into()),
            ..IVerge::default()
        },
        false,
    )
    .await
    .map_err(|_| safe_error())?;
    handle::Handle::refresh_verge();
    Ok(())
}

#[tauri::command]
pub async fn runtime_set_connection_enabled(mode: RuntimeConnectMode, enabled: bool) -> CmdResult<()> {
    patch_connection_state(mode, enabled).await
}

#[tauri::command]
pub async fn runtime_set_connection_mode(mode: RuntimeConnectMode) -> CmdResult<()> {
    let verge = Config::verge().await.latest_arc();
    let enabled = verge.enable_tun_mode.unwrap_or(false) || verge.enable_system_proxy.unwrap_or(false);
    drop(verge);
    if enabled {
        return patch_connection_state(mode, true).await;
    }
    feat::patch_verge(
        &IVerge {
            connect_mode: Some(mode.as_str().into()),
            ..IVerge::default()
        },
        false,
    )
    .await
    .map_err(|_| safe_error())?;
    handle::Handle::refresh_verge();
    Ok(())
}

#[tauri::command]
pub async fn runtime_set_tun_enabled(enabled: bool) -> CmdResult<()> {
    feat::patch_verge(
        &IVerge {
            enable_tun_mode: Some(enabled),
            ..IVerge::default()
        },
        false,
    )
    .await
    .map_err(|_| safe_error())?;
    handle::Handle::refresh_verge();
    Ok(())
}

#[tauri::command]
pub async fn runtime_set_system_proxy_enabled(enabled: bool) -> CmdResult<()> {
    let verge = Config::verge().await.latest_arc();
    let close_connections = !enabled && verge.auto_close_connection.unwrap_or(false);
    drop(verge);
    if close_connections {
        let _ = handle::Handle::mihomo().await.close_all_connections().await;
    }
    feat::patch_verge(
        &IVerge {
            enable_system_proxy: Some(enabled),
            ..IVerge::default()
        },
        false,
    )
    .await
    .map_err(|_| safe_error())?;
    handle::Handle::refresh_verge();
    Ok(())
}

async fn persist_node_selection(group_name: &str, proxy_name: &str) -> CmdResult<()> {
    let _profile_guard = crate::cmd::wait_profile_switch_guard().await;
    let profiles = Config::profiles().await.data_arc();
    let current = profiles.current.clone().ok_or_else(safe_error)?;
    let mut item: PrfItem = profiles.get_item(&current).map_err(|_| safe_error())?.clone();
    drop(profiles);

    let selected = item.selected.get_or_insert_default();
    if let Some(entry) = selected
        .iter_mut()
        .find(|entry| entry.name.as_deref() == Some(group_name))
    {
        entry.now = Some(proxy_name.into());
    } else {
        selected.push(PrfSelected {
            name: Some(group_name.into()),
            now: Some(proxy_name.into()),
        });
    }
    profiles_patch_item_safe(&current, &item)
        .await
        .map_err(|_| safe_error())
}

#[tauri::command]
pub async fn runtime_select_node(group_name: String, proxy_name: String, persist: bool) -> CmdResult<()> {
    validate_node_label(&group_name)?;
    validate_node_label(&proxy_name)?;
    let mihomo = handle::Handle::mihomo().await;
    if mihomo.select_node_for_group(&group_name, &proxy_name).await.is_err() {
        mihomo
            .select_node_for_group(&group_name, &proxy_name)
            .await
            .map_err(|_| safe_error())?;
    }
    drop(mihomo);
    if persist {
        let _ = persist_node_selection(&group_name, &proxy_name).await;
    }
    handle::Handle::refresh_clash();
    let _ = tray::Tray::global().update_menu().await;
    Ok(())
}

#[tauri::command]
pub async fn runtime_check_update(app: AppHandle) -> CmdResult<Option<ApprovedUpdateView>> {
    let updater = app.updater().map_err(|_| safe_error())?;
    let update = tokio::time::timeout(Duration::from_secs(10), updater.check())
        .await
        .map_err(|_| safe_error())?
        .map_err(|_| safe_error())?;
    let Some(update) = update else {
        *PENDING_UPDATE.lock().await = None;
        return Ok(None);
    };
    let view = ApprovedUpdateView {
        version: update.version.clone().into(),
        body: update.body.clone().map(Into::into),
        date: update.date.map(|date| date.to_string().into()),
    };
    *PENDING_UPDATE.lock().await = Some(update);
    Ok(Some(view))
}

#[tauri::command]
pub async fn runtime_install_update(app: AppHandle, expected_version: String) -> CmdResult<()> {
    let update = PENDING_UPDATE.lock().await.take().ok_or_else(safe_error)?;
    if update.version != expected_version {
        *PENDING_UPDATE.lock().await = Some(update);
        return Err("update_version_mismatch".into());
    }
    if update.download_and_install(|_, _| {}, || {}).await.is_err() {
        *PENDING_UPDATE.lock().await = Some(update);
        return Err(safe_error());
    }
    app.restart();
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn node_selection_rejects_empty_oversized_and_control_values() {
        assert!(validate_node_label("").is_err());
        assert!(validate_node_label(&"x".repeat(MAX_NODE_LABEL_BYTES + 1)).is_err());
        assert!(validate_node_label("group\nname").is_err());
        assert!(validate_node_label("东京-免费/轻量-01").is_ok());
    }
}
