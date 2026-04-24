use anyhow::Result;
use scopeguard::defer;
use smartstring::alias::String;
use std::sync::atomic::{AtomicBool, Ordering};
use tauri_plugin_shell::ShellExt as _;
use tokio::fs;

use crate::config::{Config, ConfigType};
use crate::core::handle;
use crate::singleton;
use crate::utils::{arch_check, dirs};
use xxlink_logging::{Type, logging};

/// Sentinel prefix used to flag a validation failure that was caused by the
/// sidecar binary not matching the host CPU architecture. The config layer
/// recognises this prefix and translates it into a distinct frontend notice
/// instead of the misleading "subscription config validation failed" message.
pub const ARCH_MISMATCH_PREFIX: &str = "__xxlink_core_arch_mismatch__::";

pub struct CoreConfigValidator {
    is_processing: AtomicBool,
}

impl CoreConfigValidator {
    pub const fn new() -> Self {
        Self {
            is_processing: AtomicBool::new(false),
        }
    }

    pub fn try_start(&self) -> bool {
        !self.is_processing.swap(true, Ordering::AcqRel)
    }

    pub fn finish(&self) {
        self.is_processing.store(false, Ordering::Release)
    }
}

impl CoreConfigValidator {
    /// 只进行文件语法检查，不进行完整验证
    async fn validate_file_syntax(config_path: &str) -> Result<(bool, String)> {
        logging!(info, Type::Validate, "开始检查文件: {}", config_path);

        // 读取文件内容
        let content = match fs::read_to_string(config_path).await {
            Ok(content) => content,
            Err(err) => {
                let error_msg = format!("Failed to read file: {err}").into();
                logging!(error, Type::Validate, "无法读取文件: {}", error_msg);
                return Ok((false, error_msg));
            }
        };
        // 对YAML文件尝试解析，只检查语法正确性
        logging!(info, Type::Validate, "进行YAML语法检查");
        match serde_yaml_ng::from_str::<serde_yaml_ng::Value>(&content) {
            Ok(_) => {
                logging!(info, Type::Validate, "YAML语法检查通过");
                Ok((true, String::new()))
            }
            Err(err) => {
                // 使用标准化的前缀，以便错误处理函数能正确识别
                let error_msg = format!("YAML syntax error: {err}").into();
                logging!(error, Type::Validate, "YAML语法错误: {}", error_msg);
                Ok((false, error_msg))
            }
        }
    }

    /// 验证指定的配置文件
    pub async fn validate_config_file(config_path: &str, is_merge_file: Option<bool>) -> Result<(bool, String)> {
        // 检查程序是否正在退出，如果是则跳过验证
        if handle::Handle::global().is_exiting() {
            logging!(info, Type::Core, "应用正在退出，跳过验证");
            return Ok((true, String::new()));
        }

        // 检查文件是否存在
        if !std::path::Path::new(config_path).exists() {
            let error_msg = format!("File not found: {config_path}").into();
            return Ok((false, error_msg));
        }

        // 如果是合并文件且不是强制验证，执行语法检查但不进行完整验证
        if is_merge_file.unwrap_or(false) {
            logging!(info, Type::Validate, "检测到Merge文件，仅进行语法检查: {}", config_path);
            return Self::validate_file_syntax(config_path).await;
        }

        // 对YAML配置文件使用Clash内核验证
        logging!(info, Type::Validate, "使用Clash内核验证配置文件: {}", config_path);
        Self::validate_config_internal(config_path).await
    }

    /// 内部验证配置文件的实现
    async fn validate_config_internal(config_path: &str) -> Result<(bool, String)> {
        // 检查程序是否正在退出，如果是则跳过验证
        if handle::Handle::global().is_exiting() {
            logging!(info, Type::Validate, "应用正在退出，跳过验证");
            return Ok((true, String::new()));
        }

        logging!(info, Type::Validate, "开始验证配置文件: {}", config_path);

        let clash_core = Config::verge().await.latest_arc().get_valid_clash_core();
        logging!(info, Type::Validate, "使用内核: {}", clash_core);

        // If the sidecar is the wrong architecture, spawning it will fail
        // with Windows OS error 216. Detect that before we try, so the
        // caller can surface a meaningful notice instead of a confusing
        // "subscription config failed" message.
        if let Ok(Some(report)) = arch_check::check_sidecar_arch(clash_core.as_str()) {
            let msg = report.human_message();
            logging!(error, Type::Validate, "{}", msg);
            let flagged: String = format!("{ARCH_MISMATCH_PREFIX}{msg}").into();
            return Ok((false, flagged));
        }

        let app_handle = handle::Handle::app_handle();
        let app_dir = dirs::app_home_dir()?;
        let app_dir_str = dirs::path_to_str(&app_dir)?;
        logging!(info, Type::Validate, "验证目录: {}", app_dir_str);

        // 使用子进程运行clash验证配置
        let command =
            app_handle
                .shell()
                .sidecar(clash_core.as_str())?
                .args(["-t", "-d", app_dir_str, "-f", config_path]);
        let output = match command.output().await {
            Ok(output) => output,
            Err(err) => {
                // Belt-and-braces: the Windows arch-mismatch check above
                // should catch this first, but if the sidecar path moved
                // or the PE read failed, we can still recognise OS error
                // 216 from the spawn failure and flag it for the caller.
                let rendered = err.to_string();
                if rendered.contains("os error 216") {
                    logging!(
                        error,
                        Type::Validate,
                        "Sidecar 架构不匹配（通过 spawn 错误识别）: {}",
                        rendered
                    );
                    let flagged: String = format!("{ARCH_MISMATCH_PREFIX}{rendered}").into();
                    return Ok((false, flagged));
                }
                return Err(err.into());
            }
        };

        let status = &output.status;
        let stderr = &output.stderr;
        let stdout = &output.stdout;

        // 检查进程退出状态和错误输出
        let error_keywords = ["FATA", "fatal", "Parse config error", "level=fatal"];
        let has_error = !status.success() || contains_any_keyword(stderr, &error_keywords);

        logging!(info, Type::Validate, "-------- 验证结果 --------");

        if !stderr.is_empty() {
            logging!(info, Type::Validate, "stderr输出:\n{:?}", stderr);
        }

        if has_error {
            logging!(info, Type::Validate, "发现错误，开始处理错误信息");
            let error_msg: String = if !stdout.is_empty() {
                str::from_utf8(stdout).unwrap_or_default().into()
            } else if !stderr.is_empty() {
                str::from_utf8(stderr).unwrap_or_default().into()
            } else if let Some(code) = status.code() {
                format!("验证进程异常退出，退出码: {code}").into()
            } else {
                "验证进程被终止".into()
            };

            logging!(info, Type::Validate, "-------- 验证结束 --------");
            Ok((false, error_msg)) // 返回错误消息给调用者处理
        } else {
            logging!(info, Type::Validate, "验证成功");
            logging!(info, Type::Validate, "-------- 验证结束 --------");
            Ok((true, String::new()))
        }
    }

    /// 验证运行时配置
    pub async fn validate_config(&self) -> Result<(bool, String)> {
        if !self.try_start() {
            logging!(info, Type::Validate, "验证已在进行中，跳过新的验证请求");
            return Ok((true, String::new()));
        }
        defer! {
            self.finish();
        }
        logging!(info, Type::Validate, "生成临时配置文件用于验证");

        let config_path = Config::generate_file(ConfigType::Check).await?;
        let config_path = dirs::path_to_str(&config_path)?;
        Self::validate_config_internal(config_path).await
    }
}

fn contains_any_keyword<'a>(buf: &'a [u8], keywords: &'a [&str]) -> bool {
    for &kw in keywords {
        let needle = kw.as_bytes();
        if needle.is_empty() {
            continue;
        }
        let mut i = 0;
        while i + needle.len() <= buf.len() {
            if &buf[i..i + needle.len()] == needle {
                return true;
            }
            i += 1;
        }
    }
    false
}

singleton!(CoreConfigValidator, CORECONFIGVALIDATOR);
