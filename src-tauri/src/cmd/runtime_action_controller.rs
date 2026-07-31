use super::CmdResult;
use crate::{
    config::{Config, IVerge, PrfItem, PrfSelected, profiles::profiles_patch_item_safe},
    core::{CoreManager, handle, sysopt, tray},
    feat,
};
use once_cell::sync::Lazy;
use serde::{Deserialize, Serialize};
use serde_yaml_ng::{Mapping, Value};
use smartstring::alias::String;
use std::{net::IpAddr, str::FromStr as _, time::Duration};
use tauri::AppHandle;
use tauri_plugin_clipboard_manager::ClipboardExt as _;
use tauri_plugin_updater::{Update, UpdaterExt as _};
use tokio::sync::Mutex;

const MAX_NODE_LABEL_BYTES: usize = 512;
const MAX_TUN_DEVICE_BYTES: usize = 128;
const MAX_TUN_LIST_ITEMS: usize = 64;
const MAX_TUN_LIST_ITEM_BYTES: usize = 256;
const MAX_PROXY_BYPASS_BYTES: usize = 32 * 1024;
const MAX_PAC_CONTENT_BYTES: usize = 256 * 1024;
const MAX_PROXY_HOST_BYTES: usize = 512;
const MAX_PROXY_GUARD_DURATION_SECS: u64 = 86_400;
const DEFAULT_MAX_LOG_ITEMS: i64 = 50;
const MAX_LOG_ITEMS: i64 = 200;
const MAX_DIAGNOSTIC_COUNT: u32 = 1_000_000;
const MAX_SAFE_INTEGER: u64 = 9_007_199_254_740_991;
const MAX_CLASSIFIABLE_TEXT_LENGTH: usize = 1024;
static PENDING_UPDATE: Lazy<Mutex<Option<Update>>> = Lazy::new(|| Mutex::new(None));
static TUN_SETTINGS_MUTATION_LOCK: Mutex<()> = Mutex::const_new(());
static NODE_SELECTION_LOCK: Mutex<()> = Mutex::const_new(());

#[derive(Clone, Copy, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "lowercase")]
pub(super) enum DiagnosticLogSource {
    Runtime,
    Clash,
}

#[derive(Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct DiagnosticLevelCounts {
    debug: u32,
    info: u32,
    warn: u32,
    error: u32,
    unknown: u32,
}

impl DiagnosticLevelCounts {
    const fn empty() -> Self {
        Self {
            debug: 0,
            info: 0,
            warn: 0,
            error: 0,
            unknown: 0,
        }
    }

    const fn total(&self) -> u64 {
        self.debug as u64 + self.info as u64 + self.warn as u64 + self.error as u64 + self.unknown as u64
    }

    fn increment(&mut self, level: &str) {
        let target = match normalize_log_level(level) {
            "debug" => &mut self.debug,
            "info" => &mut self.info,
            "warn" => &mut self.warn,
            "error" => &mut self.error,
            _ => &mut self.unknown,
        };
        *target += 1;
    }
}

#[derive(Deserialize, Serialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct DiagnosticCategoryCounts {
    #[serde(rename = "auth-session")]
    auth_session: u32,
    network: u32,
    #[serde(rename = "profile-sync")]
    profile_sync: u32,
    timeout: u32,
    storage: u32,
    #[serde(rename = "structured-or-sensitive")]
    structured_or_sensitive: u32,
    oversized: u32,
    other: u32,
    unrecognized: u32,
}

impl DiagnosticCategoryCounts {
    const fn empty() -> Self {
        Self {
            auth_session: 0,
            network: 0,
            profile_sync: 0,
            timeout: 0,
            storage: 0,
            structured_or_sensitive: 0,
            oversized: 0,
            other: 0,
            unrecognized: 0,
        }
    }

    const fn total(&self) -> u64 {
        self.auth_session as u64
            + self.network as u64
            + self.profile_sync as u64
            + self.timeout as u64
            + self.storage as u64
            + self.structured_or_sensitive as u64
            + self.oversized as u64
            + self.other as u64
            + self.unrecognized as u64
    }

    fn increment(&mut self, message: &str) {
        let target = match classify_diagnostic_text(message) {
            "auth-session" => &mut self.auth_session,
            "network" => &mut self.network,
            "profile-sync" => &mut self.profile_sync,
            "timeout" => &mut self.timeout,
            "storage" => &mut self.storage,
            "structured-or-sensitive" => &mut self.structured_or_sensitive,
            "oversized" => &mut self.oversized,
            "other" => &mut self.other,
            _ => &mut self.unrecognized,
        };
        *target += 1;
    }
}

#[derive(Deserialize, Serialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct DiagnosticLogSummary {
    source: DiagnosticLogSource,
    component_count: u32,
    total_count: u32,
    inspected_count: u32,
    omitted_count: u32,
    levels: DiagnosticLevelCounts,
    categories: DiagnosticCategoryCounts,
}

impl DiagnosticLogSummary {
    fn validate(&self, expected_source: DiagnosticLogSource) -> bool {
        self.source == expected_source
            && self.component_count <= MAX_DIAGNOSTIC_COUNT
            && self.total_count <= MAX_DIAGNOSTIC_COUNT
            && self.inspected_count <= MAX_DIAGNOSTIC_COUNT
            && self.omitted_count <= MAX_DIAGNOSTIC_COUNT
            && self.inspected_count.saturating_add(self.omitted_count) == self.total_count
            && self.levels.total() == u64::from(self.inspected_count)
            && self.categories.total() == u64::from(self.inspected_count)
    }
}

#[derive(Serialize)]
pub struct DiagnosticsLogSummaries {
    runtime: DiagnosticLogSummary,
    clash: DiagnosticLogSummary,
}

pub(super) fn summarize_diagnostic_entries(
    source: DiagnosticLogSource,
    component_count: usize,
    entries: Vec<(&str, &str)>,
    max_items: usize,
) -> DiagnosticLogSummary {
    let total_count = entries.len().min(MAX_DIAGNOSTIC_COUNT as usize) as u32;
    let inspected_count = max_items.min(total_count as usize);
    let mut levels = DiagnosticLevelCounts::empty();
    let mut categories = DiagnosticCategoryCounts::empty();
    for (level, message) in entries.iter().skip(entries.len().saturating_sub(inspected_count)) {
        levels.increment(level);
        categories.increment(message);
    }

    DiagnosticLogSummary {
        source,
        component_count: component_count.min(MAX_DIAGNOSTIC_COUNT as usize) as u32,
        total_count,
        inspected_count: inspected_count as u32,
        omitted_count: total_count - inspected_count as u32,
        levels,
        categories,
    }
}

fn normalize_log_level(value: &str) -> &str {
    if value.encode_utf16().count() > 16 {
        return "unknown";
    }
    if value.eq_ignore_ascii_case("warning") {
        return "warn";
    }
    if value.eq_ignore_ascii_case("debug") {
        "debug"
    } else if value.eq_ignore_ascii_case("info") {
        "info"
    } else if value.eq_ignore_ascii_case("warn") {
        "warn"
    } else if value.eq_ignore_ascii_case("error") {
        "error"
    } else {
        "unknown"
    }
}

fn classify_diagnostic_text(value: &str) -> &'static str {
    let trimmed = value.trim();
    if trimmed.is_empty() {
        return "unrecognized";
    }
    if trimmed.encode_utf16().count() > MAX_CLASSIFIABLE_TEXT_LENGTH {
        return "oversized";
    }

    let text = trimmed.to_lowercase();
    if text.contains("://")
        || text.contains("authorization:")
        || text.contains("cookie:")
        || text.contains("password")
        || text.contains("privatekey")
        || text.contains("shortid")
        || text.contains("uuid")
        || text.contains("server:")
        || text.starts_with('{')
        || text.starts_with('[')
        || text.starts_with("- ")
        || text.contains('\n')
    {
        "structured-or-sensitive"
    } else if text.contains("timeout") || text.contains("timed out") {
        "timeout"
    } else if text.contains("auth") || text.contains("session") || text.contains("csrf") || text.contains("token") {
        "auth-session"
    } else if text.contains("network")
        || text.contains("offline")
        || text.contains("fetch")
        || text.contains("connection")
    {
        "network"
    } else if text.contains("profile") || text.contains("subscription") || text.contains("sync") {
        "profile-sync"
    } else if text.contains("storage") || text.contains("localstorage") {
        "storage"
    } else {
        "other"
    }
}

macro_rules! diagnostics_enum {
    ($name:ident { $($variant:ident => $value:literal),+ $(,)? }) => {
        #[derive(Deserialize, Serialize)]
        enum $name {
            $(#[serde(rename = $value)] $variant),+
        }
    };
}

diagnostics_enum!(Presence {
    Present => "present",
    Missing => "missing",
    Unknown => "unknown",
});
diagnostics_enum!(AuthStatus {
    Authenticated => "authenticated",
    Anonymous => "anonymous",
    Unknown => "unknown",
});
diagnostics_enum!(AgeBucket {
    Future => "future",
    LessThan15Minutes => "<15m",
    LessThan1Hour => "<1h",
    LessThan24Hours => "<24h",
    LessThan14Days => "<14d",
    Stale => "stale",
    Unknown => "unknown",
});
diagnostics_enum!(Platform {
    Windows => "windows",
    Macos => "macos",
    Linux => "linux",
    Android => "android",
    Ios => "ios",
    Unknown => "unknown",
});
diagnostics_enum!(UserRole {
    User => "USER",
    Admin => "ADMIN",
    Unknown => "unknown",
});
diagnostics_enum!(SubscriptionStatus {
    Active => "ACTIVE",
    Expired => "EXPIRED",
    Cancelled => "CANCELLED",
    Pending => "PENDING",
    Trial => "TRIAL",
    Unknown => "unknown",
});
diagnostics_enum!(EntitlementClass {
    Free => "FREE",
    Paid => "PAID",
    Trial => "TRIAL",
    AdminUnlimited => "admin-unlimited",
    SpeedLimited => "speed-limited",
    Unknown => "unknown",
});
diagnostics_enum!(ErrorFamily {
    AuthSession => "auth-session",
    Network => "network",
    ProfileSync => "profile-sync",
    Timeout => "timeout",
    Storage => "storage",
    Other => "other",
    None => "none",
    Unknown => "unknown",
});
diagnostics_enum!(NodeSyncStatus {
    OkOrNotRecorded => "ok-or-not-recorded",
    Error => "error",
});
diagnostics_enum!(SelectedNodeStatus {
    Selected => "selected",
    NotSelected => "not-selected",
});
diagnostics_enum!(PresentStatus {
    Present => "present",
    Missing => "missing",
});
diagnostics_enum!(RuntimeCoreStatus {
    Observed => "observed",
    Unknown => "unknown",
});
diagnostics_enum!(RunningMode {
    Rule => "rule",
    Global => "global",
    Direct => "direct",
    Script => "script",
    Unknown => "unknown",
});
diagnostics_enum!(DataPlaneStatus {
    NotTested => "not-tested",
});
diagnostics_enum!(LastCheckStatus {
    Present => "present",
    Unknown => "unknown",
});
diagnostics_enum!(SafetyPolicy {
    MetadataOnly => "metadata-only",
});

#[derive(Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct DiagnosticsApp {
    version: String,
}

#[derive(Deserialize, Serialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct DiagnosticsSystem {
    platform: Platform,
    uptime_ms: Option<u64>,
}

#[derive(Deserialize, Serialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct DiagnosticsAuthSession {
    status: AuthStatus,
    access_token: Presence,
    refresh_token: Presence,
    user_role: UserRole,
}

#[derive(Deserialize, Serialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct DiagnosticsAccount {
    lkg_cache: Presence,
    age_bucket: AgeBucket,
    subscription_status: SubscriptionStatus,
    entitlement_class: EntitlementClass,
    node_count: Option<u32>,
}

#[derive(Deserialize, Serialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct DiagnosticsNodeSync {
    status: NodeSyncStatus,
    last_error_family: ErrorFamily,
}

#[derive(Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct DiagnosticsSelectedNode {
    status: SelectedNodeStatus,
}

#[derive(Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct DiagnosticsProfileGeneration {
    status: PresentStatus,
}

#[derive(Deserialize, Serialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct DiagnosticsRuntimeCore {
    status: RuntimeCoreStatus,
    running_mode: RunningMode,
}

#[derive(Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct DiagnosticsDataPlane {
    status: DataPlaneStatus,
}

#[derive(Deserialize, Serialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct DiagnosticsUpdater {
    current_version_class: String,
    last_check_status: LastCheckStatus,
    last_check_age_bucket: AgeBucket,
}

#[derive(Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct DiagnosticsLogs {
    runtime: DiagnosticLogSummary,
    clash: DiagnosticLogSummary,
}

#[derive(Deserialize, Serialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct DiagnosticsSafety {
    policy: SafetyPolicy,
    raw_text_included: bool,
}

#[derive(Deserialize, Serialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct DiagnosticsBundle {
    schema_version: u8,
    exported_at: String,
    app: DiagnosticsApp,
    system: DiagnosticsSystem,
    auth_session: DiagnosticsAuthSession,
    account: DiagnosticsAccount,
    node_sync: DiagnosticsNodeSync,
    selected_node: DiagnosticsSelectedNode,
    profile_generation: DiagnosticsProfileGeneration,
    runtime_core: DiagnosticsRuntimeCore,
    data_plane: DiagnosticsDataPlane,
    updater: DiagnosticsUpdater,
    logs: DiagnosticsLogs,
    safety: DiagnosticsSafety,
}

impl DiagnosticsBundle {
    fn validate(&self) -> bool {
        self.schema_version == 1
            && is_canonical_iso_timestamp(&self.exported_at)
            && is_safe_version(&self.app.version)
            && self.system.uptime_ms.is_none_or(|value| value <= MAX_SAFE_INTEGER)
            && self
                .account
                .node_count
                .is_none_or(|value| value <= MAX_DIAGNOSTIC_COUNT)
            && is_safe_version(&self.updater.current_version_class)
            && self.logs.runtime.validate(DiagnosticLogSource::Runtime)
            && self.logs.clash.validate(DiagnosticLogSource::Clash)
            && !self.safety.raw_text_included
    }
}

fn is_safe_version(value: &str) -> bool {
    if value == "unknown" {
        return true;
    }
    value.len() <= 64
        && regex::Regex::new(r"^\d{1,4}(?:\.\d{1,4}){1,3}(?:[-+][0-9A-Za-z.-]{1,32})?$")
            .is_ok_and(|pattern| pattern.is_match(value))
}

fn is_canonical_iso_timestamp(value: &str) -> bool {
    if value.len() != 24 {
        return false;
    }
    chrono::DateTime::parse_from_rfc3339(value)
        .is_ok_and(|timestamp| timestamp.to_utc().to_rfc3339_opts(chrono::SecondsFormat::Millis, true) == value)
}

fn normalize_max_log_items(max_items: Option<i64>) -> usize {
    max_items.unwrap_or(DEFAULT_MAX_LOG_ITEMS).clamp(0, MAX_LOG_ITEMS) as usize
}

#[tauri::command]
pub async fn runtime_get_diagnostics_log_summaries(max_items: Option<i64>) -> DiagnosticsLogSummaries {
    let max_items = normalize_max_log_items(max_items);
    let (runtime, clash) = tokio::join!(
        super::runtime::diagnostics_log_summary(max_items),
        super::clash::diagnostics_log_summary(max_items),
    );
    DiagnosticsLogSummaries { runtime, clash }
}

#[tauri::command]
pub fn runtime_write_diagnostics_bundle(app: AppHandle, bundle: DiagnosticsBundle) -> CmdResult<()> {
    if !bundle.validate() {
        return Err("invalid_diagnostics_bundle".into());
    }
    let canonical = serde_json::to_string_pretty(&bundle).map_err(|_| safe_error())?;
    app.clipboard()
        .write_text(canonical)
        .map_err(|_| "diagnostics_clipboard_failed".into())
}

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

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TunSettingsView {
    stack: String,
    device: String,
    auto_route: bool,
    auto_redirect: bool,
    auto_detect_interface: bool,
    dns_hijack: Vec<String>,
    route_exclude_address: Vec<String>,
    strict_route: bool,
    mtu: u16,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct TunSettingsUpdate {
    stack: String,
    device: String,
    auto_route: bool,
    auto_redirect: bool,
    auto_detect_interface: bool,
    dns_hijack: Vec<String>,
    route_exclude_address: Vec<String>,
    strict_route: bool,
    mtu: u16,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeProxySettingsView {
    mixed_port: u16,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct RuntimePreferencesUpdate {
    collapse_navbar: Option<bool>,
    language: Option<String>,
    enable_proxy_guard: Option<bool>,
    enable_bypass_check: Option<bool>,
    proxy_guard_duration: Option<u64>,
    system_proxy_bypass: Option<String>,
    proxy_auto_config: Option<bool>,
    use_default_bypass: Option<bool>,
    pac_file_content: Option<String>,
    proxy_host: Option<String>,
}

fn validate_runtime_preferences(preferences: &RuntimePreferencesUpdate) -> CmdResult<()> {
    if preferences
        .language
        .as_deref()
        .is_some_and(|language| !matches!(language, "en" | "zh"))
        || preferences
            .proxy_guard_duration
            .is_some_and(|duration| !(1..=MAX_PROXY_GUARD_DURATION_SECS).contains(&duration))
        || preferences
            .system_proxy_bypass
            .as_deref()
            .is_some_and(|value| value.len() > MAX_PROXY_BYPASS_BYTES || value.contains('\0'))
        || preferences
            .pac_file_content
            .as_deref()
            .is_some_and(|value| value.len() > MAX_PAC_CONTENT_BYTES || value.contains('\0'))
        || preferences.proxy_host.as_deref().is_some_and(|value| {
            value.is_empty() || value.len() > MAX_PROXY_HOST_BYTES || value.chars().any(char::is_control)
        })
    {
        return Err("invalid_runtime_preferences".into());
    }
    Ok(())
}

fn runtime_preferences_patch(preferences: RuntimePreferencesUpdate) -> IVerge {
    IVerge {
        collapse_navbar: preferences.collapse_navbar,
        language: preferences.language,
        enable_proxy_guard: preferences.enable_proxy_guard,
        enable_bypass_check: preferences.enable_bypass_check,
        proxy_guard_duration: preferences.proxy_guard_duration,
        system_proxy_bypass: preferences.system_proxy_bypass,
        proxy_auto_config: preferences.proxy_auto_config,
        use_default_bypass: preferences.use_default_bypass,
        pac_file_content: preferences.pac_file_content,
        proxy_host: preferences.proxy_host,
        ..Default::default()
    }
}

fn default_tun_device() -> String {
    if cfg!(target_os = "macos") {
        "utun1024".into()
    } else {
        "Mihomo".into()
    }
}

fn mapping_tun_text(mapping: &Mapping, key: &str, fallback: String, max_bytes: usize) -> CmdResult<String> {
    match mapping.get(key) {
        None => Ok(fallback),
        Some(value) => value
            .as_str()
            .filter(|value| validate_tun_text(value, max_bytes))
            .map(Into::into)
            .ok_or_else(|| "invalid_tun_settings".into()),
    }
}

fn mapping_bool(mapping: &Mapping, key: &str, fallback: bool) -> CmdResult<bool> {
    match mapping.get(key) {
        None => Ok(fallback),
        Some(value) => value.as_bool().ok_or_else(|| "invalid_tun_settings".into()),
    }
}

fn mapping_tun_strings(
    mapping: &Mapping,
    key: &str,
    fallback: Vec<String>,
    require_cidr: bool,
) -> CmdResult<Vec<String>> {
    let Some(value) = mapping.get(key) else {
        return Ok(fallback);
    };
    let values = value
        .as_sequence()
        .filter(|values| values.len() <= MAX_TUN_LIST_ITEMS)
        .ok_or_else(|| String::from("invalid_tun_settings"))?;
    values
        .iter()
        .map(|value| {
            value
                .as_str()
                .filter(|value| {
                    validate_tun_text(value, MAX_TUN_LIST_ITEM_BYTES) && (!require_cidr || is_valid_ip_cidr(value))
                })
                .map(Into::into)
                .ok_or_else(|| String::from("invalid_tun_settings"))
        })
        .collect()
}

fn mapping_tun_stack(mapping: &Mapping) -> CmdResult<String> {
    match mapping.get("stack") {
        None => Ok("gvisor".into()),
        Some(value) => match value.as_str() {
            Some(stack @ ("gvisor" | "system" | "mixed")) => Ok(stack.into()),
            _ => Err("invalid_tun_settings".into()),
        },
    }
}

fn tun_settings_from_mapping(mapping: Option<&Mapping>) -> CmdResult<TunSettingsView> {
    let empty = Mapping::new();
    let mapping = mapping.unwrap_or(&empty);
    let mtu = match mapping.get("mtu") {
        None => 1500,
        Some(value) => value
            .as_u64()
            .and_then(|value| u16::try_from(value).ok())
            .filter(|value| (576..=9000).contains(value))
            .ok_or_else(|| String::from("invalid_tun_settings"))?,
    };
    Ok(TunSettingsView {
        stack: mapping_tun_stack(mapping)?,
        device: mapping_tun_text(mapping, "device", default_tun_device(), MAX_TUN_DEVICE_BYTES)?,
        auto_route: mapping_bool(mapping, "auto-route", true)?,
        auto_redirect: mapping_bool(mapping, "auto-redirect", false)?,
        auto_detect_interface: mapping_bool(mapping, "auto-detect-interface", true)?,
        dns_hijack: mapping_tun_strings(mapping, "dns-hijack", vec!["any:53".into()], false)?,
        route_exclude_address: mapping_tun_strings(mapping, "route-exclude-address", Vec::new(), true)?,
        strict_route: mapping_bool(mapping, "strict-route", false)?,
        mtu,
    })
}

fn validate_tun_text(value: &str, max_bytes: usize) -> bool {
    !value.is_empty() && value.len() <= max_bytes && !value.chars().any(char::is_control)
}

fn validate_tun_list(values: &[String]) -> bool {
    values.len() <= MAX_TUN_LIST_ITEMS
        && values
            .iter()
            .all(|value| validate_tun_text(value, MAX_TUN_LIST_ITEM_BYTES))
}

fn is_valid_ip_cidr(value: &str) -> bool {
    let Some((address, prefix)) = value.split_once('/') else {
        return false;
    };
    let Ok(address) = IpAddr::from_str(address) else {
        return false;
    };
    let Ok(prefix) = prefix.parse::<u8>() else {
        return false;
    };
    prefix <= if address.is_ipv4() { 32 } else { 128 }
}

fn validate_tun_settings(settings: &TunSettingsUpdate) -> CmdResult<()> {
    if !matches!(settings.stack.as_str(), "gvisor" | "system" | "mixed")
        || !validate_tun_text(&settings.device, MAX_TUN_DEVICE_BYTES)
        || !validate_tun_list(&settings.dns_hijack)
        || settings.route_exclude_address.len() > MAX_TUN_LIST_ITEMS
        || settings
            .route_exclude_address
            .iter()
            .any(|value| !validate_tun_text(value, MAX_TUN_LIST_ITEM_BYTES) || !is_valid_ip_cidr(value))
        || !(576..=9000).contains(&settings.mtu)
    {
        return Err("invalid_tun_settings".into());
    }
    Ok(())
}

fn tun_settings_patch(settings: TunSettingsUpdate, existing: Option<&Mapping>) -> Mapping {
    let mut tun = existing.cloned().unwrap_or_default();
    tun.insert("stack".into(), Value::from(settings.stack.as_str()));
    tun.insert("device".into(), Value::from(settings.device.as_str()));
    tun.insert("auto-route".into(), settings.auto_route.into());
    if cfg!(target_os = "linux") {
        tun.insert("auto-redirect".into(), settings.auto_redirect.into());
    }
    tun.insert("auto-detect-interface".into(), settings.auto_detect_interface.into());
    tun.insert(
        "dns-hijack".into(),
        settings
            .dns_hijack
            .iter()
            .map(|value| Value::from(value.as_str()))
            .collect::<Vec<Value>>()
            .into(),
    );
    tun.insert(
        "route-exclude-address".into(),
        settings
            .route_exclude_address
            .iter()
            .map(|value| Value::from(value.as_str()))
            .collect::<Vec<Value>>()
            .into(),
    );
    tun.insert("strict-route".into(), settings.strict_route.into());
    tun.insert("mtu".into(), settings.mtu.into());

    let mut patch = Mapping::new();
    patch.insert("tun".into(), tun.into());
    patch
}

#[cfg(test)]
fn tun_settings_view_from_update(settings: &TunSettingsUpdate) -> TunSettingsView {
    TunSettingsView {
        stack: settings.stack.clone(),
        device: settings.device.clone(),
        auto_route: settings.auto_route,
        auto_redirect: cfg!(target_os = "linux") && settings.auto_redirect,
        auto_detect_interface: settings.auto_detect_interface,
        dns_hijack: settings.dns_hijack.clone(),
        route_exclude_address: settings.route_exclude_address.clone(),
        strict_route: settings.strict_route,
        mtu: settings.mtu,
    }
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

fn rollback_error() -> String {
    "runtime_action_rollback_failed".into()
}

#[tauri::command]
pub async fn runtime_get_proxy_settings() -> CmdResult<RuntimeProxySettingsView> {
    let clash = Config::clash().await.latest_arc();
    Ok(RuntimeProxySettingsView {
        mixed_port: clash.get_mixed_port(),
    })
}

#[tauri::command]
pub async fn runtime_get_tun_settings() -> CmdResult<TunSettingsView> {
    let _transaction_guard = CoreManager::begin_config_transaction().await;
    let clash = Config::clash().await.data_arc();
    let tun = clash.0.get("tun").and_then(Value::as_mapping);
    tun_settings_from_mapping(tun)
}

#[tauri::command]
pub async fn runtime_update_preferences(preferences: RuntimePreferencesUpdate) -> CmdResult<()> {
    validate_runtime_preferences(&preferences)?;
    feat::patch_verge(&runtime_preferences_patch(preferences), false)
        .await
        .map_err(|_| safe_error())
}

#[tauri::command]
pub async fn runtime_refresh_system_proxy() -> CmdResult<()> {
    let _transaction_guard = CoreManager::begin_config_transaction().await;
    let enabled = Config::verge().await.data_arc().enable_system_proxy.unwrap_or(false);
    if !enabled {
        return Ok(());
    }
    sysopt::Sysopt::global()
        .update_sysproxy()
        .await
        .map_err(|_| safe_error())?;
    sysopt::Sysopt::global().refresh_guard().await;
    Ok(())
}

async fn rollback_staged_tun_settings() -> CmdResult<()> {
    Config::clash().await.discard();
    Config::runtime().await.discard();

    Config::generate().await.map_err(|_| rollback_error())?;
    let (valid, _) = CoreManager::global()
        .apply_generate_config_in_transaction()
        .await
        .map_err(|_| rollback_error())?;
    if !valid {
        return Err(rollback_error());
    }
    Ok(())
}

#[tauri::command]
pub async fn runtime_update_tun_settings(settings: TunSettingsUpdate) -> CmdResult<TunSettingsView> {
    let _mutation_guard = TUN_SETTINGS_MUTATION_LOCK.lock().await;
    let _transaction_guard = CoreManager::begin_config_transaction().await;
    validate_tun_settings(&settings)?;
    let clash = Config::clash().await.data_arc();
    let existing_tun = clash.0.get("tun").and_then(Value::as_mapping);
    let patch = tun_settings_patch(settings, existing_tun);
    drop(clash);
    Config::clash().await.edit_draft(|draft| draft.patch_config(&patch));

    let applied = async {
        Config::generate().await.map_err(|_| safe_error())?;
        let (valid, _) = CoreManager::global()
            .apply_generate_config_in_transaction()
            .await
            .map_err(|_| safe_error())?;
        if !valid {
            return Err(safe_error());
        }

        Ok(())
    }
    .await;

    match applied {
        Ok(()) => {
            let clash = Config::clash().await.latest_arc();
            if clash.save_config().await.is_err() {
                return match rollback_staged_tun_settings().await {
                    Ok(()) => Err(safe_error()),
                    Err(_) => Err(rollback_error()),
                };
            }
            Config::clash().await.apply();
            handle::Handle::refresh_clash();
            let clash = Config::clash().await.data_arc();
            let tun = clash.0.get("tun").and_then(Value::as_mapping);
            tun_settings_from_mapping(tun)
        }
        Err(error) => match rollback_staged_tun_settings().await {
            Ok(()) => Err(error),
            Err(_) => Err(rollback_error()),
        },
    }
}

fn validate_node_label(value: &str) -> CmdResult<()> {
    if value.is_empty() || value.len() > MAX_NODE_LABEL_BYTES || value.chars().any(char::is_control) {
        Err("invalid_node_selection".into())
    } else {
        Ok(())
    }
}

async fn patch_clash_mode_in_transaction(mode: &str) -> CmdResult<()> {
    let mut patch = Mapping::new();
    patch.insert(Value::from("mode"), Value::from(mode));
    feat::patch_clash_in_transaction(&patch).await.map_err(|_| safe_error())
}

async fn rollback_connection_state_in_transaction(previous_mode: &str, previous_verge: &IVerge) -> CmdResult<()> {
    let mode_rollback = patch_clash_mode_in_transaction(previous_mode).await;
    let verge_rollback = feat::patch_verge_in_transaction(previous_verge, false).await;
    if mode_rollback.is_err() || verge_rollback.is_err() {
        return Err(rollback_error());
    }
    Ok(())
}

async fn patch_connection_state_in_transaction(mode: RuntimeConnectMode, enabled: bool) -> CmdResult<()> {
    let previous_mode = Config::clash()
        .await
        .data_arc()
        .0
        .get("mode")
        .and_then(Value::as_str)
        .unwrap_or("rule")
        .to_owned();
    let previous_verge = Config::verge().await.data_arc();
    let previous_connection_state = IVerge {
        enable_tun_mode: previous_verge.enable_tun_mode,
        enable_system_proxy: previous_verge.enable_system_proxy,
        connect_mode: previous_verge.connect_mode.clone(),
        ..IVerge::default()
    };
    drop(previous_verge);

    if enabled && patch_clash_mode_in_transaction(mode.clash_mode()).await.is_err() {
        return match rollback_connection_state_in_transaction(&previous_mode, &previous_connection_state).await {
            Ok(()) => Err(safe_error()),
            Err(error) => Err(error),
        };
    }
    let (enable_tun_mode, enable_system_proxy) = match mode {
        RuntimeConnectMode::System => (false, enabled),
        RuntimeConnectMode::Both | RuntimeConnectMode::Smart => (enabled, enabled),
    };
    let verge_result = feat::patch_verge_in_transaction(
        &IVerge {
            enable_tun_mode: Some(enable_tun_mode),
            enable_system_proxy: Some(enable_system_proxy),
            connect_mode: Some(mode.as_str().into()),
            ..IVerge::default()
        },
        false,
    )
    .await;
    if verge_result.is_err() {
        return match rollback_connection_state_in_transaction(&previous_mode, &previous_connection_state).await {
            Ok(()) => Err(safe_error()),
            Err(error) => Err(error),
        };
    }
    handle::Handle::refresh_verge();
    Ok(())
}

#[tauri::command]
pub async fn runtime_set_connection_enabled(mode: RuntimeConnectMode, enabled: bool) -> CmdResult<()> {
    let _transaction_guard = CoreManager::begin_config_transaction().await;
    patch_connection_state_in_transaction(mode, enabled).await
}

#[tauri::command]
pub async fn runtime_set_connection_mode(mode: RuntimeConnectMode) -> CmdResult<()> {
    let _transaction_guard = CoreManager::begin_config_transaction().await;
    let verge = Config::verge().await.data_arc();
    let enabled = verge.enable_tun_mode.unwrap_or(false) || verge.enable_system_proxy.unwrap_or(false);
    drop(verge);
    if enabled {
        return patch_connection_state_in_transaction(mode, true).await;
    }
    feat::patch_verge_in_transaction(
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
    feat::patch_verge(
        &IVerge {
            enable_system_proxy: Some(enabled),
            ..IVerge::default()
        },
        false,
    )
    .await
    .map_err(|_| safe_error())?;
    if close_connections {
        let _ = handle::Handle::mihomo().await.close_all_connections().await;
    }
    handle::Handle::refresh_verge();
    Ok(())
}

async fn persist_node_selection(group_name: &str, proxy_name: &str) -> CmdResult<(String, PrfItem)> {
    let profiles = Config::profiles().await.data_arc();
    let current = profiles.current.clone().ok_or_else(safe_error)?;
    let previous_item: PrfItem = profiles.get_item(&current).map_err(|_| safe_error())?.clone();
    let mut item = previous_item.clone();
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
        .map_err(|_| safe_error())?;
    Ok((current, previous_item))
}

async fn select_runtime_node(group_name: &str, proxy_name: &str) -> CmdResult<()> {
    let mihomo = handle::Handle::mihomo().await;
    if mihomo.select_node_for_group(group_name, proxy_name).await.is_err() {
        mihomo
            .select_node_for_group(group_name, proxy_name)
            .await
            .map_err(|_| safe_error())?;
    }
    drop(mihomo);
    Ok(())
}

#[tauri::command]
pub async fn runtime_select_node(group_name: String, proxy_name: String, persist: bool) -> CmdResult<()> {
    let _profile_guard = crate::cmd::wait_profile_switch_guard().await;
    let _selection_guard = NODE_SELECTION_LOCK.lock().await;
    validate_node_label(&group_name)?;
    validate_node_label(&proxy_name)?;

    let persisted_selection = if persist {
        Some(persist_node_selection(&group_name, &proxy_name).await?)
    } else {
        None
    };

    if let Err(error) = select_runtime_node(&group_name, &proxy_name).await {
        if let Some((profile_id, previous_item)) = persisted_selection
            && profiles_patch_item_safe(&profile_id, &previous_item).await.is_err()
        {
            return Err(rollback_error());
        }
        return Err(error);
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
mod runtime_boundary_tests {
    use super::*;
    use serde_json::json;

    fn valid_tun_update() -> TunSettingsUpdate {
        TunSettingsUpdate {
            stack: "gvisor".into(),
            device: "Mihomo".into(),
            auto_route: true,
            auto_redirect: false,
            auto_detect_interface: true,
            dns_hijack: vec!["any:53".into()],
            route_exclude_address: vec!["192.168.0.0/16".into()],
            strict_route: false,
            mtu: 1500,
        }
    }

    fn empty_preferences() -> RuntimePreferencesUpdate {
        RuntimePreferencesUpdate {
            collapse_navbar: None,
            language: None,
            enable_proxy_guard: None,
            enable_bypass_check: None,
            proxy_guard_duration: None,
            system_proxy_bypass: None,
            proxy_auto_config: None,
            use_default_bypass: None,
            pac_file_content: None,
            proxy_host: None,
        }
    }

    #[test]
    fn runtime_preferences_reject_unknown_or_invalid_values() {
        assert!(
            serde_json::from_value::<RuntimePreferencesUpdate>(json!({
                "language": "en",
                "enable_system_proxy": true
            }))
            .is_err()
        );

        let mut invalid = empty_preferences();
        invalid.language = Some("unsupported".into());
        assert!(validate_runtime_preferences(&invalid).is_err());

        let mut invalid = empty_preferences();
        invalid.proxy_guard_duration = Some(0);
        assert!(validate_runtime_preferences(&invalid).is_err());

        let mut invalid = empty_preferences();
        invalid.proxy_host = Some("127.0.0.1\nunsafe".into());
        assert!(validate_runtime_preferences(&invalid).is_err());

        let mut valid = empty_preferences();
        valid.language = Some("zh".into());
        valid.pac_file_content = Some("function FindProxyForURL() {\n  return \"DIRECT\";\n}".into());
        assert!(validate_runtime_preferences(&valid).is_ok());
    }

    #[test]
    fn runtime_preferences_patch_contains_only_allowlisted_fields() -> Result<(), serde_json::Error> {
        let mut preferences = empty_preferences();
        preferences.collapse_navbar = Some(true);
        preferences.proxy_auto_config = Some(false);
        let serialized = serde_json::to_value(runtime_preferences_patch(preferences))?;

        assert_eq!(serialized["collapse_navbar"], true);
        assert_eq!(serialized["proxy_auto_config"], false);
        assert!(serialized["enable_system_proxy"].is_null());
        assert!(serialized["enable_tun_mode"].is_null());
        assert!(serialized["clash_core"].is_null());
        Ok(())
    }

    #[test]
    fn tun_settings_reject_unapproved_fields_and_invalid_values() {
        let with_secret = json!({
            "stack": "gvisor",
            "device": "Mihomo",
            "autoRoute": true,
            "autoRedirect": false,
            "autoDetectInterface": true,
            "dnsHijack": ["any:53"],
            "routeExcludeAddress": [],
            "strictRoute": false,
            "mtu": 1500,
            "secret": "must-not-enter-renderer-boundary"
        });
        assert!(serde_json::from_value::<TunSettingsUpdate>(with_secret).is_err());

        let mut invalid = valid_tun_update();
        invalid.stack = "unsupported".into();
        assert_eq!(validate_tun_settings(&invalid), Err("invalid_tun_settings".into()));

        let mut invalid = valid_tun_update();
        invalid.mtu = 1;
        assert_eq!(validate_tun_settings(&invalid), Err("invalid_tun_settings".into()));

        let mut invalid = valid_tun_update();
        invalid.route_exclude_address = vec!["not-a-cidr".into()];
        assert_eq!(validate_tun_settings(&invalid), Err("invalid_tun_settings".into()));

        let mut invalid = valid_tun_update();
        invalid.route_exclude_address = vec!["192.168.0.0/33".into()];
        assert_eq!(validate_tun_settings(&invalid), Err("invalid_tun_settings".into()));

        let mut valid = valid_tun_update();
        valid.route_exclude_address = vec!["2001:db8::/32".into()];
        assert!(validate_tun_settings(&valid).is_ok());

        let applied = tun_settings_view_from_update(&valid);
        assert_eq!(applied.route_exclude_address, vec!["2001:db8::/32"]);
        assert_eq!(applied.auto_redirect, cfg!(target_os = "linux") && valid.auto_redirect);
    }

    #[test]
    fn tun_settings_view_and_patch_exclude_sensitive_runtime_fields() -> Result<(), serde_json::Error> {
        let mut raw = Mapping::new();
        raw.insert("stack".into(), "mixed".into());
        raw.insert("device".into(), "Mihomo".into());
        raw.insert("secret".into(), "not-visible".into());
        raw.insert("external-controller".into(), "not-visible".into());
        raw.insert("mtu".into(), 1500.into());
        raw.insert("dns-hijack".into(), Value::Sequence(vec!["any:53".into()]));

        let Some(view) = tun_settings_from_mapping(Some(&raw)).ok() else {
            return Err(serde_json::Error::io(std::io::Error::other(
                "valid TUN settings were rejected",
            )));
        };
        let serialized = serde_json::to_value(view)?;
        assert_eq!(serialized["stack"], "mixed");
        assert_eq!(serialized["mtu"], 1500);
        assert_eq!(serialized["dnsHijack"], json!(["any:53"]));
        assert!(serialized.get("secret").is_none());
        assert!(serialized.get("externalController").is_none());

        let mut existing = Mapping::new();
        existing.insert("inet4-route-address".into(), Value::Sequence(vec!["0.0.0.0/1".into()]));
        existing.insert("strict-route".into(), true.into());
        let patch = tun_settings_patch(valid_tun_update(), Some(&existing));
        assert_eq!(patch.len(), 1);
        assert!(matches!(
            patch.get("tun").and_then(Value::as_mapping),
            Some(tun)
                if tun.get("secret").is_none()
                    && tun.get("external-controller").is_none()
                    && tun.get("inet4-route-address") == Some(&Value::Sequence(vec!["0.0.0.0/1".into()]))
                    && tun.get("strict-route") == Some(&Value::from(false))
        ));
        Ok(())
    }

    #[test]
    fn tun_settings_read_rejects_malformed_or_truncated_lists() {
        let mut malformed = Mapping::new();
        malformed.insert(
            "dns-hijack".into(),
            Value::Sequence(vec!["any:53".into(), "\ninvalid".into()]),
        );
        assert!(tun_settings_from_mapping(Some(&malformed)).is_err());

        let mut overflow = Mapping::new();
        overflow.insert(
            "route-exclude-address".into(),
            Value::Sequence(
                (0..=MAX_TUN_LIST_ITEMS)
                    .map(|index| Value::from(format!("10.{}.0.0/16", index % 256)))
                    .collect(),
            ),
        );
        assert!(tun_settings_from_mapping(Some(&overflow)).is_err());

        let mut invalid_cidr = Mapping::new();
        invalid_cidr.insert(
            "route-exclude-address".into(),
            Value::Sequence(vec!["not-a-cidr".into()]),
        );
        assert!(tun_settings_from_mapping(Some(&invalid_cidr)).is_err());
    }
}

#[cfg(test)]
mod diagnostics_tests {
    use super::*;
    use serde_json::json;

    fn valid_bundle_json() -> serde_json::Value {
        let empty_summary = |source| {
            json!({
                "source": source,
                "componentCount": 0,
                "totalCount": 0,
                "inspectedCount": 0,
                "omittedCount": 0,
                "levels": { "debug": 0, "info": 0, "warn": 0, "error": 0, "unknown": 0 },
                "categories": {
                    "auth-session": 0,
                    "network": 0,
                    "profile-sync": 0,
                    "timeout": 0,
                    "storage": 0,
                    "structured-or-sensitive": 0,
                    "oversized": 0,
                    "other": 0,
                    "unrecognized": 0
                }
            })
        };
        json!({
            "schemaVersion": 1,
            "exportedAt": "2026-07-22T12:34:56.789Z",
            "app": { "version": "2.4.17-dev" },
            "system": { "platform": "windows", "uptimeMs": 1000 },
            "authSession": {
                "status": "authenticated",
                "accessToken": "present",
                "refreshToken": "present",
                "userRole": "USER"
            },
            "account": {
                "lkgCache": "present",
                "ageBucket": "<15m",
                "subscriptionStatus": "ACTIVE",
                "entitlementClass": "PAID",
                "nodeCount": 3
            },
            "nodeSync": { "status": "ok-or-not-recorded", "lastErrorFamily": "none" },
            "selectedNode": { "status": "selected" },
            "profileGeneration": { "status": "present" },
            "runtimeCore": { "status": "observed", "runningMode": "rule" },
            "dataPlane": { "status": "not-tested" },
            "updater": {
                "currentVersionClass": "2.4.17-dev",
                "lastCheckStatus": "present",
                "lastCheckAgeBucket": "<1h"
            },
            "logs": { "runtime": empty_summary("runtime"), "clash": empty_summary("clash") },
            "safety": { "policy": "metadata-only", "rawTextIncluded": false }
        })
    }

    #[test]
    fn summary_contains_only_bounded_counts() -> serde_json::Result<()> {
        let summary = summarize_diagnostic_entries(
            DiagnosticLogSource::Runtime,
            1,
            vec![
                ("info", "ordinary event"),
                ("warning", "authorization: raw-secret"),
                ("error", "network timeout"),
            ],
            2,
        );
        let serialized = serde_json::to_string(&summary)?;
        assert!(!serialized.contains("raw-secret"));
        assert_eq!(summary.total_count, 3);
        assert_eq!(summary.inspected_count, 2);
        assert_eq!(summary.omitted_count, 1);
        assert_eq!(summary.levels.warn, 1);
        assert_eq!(summary.categories.structured_or_sensitive, 1);
        assert_eq!(summary.categories.timeout, 1);
        Ok(())
    }

    #[test]
    fn bundle_rejects_unknown_fields_bad_time_and_open_counts() -> serde_json::Result<()> {
        let valid: DiagnosticsBundle = serde_json::from_value(valid_bundle_json())?;
        assert!(valid.validate());

        let mut unknown = valid_bundle_json();
        unknown["app"]["raw"] = json!("must-not-pass");
        assert!(serde_json::from_value::<DiagnosticsBundle>(unknown).is_err());

        let mut bad_time = valid_bundle_json();
        bad_time["exportedAt"] = json!("2026-07-22T12:34:56Z");
        let bad_time: DiagnosticsBundle = serde_json::from_value(bad_time)?;
        assert!(!bad_time.validate());

        let mut open_counts = valid_bundle_json();
        open_counts["logs"]["runtime"]["totalCount"] = json!(1);
        let open_counts: DiagnosticsBundle = serde_json::from_value(open_counts)?;
        assert!(!open_counts.validate());
        Ok(())
    }

    #[test]
    fn log_limit_defaults_and_clamps() {
        assert_eq!(normalize_max_log_items(None), 50);
        assert_eq!(normalize_max_log_items(Some(-1)), 0);
        assert_eq!(normalize_max_log_items(Some(125)), 125);
        assert_eq!(normalize_max_log_items(Some(500)), 200);
    }
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
