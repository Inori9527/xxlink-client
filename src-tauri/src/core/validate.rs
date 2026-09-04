use anyhow::Result;
use scopeguard::defer;
use smartstring::alias::String;
use std::sync::atomic::{AtomicBool, Ordering};
use tauri_plugin_shell::ShellExt as _;

use crate::config::{Config, ConfigType};
use crate::core::handle;
use crate::singleton;
use crate::utils::help;
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
            // Decode before masking. `{:?}` on the raw bytes escapes the text
            // into a Debug form, and mask_err's scheme scan cannot see a URL
            // through that escaping -- the mask would be applied and still
            // emit the credential.
            let decoded = str::from_utf8(stderr).unwrap_or_default();
            logging!(info, Type::Validate, "stderr: {}", help::mask_err(decoded));
        }

        if has_error {
            logging!(info, Type::Validate, "发现错误，开始处理错误信息");
            // The validator quotes the offending config fragment back, which
            // for a proxy config means server hosts, UUIDs and passwords. It
            // is logged AND returned to callers, reaching the UI via
            // config.rs:135 and core/manager/config.rs:82 -- so it is masked
            // here, where it is built, rather than at each consumer.
            let error_msg: String = if !stdout.is_empty() {
                help::mask_err(str::from_utf8(stdout).unwrap_or_default()).into()
            } else if !stderr.is_empty() {
                help::mask_err(str::from_utf8(stderr).unwrap_or_default()).into()
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
