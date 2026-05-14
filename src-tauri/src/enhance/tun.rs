use serde_yaml_ng::{Mapping, Value};

#[cfg(target_os = "macos")]
use crate::process::AsyncHandler;

macro_rules! revise {
    ($map: expr, $key: expr, $val: expr) => {
        let ret_key = Value::String($key.into());
        $map.insert(ret_key, Value::from($val));
    };
}

// if key not exists then append value
#[allow(unused_macros)]
macro_rules! append {
    ($map: expr, $key: expr, $val: expr) => {
        let ret_key = Value::String($key.into());
        if !$map.contains_key(&ret_key) {
            $map.insert(ret_key, Value::from($val));
        }
    };
}

fn string_sequence(values: &[&str]) -> Value {
    Value::Sequence(values.iter().map(|value| Value::String((*value).into())).collect())
}

pub fn use_tun(mut config: Mapping, enable: bool) -> Mapping {
    let tun_key = Value::from("tun");
    let tun_val = config.get(&tun_key);
    let mut tun_val = tun_val.map_or_else(Mapping::new, |val| {
        val.as_mapping().cloned().unwrap_or_else(Mapping::new)
    });

    if enable {
        // 读取DNS配置
        let dns_key = Value::from("dns");
        let dns_val = config.get(&dns_key);
        let mut dns_val = dns_val.map_or_else(Mapping::new, |val| {
            val.as_mapping().cloned().unwrap_or_else(Mapping::new)
        });
        // Windows desktop apps can prefer IPv6. Keep the generated TUN runtime
        // IPv4-only until the client owns an explicit IPv6 route.
        revise!(config, "ipv6", false);
        let ipv6_val = false;

        // 检查现有的 enhanced-mode 设置
        let current_mode = dns_val
            .get(Value::from("enhanced-mode"))
            .and_then(|v| v.as_str())
            .unwrap_or("fake-ip")
            .to_owned();

        revise!(dns_val, "enable", true);
        revise!(dns_val, "ipv6", ipv6_val);
        revise!(dns_val, "respect-rules", false);
        revise!(dns_val, "prefer-h3", false);
        revise!(dns_val, "use-hosts", false);
        revise!(dns_val, "use-system-hosts", false);
        revise!(
            dns_val,
            "default-nameserver",
            string_sequence(&["223.5.5.5", "8.8.8.8"])
        );
        revise!(
            dns_val,
            "nameserver",
            string_sequence(&["https://1.1.1.1/dns-query", "https://8.8.8.8/dns-query"])
        );
        revise!(
            dns_val,
            "proxy-server-nameserver",
            string_sequence(&[
                "https://doh.pub/dns-query",
                "https://dns.alidns.com/dns-query",
                "tls://223.5.5.5",
            ])
        );
        revise!(dns_val, "direct-nameserver", Value::Sequence(vec![]));
        revise!(dns_val, "direct-nameserver-follow-policy", false);

        // Preserve an explicit redir-host setup, but default desktop TUN to
        // fake-ip when the user did not choose another supported mode.
        if current_mode == "fake-ip" || !dns_val.contains_key(Value::from("enhanced-mode")) {
            if !dns_val.contains_key(Value::from("enhanced-mode")) {
                revise!(dns_val, "enhanced-mode", "fake-ip");
            }

            if !dns_val.contains_key(Value::from("fake-ip-range")) {
                revise!(dns_val, "fake-ip-range", "198.18.0.1/16");
            }

            #[cfg(target_os = "macos")]
            {
                AsyncHandler::spawn(move || async move {
                    crate::utils::resolve::dns::restore_public_dns().await;
                    crate::utils::resolve::dns::set_public_dns("114.114.114.114".to_string()).await;
                });
            }
        }

        // 当TUN启用时，将修改后的DNS配置写回
        revise!(config, "dns", dns_val);
    } else {
        // TUN未启用时，仅恢复系统DNS，不修改配置文件中的DNS设置
        #[cfg(target_os = "macos")]
        AsyncHandler::spawn(move || async move {
            crate::utils::resolve::dns::restore_public_dns().await;
        });
    }

    // 更新TUN配置
    revise!(tun_val, "enable", enable);
    if enable {
        revise!(tun_val, "strict-route", true);
    }
    revise!(config, "tun", tun_val);

    config
}
