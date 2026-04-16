use serde_yaml_ng::{Mapping, Value};
use smartstring::alias::String;
use std::collections::HashSet;

pub const HANDLE_FIELDS: [&str; 12] = [
    "mode",
    "redir-port",
    "tproxy-port",
    "mixed-port",
    "socks-port",
    "port",
    "allow-lan",
    "log-level",
    "ipv6",
    "external-controller",
    "secret",
    "unified-delay",
];

pub const DEFAULT_FIELDS: [&str; 5] = ["proxies", "proxy-providers", "proxy-groups", "rule-providers", "rules"];

pub fn use_sort(config: Mapping) -> Mapping {
    let mut ret = Mapping::new();
    HANDLE_FIELDS.into_iter().for_each(|key| {
        let key = Value::from(key);
        if let Some(value) = config.get(&key) {
            ret.insert(key, value.clone());
        }
    });

    let supported_keys: HashSet<&str> = HANDLE_FIELDS.into_iter().chain(DEFAULT_FIELDS).collect();

    let config_keys: HashSet<&str> = config.keys().filter_map(|e| e.as_str()).collect();

    config_keys.difference(&supported_keys).for_each(|&key| {
        let key = Value::from(key);
        if let Some(value) = config.get(&key) {
            ret.insert(key, value.clone());
        }
    });
    DEFAULT_FIELDS.into_iter().for_each(|key| {
        let key = Value::from(key);
        if let Some(value) = config.get(&key) {
            ret.insert(key, value.clone());
        }
    });

    ret
}

#[inline]
pub fn use_keys<'a>(config: &'a Mapping) -> impl Iterator<Item = String> + 'a {
    config.iter().filter_map(|(key, _)| key.as_str()).map(|s: &str| {
        let mut s: String = s.into();
        s.make_ascii_lowercase();
        s
    })
}
