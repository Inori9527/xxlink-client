use crate::{
    config::{Config, IVerge},
    core::handle,
};
use clash_verge_logging::{Type, logging};

/// Toggle system proxy on/off
pub async fn toggle_system_proxy() -> bool {
    let verge = Config::verge().await;
    let current = verge.latest_arc().enable_system_proxy.unwrap_or(false);
    let auto_close_connection = verge.latest_arc().auto_close_connection.unwrap_or(false);

    // 如果当前系统代理即将关闭，且自动关闭连接设置为true，则关闭所有连接
    if current
        && auto_close_connection
        && let Err(err) = handle::Handle::mihomo().await.close_all_connections().await
    {
        logging!(error, Type::ProxyMode, "Failed to close all connections: {err}");
    }

    let requested = !current;
    let patch_result = super::patch_verge(
        &IVerge {
            enable_system_proxy: Some(requested),
            ..IVerge::default()
        },
        false,
    )
    .await;

    match patch_result {
        Ok(_) => {
            handle::Handle::refresh_verge();
            requested
        }
        Err(err) => {
            logging!(error, Type::ProxyMode, "{err}");
            current
        }
    }
}

/// Toggle TUN mode on/off
/// Returns the updated toggle state
pub async fn toggle_tun_mode(not_save_file: Option<bool>) -> bool {
    let current = Config::verge().await.latest_arc().enable_tun_mode.unwrap_or(false);
    let enable = !current;

    match super::patch_verge(
        &IVerge {
            enable_tun_mode: Some(enable),
            ..IVerge::default()
        },
        not_save_file.unwrap_or(false),
    )
    .await
    {
        Ok(_) => {
            handle::Handle::refresh_verge();
            enable
        }
        Err(err) => {
            logging!(error, Type::ProxyMode, "{err}");
            current
        }
    }
}
