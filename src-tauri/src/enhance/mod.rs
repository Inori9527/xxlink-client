pub mod field;
mod tun;

use self::{
    field::{use_keys, use_sort},
    tun::use_tun,
};
use crate::utils::dirs;
use crate::{config::Config, constants};
use serde_yaml_ng::{Mapping, Value};
use smartstring::alias::String;
use std::collections::{HashMap, HashSet};
use tokio::fs;
use xxlink_logging::{Type, logging};

type ResultLog = Vec<(String, String)>;

const ADOBE_DOMAIN_SUFFIXES: &[&str] = &["adobe.com", "adobe.io", "adobecc.com", "adobelogin.com"];
const ADOBE_DOMAINS: &[&str] = &[
    "firefly.adobe.com",
    "creativecloud.adobe.com",
    "cc-api-data.adobe.io",
    "ims-na1.adobelogin.com",
    "assets.adobe.com",
    "lcs-cops.adobe.io",
    "p13n.adobe.io",
];
const ADOBE_PROCESS_NAMES: &[&str] = &[
    "Photoshop.exe",
    "Creative Cloud.exe",
    "CCXProcess.exe",
    "CoreSync.exe",
    "Adobe Desktop Service.exe",
    "AdobeIPCBroker.exe",
];
const DESKTOP_COMPAT_POLICY: &str = "XXLink-Desktop";
const GLOBAL_POLICY: &str = "GLOBAL";
const SMART_SPLIT_DIRECT_RULES: &[&str] = &["GEOSITE,cn,DIRECT", "GEOIP,CN,DIRECT,no-resolve"];
const SMART_SPLIT_FALLBACK_RULE: &str = "MATCH,GLOBAL";

#[derive(Debug)]
struct ConfigValues {
    clash_config: Mapping,
    enable_tun: bool,
    socks_enabled: bool,
    http_enabled: bool,
    enable_dns_settings: bool,
    connect_mode: Option<String>,
    #[cfg(not(target_os = "windows"))]
    redir_enabled: bool,
    #[cfg(target_os = "linux")]
    tproxy_enabled: bool,
}

async fn get_config_values() -> ConfigValues {
    let clash = Config::clash().await;
    let clash_arc = clash.latest_arc();
    let clash_config = clash_arc.0.clone();
    drop(clash_arc);
    drop(clash);

    let verge = Config::verge().await;
    let verge_arc = verge.latest_arc();
    let enable_tun = verge_arc.enable_tun_mode.unwrap_or(false);
    let socks_enabled = verge_arc.verge_socks_enabled.unwrap_or(false);
    let http_enabled = verge_arc.verge_http_enabled.unwrap_or(false);
    let enable_dns_settings = verge_arc.enable_dns_settings.unwrap_or(false);
    let connect_mode = verge_arc.connect_mode.clone();

    #[cfg(not(target_os = "windows"))]
    let redir_enabled = verge_arc.verge_redir_enabled.unwrap_or(false);

    #[cfg(target_os = "linux")]
    let tproxy_enabled = verge_arc.verge_tproxy_enabled.unwrap_or(false);

    drop(verge_arc);
    drop(verge);

    ConfigValues {
        clash_config,
        enable_tun,
        socks_enabled,
        http_enabled,
        enable_dns_settings,
        connect_mode,
        #[cfg(not(target_os = "windows"))]
        redir_enabled,
        #[cfg(target_os = "linux")]
        tproxy_enabled,
    }
}

async fn collect_current_config() -> Mapping {
    let profiles = Config::profiles().await;
    let profiles_arc = profiles.latest_arc();
    drop(profiles);

    let current = profiles_arc.current_mapping().await.unwrap_or_default();
    drop(profiles_arc);
    current
}

async fn merge_default_config(
    mut config: Mapping,
    clash_config: Mapping,
    socks_enabled: bool,
    http_enabled: bool,
    #[cfg(not(target_os = "windows"))] redir_enabled: bool,
    #[cfg(target_os = "linux")] tproxy_enabled: bool,
) -> Mapping {
    for (key, value) in clash_config.into_iter() {
        if key.as_str() == Some("tun") {
            let mut tun = config.get_mut("tun").map_or_else(Mapping::new, |val| {
                val.as_mapping().cloned().unwrap_or_else(Mapping::new)
            });
            let patch_tun = value.as_mapping().cloned().unwrap_or_else(Mapping::new);
            for (key, value) in patch_tun.into_iter() {
                tun.insert(key, value);
            }
            config.insert("tun".into(), tun.into());
        } else {
            if key.as_str() == Some("socks-port") && !socks_enabled {
                config.remove("socks-port");
                continue;
            }
            if key.as_str() == Some("port") && !http_enabled {
                config.remove("port");
                continue;
            }
            #[cfg(target_os = "windows")]
            {
                if key.as_str() == Some("redir-port") {
                    continue;
                }
            }
            #[cfg(not(target_os = "windows"))]
            {
                if key.as_str() == Some("redir-port") && !redir_enabled {
                    config.remove("redir-port");
                    continue;
                }
            }
            #[cfg(target_os = "linux")]
            {
                if key.as_str() == Some("tproxy-port") && !tproxy_enabled {
                    config.remove("tproxy-port");
                    continue;
                }
            }
            #[cfg(not(target_os = "linux"))]
            {
                if key.as_str() == Some("tproxy-port") {
                    config.remove("tproxy-port");
                    continue;
                }
            }
            // 处理 external-controller 键的开关逻辑
            if key.as_str() == Some("external-controller") {
                let enable_external_controller = Config::verge()
                    .await
                    .latest_arc()
                    .enable_external_controller
                    .unwrap_or(false);

                if enable_external_controller {
                    config.insert(key, value);
                } else {
                    // 如果禁用了外部控制器，设置为空字符串
                    config.insert(key, "".into());
                }
            } else {
                config.insert(key, value);
            }
        }
    }

    config
}

fn cleanup_proxy_groups(mut config: Mapping) -> Mapping {
    const BUILTIN_POLICIES: &[&str] = &["DIRECT", "REJECT", "REJECT-DROP", "PASS"];

    let proxy_names = config
        .get("proxies")
        .and_then(|v| v.as_sequence())
        .map(|seq| {
            seq.iter()
                .filter_map(|item| match item {
                    Value::Mapping(map) => map
                        .get("name")
                        .and_then(Value::as_str)
                        .map(|name| name.to_owned().into()),
                    Value::String(name) => Some(name.to_owned().into()),
                    _ => None,
                })
                .collect::<HashSet<String>>()
        })
        .unwrap_or_default();

    let group_names = config
        .get("proxy-groups")
        .and_then(|v| v.as_sequence())
        .map(|seq| {
            seq.iter()
                .filter_map(|item| {
                    item.as_mapping()
                        .and_then(|map| map.get("name"))
                        .and_then(Value::as_str)
                        .map(std::convert::Into::into)
                })
                .collect::<HashSet<String>>()
        })
        .unwrap_or_default();

    let provider_names = config
        .get("proxy-providers")
        .and_then(Value::as_mapping)
        .map(|map| {
            map.keys()
                .filter_map(Value::as_str)
                .map(std::convert::Into::into)
                .collect::<HashSet<String>>()
        })
        .unwrap_or_default();

    let mut allowed_names = proxy_names;
    allowed_names.extend(group_names);
    allowed_names.extend(provider_names.iter().cloned());
    allowed_names.extend(BUILTIN_POLICIES.iter().map(|p| (*p).into()));

    if let Some(Value::Sequence(groups)) = config.get_mut("proxy-groups") {
        for group in groups {
            if let Some(group_map) = group.as_mapping_mut() {
                let mut has_valid_provider = false;

                if let Some(Value::Sequence(uses)) = group_map.get_mut("use") {
                    uses.retain(|provider| match provider {
                        Value::String(name) => {
                            let exists = provider_names.contains(name.as_str());
                            has_valid_provider = has_valid_provider || exists;
                            exists
                        }
                        _ => false,
                    });
                }

                if let Some(Value::Sequence(proxies)) = group_map.get_mut("proxies") {
                    proxies.retain(|proxy| match proxy {
                        Value::String(name) => allowed_names.contains(name.as_str()) || has_valid_provider,
                        _ => true,
                    });
                }
            }
        }
    }

    config
}

async fn apply_dns_settings(mut config: Mapping, enable_dns_settings: bool) -> Mapping {
    if enable_dns_settings && let Ok(app_dir) = dirs::app_home_dir() {
        let dns_path = app_dir.join(constants::files::DNS_CONFIG);

        if dns_path.exists()
            && let Ok(dns_yaml) = fs::read_to_string(&dns_path).await
            && let Ok(dns_config) = serde_yaml_ng::from_str::<serde_yaml_ng::Mapping>(&dns_yaml)
        {
            if let Some(hosts_value) = dns_config.get("hosts")
                && hosts_value.is_mapping()
            {
                config.insert("hosts".into(), hosts_value.clone());
                logging!(info, Type::Core, "apply hosts configuration");
            }

            if let Some(dns_value) = dns_config.get("dns") {
                if let Some(dns_mapping) = dns_value.as_mapping() {
                    config.insert("dns".into(), dns_mapping.clone().into());
                    logging!(info, Type::Core, "apply dns_config.yaml (dns section)");
                }
            } else {
                config.insert("dns".into(), dns_config.into());
                logging!(info, Type::Core, "apply dns_config.yaml");
            }
        }
    }

    config
}

fn is_builtin_policy(name: &str) -> bool {
    matches!(name, "DIRECT" | "REJECT" | "REJECT-DROP" | "PASS")
}

fn collect_leaf_proxy_names(config: &Mapping) -> Vec<std::string::String> {
    config
        .get("proxies")
        .and_then(Value::as_sequence)
        .map(|items| {
            items
                .iter()
                .filter_map(|item| match item {
                    Value::Mapping(map) => map.get("name").and_then(Value::as_str),
                    Value::String(name) => Some(name.as_str()),
                    _ => None,
                })
                .filter(|name| !is_builtin_policy(name))
                .map(ToOwned::to_owned)
                .collect::<Vec<std::string::String>>()
        })
        .unwrap_or_default()
}

fn collect_provider_names(config: &Mapping) -> Vec<std::string::String> {
    config
        .get("proxy-providers")
        .and_then(Value::as_mapping)
        .map(|providers| {
            providers
                .keys()
                .filter_map(Value::as_str)
                .map(ToOwned::to_owned)
                .collect::<Vec<std::string::String>>()
        })
        .unwrap_or_default()
}

fn ensure_desktop_compatibility_group(config: &mut Mapping) -> Option<String> {
    let proxy_names = collect_leaf_proxy_names(config);
    let provider_names = collect_provider_names(config);
    if proxy_names.is_empty() && provider_names.is_empty() {
        return None;
    }

    let mut group = Mapping::new();
    group.insert("name".into(), DESKTOP_COMPAT_POLICY.into());
    group.insert("type".into(), "select".into());
    if !proxy_names.is_empty() {
        group.insert(
            "proxies".into(),
            Value::Sequence(proxy_names.into_iter().map(Value::String).collect()),
        );
    }
    if !provider_names.is_empty() {
        group.insert(
            "use".into(),
            Value::Sequence(provider_names.into_iter().map(Value::String).collect()),
        );
    }

    let groups_key = Value::from("proxy-groups");
    let mut groups = config
        .remove(&groups_key)
        .and_then(|value| value.as_sequence().cloned())
        .unwrap_or_default();
    groups.retain(|item| {
        item.get("name")
            .and_then(Value::as_str)
            .is_none_or(|name| name != DESKTOP_COMPAT_POLICY)
    });
    groups.insert(0, Value::Mapping(group));
    config.insert(groups_key, Value::Sequence(groups));

    Some(DESKTOP_COMPAT_POLICY.into())
}

fn apply_desktop_compatibility_rules(mut config: Mapping) -> Mapping {
    let Some(policy) = ensure_desktop_compatibility_group(&mut config) else {
        return config;
    };

    let rules_key = Value::from("rules");
    let mut rules = config
        .remove(&rules_key)
        .and_then(|value| value.as_sequence().cloned())
        .unwrap_or_default();
    let existing = rules
        .iter()
        .filter_map(Value::as_str)
        .map(|rule| rule.to_ascii_lowercase())
        .collect::<HashSet<_>>();

    let mut compatibility_rules = Vec::new();
    for process in ADOBE_PROCESS_NAMES {
        let rule = format!("PROCESS-NAME,{process},{policy}");
        if !existing.contains(&rule.to_ascii_lowercase()) {
            compatibility_rules.push(Value::String(rule));
        }
    }
    for domain in ADOBE_DOMAINS {
        let rule = format!("DOMAIN,{domain},{policy}");
        if !existing.contains(&rule.to_ascii_lowercase()) {
            compatibility_rules.push(Value::String(rule));
        }
    }
    for suffix in ADOBE_DOMAIN_SUFFIXES {
        let rule = format!("DOMAIN-SUFFIX,{suffix},{policy}");
        if !existing.contains(&rule.to_ascii_lowercase()) {
            compatibility_rules.push(Value::String(rule));
        }
    }

    if !compatibility_rules.is_empty() {
        logging!(info, Type::Core, "apply desktop compatibility routing rules");
    }

    compatibility_rules.append(&mut rules);
    config.insert(rules_key, Value::Sequence(compatibility_rules));
    config
}

fn ensure_global_proxy_group(config: &mut Mapping) -> bool {
    let groups_key = Value::from("proxy-groups");
    let mut groups = config
        .remove(&groups_key)
        .and_then(|value| value.as_sequence().cloned())
        .unwrap_or_default();

    if groups
        .iter()
        .any(|item| item.get("name").and_then(Value::as_str) == Some(GLOBAL_POLICY))
    {
        config.insert(groups_key, Value::Sequence(groups));
        return true;
    }

    let proxy_names = collect_leaf_proxy_names(config);
    let provider_names = collect_provider_names(config);
    if proxy_names.is_empty() && provider_names.is_empty() {
        config.insert(groups_key, Value::Sequence(groups));
        return false;
    }

    let mut group = Mapping::new();
    group.insert("name".into(), GLOBAL_POLICY.into());
    group.insert("type".into(), "select".into());
    if !proxy_names.is_empty() {
        group.insert(
            "proxies".into(),
            Value::Sequence(proxy_names.into_iter().map(Value::String).collect()),
        );
    }
    if !provider_names.is_empty() {
        group.insert(
            "use".into(),
            Value::Sequence(provider_names.into_iter().map(Value::String).collect()),
        );
    }

    groups.insert(0, Value::Mapping(group));
    config.insert(groups_key, Value::Sequence(groups));
    true
}

fn rule_kind(rule: &str) -> std::string::String {
    rule.split(',').next().unwrap_or_default().trim().to_ascii_uppercase()
}

fn is_terminal_rule(rule: &str) -> bool {
    matches!(rule_kind(rule).as_str(), "MATCH" | "FINAL")
}

fn should_apply_smart_split(connect_mode: Option<&str>) -> bool {
    connect_mode.is_some_and(|mode| mode.eq_ignore_ascii_case("smart"))
}

fn apply_smart_split_rules(mut config: Mapping, connect_mode: Option<&str>) -> Mapping {
    if !should_apply_smart_split(connect_mode) {
        return config;
    }
    if !ensure_global_proxy_group(&mut config) {
        return config;
    }

    config.insert("mode".into(), "rule".into());

    let rules_key = Value::from("rules");
    let rules = config
        .remove(&rules_key)
        .and_then(|value| value.as_sequence().cloned())
        .unwrap_or_default();

    let smart_rule_set = SMART_SPLIT_DIRECT_RULES
        .iter()
        .chain(std::iter::once(&SMART_SPLIT_FALLBACK_RULE))
        .map(|rule| rule.to_ascii_lowercase())
        .collect::<HashSet<_>>();
    let mut seen = HashSet::new();
    let mut next_rules = Vec::new();

    for rule in SMART_SPLIT_DIRECT_RULES {
        seen.insert(rule.to_ascii_lowercase());
        next_rules.push(Value::String((*rule).into()));
    }

    for rule in rules {
        let Some(rule_str) = rule.as_str() else {
            next_rules.push(rule);
            continue;
        };
        let normalized = rule_str.trim().to_ascii_lowercase();
        if normalized.is_empty()
            || smart_rule_set.contains(&normalized)
            || is_terminal_rule(rule_str)
            || !seen.insert(normalized)
        {
            continue;
        }
        next_rules.push(rule);
    }

    next_rules.push(Value::String(SMART_SPLIT_FALLBACK_RULE.into()));
    logging!(info, Type::Core, "apply smart split routing rules");
    config.insert(rules_key, Value::Sequence(next_rules));
    config
}

/// Enhance mode
/// 返回最终订阅、该订阅包含的键、和script执行的结果
pub async fn enhance() -> (Mapping, HashSet<String>, HashMap<String, ResultLog>) {
    // gather config values
    let cfg_vals = get_config_values().await;
    let ConfigValues {
        clash_config,
        enable_tun,
        socks_enabled,
        http_enabled,
        enable_dns_settings,
        connect_mode,
        #[cfg(not(target_os = "windows"))]
        redir_enabled,
        #[cfg(target_os = "linux")]
        tproxy_enabled,
    } = cfg_vals;

    // collect current subscription config
    let config = collect_current_config().await;
    let exists_keys: Vec<String> = use_keys(&config).collect();

    // merge default clash config
    let config = merge_default_config(
        config,
        clash_config,
        socks_enabled,
        http_enabled,
        #[cfg(not(target_os = "windows"))]
        redir_enabled,
        #[cfg(target_os = "linux")]
        tproxy_enabled,
    )
    .await;

    let mut config = cleanup_proxy_groups(config);

    config = use_sort(config);

    // User DNS settings are loaded first; TUN then applies final guardrails so
    // app-level DNS overrides cannot reopen desktop DNS/IPv6 leaks.
    config = apply_dns_settings(config, enable_dns_settings).await;
    config = use_tun(config, enable_tun);
    config = apply_smart_split_rules(config, connect_mode.as_deref());
    config = apply_desktop_compatibility_rules(config);

    let mut exists_keys_set = HashSet::new();
    exists_keys_set.extend(exists_keys);

    (config, exists_keys_set, HashMap::new())
}

#[allow(clippy::expect_used)]
#[cfg(test)]
mod tests {
    use super::{apply_smart_split_rules, cleanup_proxy_groups};

    #[test]
    fn remove_missing_proxies_from_groups() {
        let config_str = r#"
proxies:
  - name: "alive-node"
    type: ss
proxy-groups:
  - name: "manual"
    type: select
    proxies:
      - "alive-node"
      - "missing-node"
      - "DIRECT"
  - name: "nested"
    type: select
    proxies:
      - "manual"
      - "ghost"
"#;

        let mut config: serde_yaml_ng::Mapping =
            serde_yaml_ng::from_str(config_str).expect("Failed to parse test yaml");
        config = cleanup_proxy_groups(config);

        let groups = config
            .get("proxy-groups")
            .and_then(|v| v.as_sequence())
            .cloned()
            .expect("proxy-groups should be a sequence");

        let manual_group = groups
            .iter()
            .find(|group| group.get("name").and_then(serde_yaml_ng::Value::as_str) == Some("manual"))
            .and_then(|group| group.as_mapping())
            .expect("manual group should exist");

        let manual_proxies = manual_group
            .get("proxies")
            .and_then(|v| v.as_sequence())
            .expect("manual proxies should be a sequence");

        assert_eq!(manual_proxies.len(), 2);
        assert!(manual_proxies.iter().any(|p| p.as_str() == Some("alive-node")));
        assert!(manual_proxies.iter().any(|p| p.as_str() == Some("DIRECT")));

        let nested_group = groups
            .iter()
            .find(|group| group.get("name").and_then(serde_yaml_ng::Value::as_str) == Some("nested"))
            .and_then(|group| group.as_mapping())
            .expect("nested group should exist");

        let nested_proxies = nested_group
            .get("proxies")
            .and_then(|v| v.as_sequence())
            .expect("nested proxies should be a sequence");

        assert_eq!(nested_proxies.len(), 1);
        assert_eq!(nested_proxies[0].as_str(), Some("manual"));
    }

    #[test]
    fn keep_provider_backed_groups_intact() {
        let config_str = r#"
proxy-providers:
  providerA:
    type: http
    url: https://example.com
    path: ./providerA.yaml
proxies: []
proxy-groups:
  - name: "manual"
    type: select
    use:
      - "providerA"
      - "ghostProvider"
    proxies:
      - "dynamic-node"
      - "DIRECT"
"#;

        let mut config: serde_yaml_ng::Mapping =
            serde_yaml_ng::from_str(config_str).expect("Failed to parse test yaml");
        config = cleanup_proxy_groups(config);

        let groups = config
            .get("proxy-groups")
            .and_then(|v| v.as_sequence())
            .cloned()
            .expect("proxy-groups should be a sequence");

        let manual_group = groups
            .iter()
            .find(|group| group.get("name").and_then(serde_yaml_ng::Value::as_str) == Some("manual"))
            .and_then(|group| group.as_mapping())
            .expect("manual group should exist");

        let uses = manual_group
            .get("use")
            .and_then(|v| v.as_sequence())
            .expect("use should be a sequence");
        assert_eq!(uses.len(), 1);
        assert_eq!(uses[0].as_str(), Some("providerA"));

        let proxies = manual_group
            .get("proxies")
            .and_then(|v| v.as_sequence())
            .expect("proxies should be a sequence");
        assert_eq!(proxies.len(), 2);
        assert!(proxies.iter().any(|p| p.as_str() == Some("dynamic-node")));
        assert!(proxies.iter().any(|p| p.as_str() == Some("DIRECT")));
    }

    #[test]
    fn prune_invalid_provider_and_proxies_without_provider() {
        let config_str = r#"
proxy-groups:
  - name: "manual"
    type: select
    use:
      - "ghost-provider"
    proxies:
      - "ghost-node"
      - "DIRECT"
"#;

        let mut config: serde_yaml_ng::Mapping =
            serde_yaml_ng::from_str(config_str).expect("Failed to parse test yaml");
        config = cleanup_proxy_groups(config);

        let groups = config
            .get("proxy-groups")
            .and_then(|v| v.as_sequence())
            .cloned()
            .expect("proxy-groups should be a sequence");

        let manual_group = groups
            .iter()
            .find(|group| group.get("name").and_then(serde_yaml_ng::Value::as_str) == Some("manual"))
            .and_then(|group| group.as_mapping())
            .expect("manual group should exist");

        let uses = manual_group
            .get("use")
            .and_then(|v| v.as_sequence())
            .expect("use should be a sequence");
        assert_eq!(uses.len(), 0);

        let proxies = manual_group
            .get("proxies")
            .and_then(|v| v.as_sequence())
            .expect("proxies should be a sequence");
        assert_eq!(proxies.len(), 1);
        assert_eq!(proxies[0].as_str(), Some("DIRECT"));
    }

    #[test]
    fn smart_split_prepends_cn_direct_and_replaces_terminal_rule() {
        let config_str = r"
mode: rule
proxies:
  - name: node-a
    type: ss
rules:
  - DOMAIN,example.com,SomePolicy
  - MATCH,DIRECT
";

        let config: serde_yaml_ng::Mapping = serde_yaml_ng::from_str(config_str).expect("Failed to parse test yaml");
        let config = apply_smart_split_rules(config, Some("smart"));
        let rules = config
            .get("rules")
            .and_then(|v| v.as_sequence())
            .expect("rules should be a sequence");

        let rules = rules
            .iter()
            .filter_map(serde_yaml_ng::Value::as_str)
            .collect::<Vec<_>>();
        assert_eq!(rules[0], "GEOSITE,cn,DIRECT");
        assert_eq!(rules[1], "GEOIP,CN,DIRECT,no-resolve");
        assert!(rules.contains(&"DOMAIN,example.com,SomePolicy"));
        assert_eq!(rules.last(), Some(&"MATCH,GLOBAL"));
        assert!(!rules.contains(&"MATCH,DIRECT"));
    }

    #[test]
    fn smart_split_does_not_change_when_client_mode_is_not_smart() {
        let config_str = r"
mode: rule
rules:
  - MATCH,DIRECT
";

        let config: serde_yaml_ng::Mapping = serde_yaml_ng::from_str(config_str).expect("Failed to parse test yaml");
        let config = apply_smart_split_rules(config, Some("both"));
        let rules = config
            .get("rules")
            .and_then(|v| v.as_sequence())
            .expect("rules should be a sequence");

        assert_eq!(rules.len(), 1);
        assert_eq!(rules[0].as_str(), Some("MATCH,DIRECT"));
    }
}
