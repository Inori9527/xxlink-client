use super::CmdResult;
use crate::{
    cmd::StringifyErr as _,
    config::{Config, PrfItem},
    core::validate::CoreConfigValidator,
    utils::dirs,
};
use clash_verge_logging::{Type, logging};
use smartstring::alias::String;
use tokio::fs;

/// 保存profiles的配置
#[tauri::command]
pub async fn save_profile_file(index: String, file_data: Option<String>) -> CmdResult {
    let file_data = match file_data {
        Some(d) => d,
        None => return Ok(()),
    };

    // 在异步操作前获取必要元数据并释放锁
    let rel_path = {
        let profiles = Config::profiles().await;
        let profiles_guard = profiles.latest_arc();
        let item = profiles_guard.get_item(&index).stringify_err()?;
        item.file.clone().ok_or("file field is null")?
    };

    // 读取原始内容（在释放profiles_guard后进行）
    let original_content = PrfItem {
        file: Some(rel_path.clone()),
        ..Default::default()
    }
    .read_file()
    .await
    .stringify_err()?;

    let profiles_dir = dirs::app_profiles_dir().stringify_err()?;
    let file_path = profiles_dir.join(rel_path.as_str());
    let file_path = file_path.canonicalize().unwrap_or(file_path.clone());
    if !file_path.starts_with(&profiles_dir) {
        return Err("invalid profile file path".into());
    }
    let file_path_str = file_path.to_string_lossy().to_string();

    // 保存新的配置文件
    fs::write(&file_path, &file_data).await.stringify_err()?;

    logging!(
        info,
        Type::Config,
        "[cmd配置save] 开始验证配置文件: {}",
        file_path_str,
    );

    match CoreConfigValidator::validate_config_file(&file_path_str, None).await {
        Ok((true, _)) => {
            logging!(info, Type::Config, "[cmd配置save] 验证成功");
            Ok(())
        }
        Ok((false, error_msg)) => {
            logging!(warn, Type::Config, "[cmd配置save] 验证失败: {}", error_msg);
            restore_original(&file_path, &original_content).await?;
            let result = (false, error_msg.to_owned());
            crate::cmd::validate::handle_yaml_validation_notice(&result, "YAML配置文件");
            Ok(())
        }
        Err(e) => {
            logging!(error, Type::Config, "[cmd配置save] 验证过程发生错误: {}", e);
            restore_original(&file_path, &original_content).await?;
            Err(e.to_string().into())
        }
    }
}

async fn restore_original(file_path: &std::path::Path, original_content: &str) -> Result<(), String> {
    fs::write(file_path, original_content).await.stringify_err()
}
