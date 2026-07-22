use super::CmdResult;
use crate::{
    config::{Config, IVerge, PrfItem, PrfSelected, profiles::profiles_patch_item_safe},
    core::{handle, tray},
    feat,
};
use once_cell::sync::Lazy;
use serde::{Deserialize, Serialize};
use serde_yaml_ng::{Mapping, Value};
use smartstring::alias::String;
use std::time::Duration;
use tauri::AppHandle;
use tauri_plugin_clipboard_manager::ClipboardExt as _;
use tauri_plugin_updater::{Update, UpdaterExt as _};
use tokio::sync::Mutex;

const MAX_NODE_LABEL_BYTES: usize = 512;
const DEFAULT_MAX_LOG_ITEMS: i64 = 50;
const MAX_LOG_ITEMS: i64 = 200;
const MAX_DIAGNOSTIC_COUNT: u32 = 1_000_000;
const MAX_SAFE_INTEGER: u64 = 9_007_199_254_740_991;
const MAX_CLASSIFIABLE_TEXT_LENGTH: usize = 1024;
static PENDING_UPDATE: Lazy<Mutex<Option<Update>>> = Lazy::new(|| Mutex::new(None));

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

fn validate_node_label(value: &str) -> CmdResult<()> {
    if value.is_empty() || value.len() > MAX_NODE_LABEL_BYTES || value.chars().any(char::is_control) {
        Err("invalid_node_selection".into())
    } else {
        Ok(())
    }
}

async fn patch_clash_mode(mode: RuntimeConnectMode) -> CmdResult<()> {
    let mut patch = Mapping::new();
    patch.insert(Value::from("mode"), Value::from(mode.clash_mode()));
    feat::patch_clash(&patch).await.map_err(|_| safe_error())
}

async fn patch_connection_state(mode: RuntimeConnectMode, enabled: bool) -> CmdResult<()> {
    if enabled {
        patch_clash_mode(mode).await?;
    }
    let (enable_tun_mode, enable_system_proxy) = match mode {
        RuntimeConnectMode::System => (false, enabled),
        RuntimeConnectMode::Both | RuntimeConnectMode::Smart => (enabled, enabled),
    };
    feat::patch_verge(
        &IVerge {
            enable_tun_mode: Some(enable_tun_mode),
            enable_system_proxy: Some(enable_system_proxy),
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
pub async fn runtime_set_connection_enabled(mode: RuntimeConnectMode, enabled: bool) -> CmdResult<()> {
    patch_connection_state(mode, enabled).await
}

#[tauri::command]
pub async fn runtime_set_connection_mode(mode: RuntimeConnectMode) -> CmdResult<()> {
    let verge = Config::verge().await.latest_arc();
    let enabled = verge.enable_tun_mode.unwrap_or(false) || verge.enable_system_proxy.unwrap_or(false);
    drop(verge);
    if enabled {
        return patch_connection_state(mode, true).await;
    }
    feat::patch_verge(
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
    if close_connections {
        let _ = handle::Handle::mihomo().await.close_all_connections().await;
    }
    feat::patch_verge(
        &IVerge {
            enable_system_proxy: Some(enabled),
            ..IVerge::default()
        },
        false,
    )
    .await
    .map_err(|_| safe_error())?;
    handle::Handle::refresh_verge();
    Ok(())
}

async fn persist_node_selection(group_name: &str, proxy_name: &str) -> CmdResult<()> {
    let _profile_guard = crate::cmd::wait_profile_switch_guard().await;
    let profiles = Config::profiles().await.data_arc();
    let current = profiles.current.clone().ok_or_else(safe_error)?;
    let mut item: PrfItem = profiles.get_item(&current).map_err(|_| safe_error())?.clone();
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
        .map_err(|_| safe_error())
}

#[tauri::command]
pub async fn runtime_select_node(group_name: String, proxy_name: String, persist: bool) -> CmdResult<()> {
    validate_node_label(&group_name)?;
    validate_node_label(&proxy_name)?;
    let mihomo = handle::Handle::mihomo().await;
    if mihomo.select_node_for_group(&group_name, &proxy_name).await.is_err() {
        mihomo
            .select_node_for_group(&group_name, &proxy_name)
            .await
            .map_err(|_| safe_error())?;
    }
    drop(mihomo);
    if persist {
        let _ = persist_node_selection(&group_name, &proxy_name).await;
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
