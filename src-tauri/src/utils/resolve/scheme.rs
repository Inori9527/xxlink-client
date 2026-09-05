use std::time::Duration;

use anyhow::Result;
use percent_encoding::percent_decode_str;
use smartstring::alias::String;
use tauri::Url;
use tokio::sync::Semaphore;

use crate::{
    config::{Config, PrfItem, profiles},
    core::{CoreManager, handle},
    utils::help,
};
use xxlink_logging::{Type, logging, logging_error};

static DEEP_LINK_IMPORT_SLOTS: Semaphore = Semaphore::const_new(2);

pub(super) async fn resolve_scheme(param: &str) -> Result<()> {
    let redacted_param = redacted_deep_link_for_log(param);
    logging!(info, Type::Config, "received deep link: {}", redacted_param);

    let param_str = unwrap_deep_link_param(param)?;

    let link_parsed =
        Url::parse(param_str).map_err(|e| anyhow::anyhow!("failed to parse deep link: {:?}, {}", e, redacted_param))?;

    let Some((url, name)) = extract_subscription_info(&link_parsed) else {
        logging!(
            error,
            Type::Config,
            "missing url parameter in deep link: {}",
            redacted_deep_link_url_summary(&link_parsed)
        );
        return Ok(());
    };

    import_subscription(&url, name.as_ref()).await;
    Ok(())
}

fn extract_subscription_info(link_parsed: &Url) -> Option<(std::string::String, Option<String>)> {
    if !matches!(link_parsed.scheme(), "xxlink") {
        return None;
    }

    let name = link_parsed
        .query_pairs()
        .find(|(key, _)| key == "name")
        .map(|(_, value)| value.into_owned().into());
    let url = extract_subscription_url(link_parsed)?;
    Some((url, name))
}

fn extract_subscription_url(link_parsed: &Url) -> Option<std::string::String> {
    let query = link_parsed.query()?;
    let prefix = "url=";
    let pos = query.find(prefix)?;
    let raw_url = query[pos + prefix.len()..].trim();
    Some(decode_subscription_url(raw_url))
}

fn decode_subscription_url(raw_url: &str) -> std::string::String {
    // Avoid double-decoding nested subscription URLs; decode only when needed.
    if Url::parse(raw_url).is_ok() {
        return raw_url.to_string();
    }

    let mut candidate = raw_url.to_string();
    for _ in 0..2 {
        let next = percent_decode_str(&candidate).decode_utf8_lossy().to_string();
        if next == candidate {
            break;
        }
        candidate = next;
        if Url::parse(&candidate).is_ok() {
            break;
        }
    }
    candidate
}

async fn import_subscription(url: &str, name: Option<&String>) {
    let Ok(_slot) = DEEP_LINK_IMPORT_SLOTS.acquire().await else {
        return;
    };

    let Some(mut item) = fetch_profile_item(url, name).await else {
        return;
    };

    let _guard = crate::cmd::wait_profile_switch_guard().await;
    let had_current_profile = {
        let profiles = Config::profiles().await;
        profiles.latest_arc().current.is_some()
    };

    let uid = item.uid.clone().unwrap_or_default();
    if let Err(e) = profiles::profiles_append_item_safe(&mut item).await {
        // Fixed message: this error comes from the config/filesystem write, so
        // it has no class worth reading and no part worth quoting.
        let _ = &e;
        let message = "failed to import subscription url";
        logging!(error, Type::Config, "{}", message);
        Config::profiles().await.discard();
        handle::Handle::notice_message("import_sub_url::error", message);
        return;
    }

    Config::profiles().await.apply();
    logging_error!(Type::Config, Config::profiles().await.data_arc().save_file().await);
    handle::Handle::notice_message(
        "import_sub_url::ok",
        "", // 空 msg 传入，我们不希望导致 后端-前端-后端 死循环，这里只做提醒。
    );

    post_import_updates(&uid, had_current_profile).await;
}

async fn fetch_profile_item(url: &str, name: Option<&String>) -> Option<PrfItem> {
    match PrfItem::from_url(url, name, None, None).await {
        Ok(item) => Some(item),
        Err(e) => {
            let class = help::fetch_error_class(&e);
            logging!(
                error,
                Type::Config,
                "failed to parse profile from url ({}): {}",
                class,
                help::mask_url(url)
            );
            // Class only on the notification surface; the user supplied the link.
            handle::Handle::notice_message("import_sub_url::error", class);
            None
        }
    }
}

fn unwrap_deep_link_param(param: &str) -> Result<&str> {
    if param.starts_with("[") && param.len() > 4 {
        param
            .get(2..param.len() - 2)
            .ok_or_else(|| anyhow::anyhow!("Invalid string slice boundaries"))
    } else {
        Ok(param)
    }
}

fn redacted_deep_link_for_log(param: &str) -> std::string::String {
    let Ok(param_str) = unwrap_deep_link_param(param) else {
        return format!("scheme=<invalid>, input_len={}", param.len());
    };

    match Url::parse(param_str) {
        Ok(url) => redacted_deep_link_url_summary(&url),
        Err(_) => format!("scheme=<invalid>, input_len={}", param.len()),
    }
}

fn redacted_deep_link_url_summary(link_parsed: &Url) -> std::string::String {
    let has_name = link_parsed.query_pairs().any(|(key, _)| key == "name");
    let subscription_url = extract_subscription_url(link_parsed);
    let has_url = subscription_url.is_some();
    let subscription_url = subscription_url
        .as_deref()
        // One implementation of this predicate, not two. The local
        // `redacted_subscription_url_for_log` was a second redactor for the same
        // job and it drifted exactly as duplication does: neither M10's path
        // threshold nor M11's non-hierarchical-scheme rule ever reached it, so a
        // vmess payload and an eight-byte token came through here after both
        // were closed in `mask_url`.
        .map(help::mask_url)
        .unwrap_or_else(|| std::string::String::from("<missing>"));

    format!(
        "scheme={}, has_url={}, has_name={}, subscription_url={}",
        link_parsed.scheme(),
        has_url,
        has_name,
        subscription_url
    )
}

async fn post_import_updates(uid: &String, had_current_profile: bool) {
    handle::Handle::refresh_verge();
    handle::Handle::notify_profile_changed(uid);
    tokio::time::sleep(Duration::from_millis(100)).await;

    let should_update_core = if uid.is_empty() || had_current_profile {
        false
    } else {
        let profiles = Config::profiles().await;
        profiles.latest_arc().is_current_profile_index(uid)
    };
    handle::Handle::notify_profile_changed(uid);

    if should_update_core {
        refresh_core_config().await;
    }
}

async fn refresh_core_config() {
    logging!(
        info,
        Type::Config,
        "Deep link import set current profile; refreshing core config"
    );
    match CoreManager::global().update_config().await {
        Ok((true, _)) => handle::Handle::refresh_clash(),
        Ok((false, msg)) => {
            let message = if msg.is_empty() {
                String::from("Failed to apply subscription configuration")
            } else {
                msg
            };
            logging!(warn, Type::Config, "Apply config failed: {}", message);
            handle::Handle::notice_message("config_validate::error", message);
        }
        Err(err) => {
            logging!(error, Type::Config, "Apply config error: {}", err);
            handle::Handle::notice_message("update_failed", format!("{err}"));
        }
    }
}

#[cfg(test)]
mod runtime_boundary_tests {
    use super::*;

    #[test]
    fn encoded_subscription_url_extraction_keeps_import_behavior() -> Result<(), String> {
        let link = Url::parse(
            "xxlink://install?name=prod&url=https%3A%2F%2Fapi.xxlink.net%2Fapi%2Fv1%2Fsubscription%2Fsecret-token-123456%3Fformat%3Dclash%26token%3Dabc123",
        )
        .map_err(|err| format!("test deep link should parse: {err}"))?;
        let subscription_url = extract_subscription_url(&link)
            .ok_or_else(|| "test deep link should include a subscription URL".to_string())?;

        assert_eq!(
            subscription_url,
            "https://api.xxlink.net/api/v1/subscription/secret-token-123456?format=clash&token=abc123"
        );
        Ok(())
    }

    #[test]
    fn deep_link_log_summary_redacts_subscription_token_and_query() {
        let summary = redacted_deep_link_for_log(
            "xxlink://install?name=prod&url=https%3A%2F%2Fapi.xxlink.net%2Fapi%2Fv1%2Fsubscription%2Fsecret-token-123456%3Fformat%3Dclash%26token%3Dabc123",
        );

        // Pinned whole rather than by fragments. The fragment form asserted
        // "/subscription/***" and "[query-redacted]", which are the shapes the
        // deleted local redactor produced; after the deep-link summary was
        // routed through the one redactor those asserts could not hold, and the
        // test failed deterministically for anyone who ran it. It failed
        // silently in the sense that mattered: CI only runs
        // `--lib runtime_boundary_tests`, and this module was named `tests`.
        assert_eq!(
            summary,
            "scheme=xxlink, has_url=true, has_name=true, subscription_url=https://api.xxlink.net/***?***"
        );
        assert!(!summary.contains("secret-token"));
        assert!(!summary.contains("format=clash"));
        assert!(!summary.contains("token=abc123"));
    }

    #[test]
    fn invalid_deep_link_log_summary_hides_raw_payload() {
        let summary =
            redacted_deep_link_for_log("not a url https://api.xxlink.net/subscription/secret-token?format=clash");

        assert!(summary.contains("scheme=<invalid>"));
        assert!(!summary.contains("secret-token"));
        assert!(!summary.contains("format=clash"));
        assert!(!summary.contains("https://"));
    }

    #[test]
    fn missing_url_log_summary_does_not_include_other_query_values() -> Result<(), String> {
        let link = Url::parse("xxlink://install?name=secret-name")
            .map_err(|err| format!("test deep link should parse: {err}"))?;
        let summary = redacted_deep_link_url_summary(&link);

        assert!(summary.contains("has_url=false"));
        assert!(summary.contains("has_name=true"));
        assert!(summary.contains("subscription_url=<missing>"));
        assert!(!summary.contains("secret-name"));
        Ok(())
    }

    // The local redactor this replaced masked a path segment only when it
    // exceeded eight bytes, so "short" survived while a longer token did not --
    // and that threshold was the very thing M10 corrected in `mask_url` and
    // never in this file. There is no threshold to get wrong now.
    #[test]
    fn deep_link_subscription_url_goes_through_the_one_redactor() {
        assert_eq!(
            help::mask_url("https://api.xxlink.net/subscription/short?format=clash"),
            "https://api.xxlink.net/***?***"
        );
        assert_eq!(help::mask_url("vmess://Q0FOQVJZUEFZTE9BRA"), "vmess:***");
    }
}
