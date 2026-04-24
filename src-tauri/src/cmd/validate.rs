use crate::core::handle;
use xxlink_logging::{Type, logging};
use smartstring::alias::String;

/// 处理YAML验证相关的所有消息通知
/// 统一通知接口，保持消息类型一致性
pub fn handle_yaml_validation_notice(result: &(bool, String), file_type: &str) {
    if !result.0 {
        let error_msg = &result.1;
        logging!(info, Type::Config, "[通知] 处理{}验证错误: {}", file_type, error_msg);

        // 检查是否为merge文件
        let is_merge_file = file_type.contains("合并");

        // 根据错误消息内容判断错误类型
        let status = if error_msg.starts_with("File not found:") {
            "config_validate::file_not_found"
        } else if error_msg.starts_with("Failed to read file:") {
            "config_validate::yaml_read_error"
        } else if error_msg.starts_with("YAML syntax error:") {
            if is_merge_file {
                "config_validate::merge_syntax_error"
            } else {
                "config_validate::yaml_syntax_error"
            }
        } else if error_msg.contains("mapping values are not allowed") {
            if is_merge_file {
                "config_validate::merge_mapping_error"
            } else {
                "config_validate::yaml_mapping_error"
            }
        } else if error_msg.contains("did not find expected key") {
            if is_merge_file {
                "config_validate::merge_key_error"
            } else {
                "config_validate::yaml_key_error"
            }
        } else {
            // 如果是其他类型错误，根据文件类型作为一般错误处理
            if is_merge_file {
                "config_validate::merge_error"
            } else {
                "config_validate::yaml_error"
            }
        };

        logging!(warn, Type::Config, "{} 验证失败: {}", file_type, error_msg);
        logging!(
            info,
            Type::Config,
            "[通知] 发送通知: status={}, msg={}",
            status,
            error_msg
        );
        handle::Handle::notice_message(status, error_msg.to_owned());
    }
}
