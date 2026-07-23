use crate::{
    cmd::secure_session::{
        SecureSessionSecret, begin_login_attempt, read_secret_internal, replace_active_session_for_login,
        replacement_secret, session_generation, session_operation_guard, take_session_for_logout,
        write_secret_internal,
    },
    config::{
        Config, IProfiles, PrfItem, PrfOption,
        profiles::{
            profiles_append_item_preserve_current_safe, profiles_deactivate_items_safe, profiles_delete_item_safe,
            profiles_retire_items_safe, profiles_save_file_safe,
        },
    },
    core::{CoreManager, handle},
    utils::dirs,
};
use chrono::{DateTime, Utc};
use futures::StreamExt as _;
use once_cell::sync::Lazy;
use reqwest::{Method, StatusCode};
use serde::{Deserialize, Serialize, de::DeserializeOwned};
use serde_json::Value;
use smartstring::alias::String as SmartString;
use tokio::sync::Mutex;
use url::Url;

const API_BASE_URL: &str = match option_env!("VITE_API_BASE_URL") {
    Some(value) => value,
    None => "https://api.xxlink.net/api/v1",
};

static HTTP_CLIENT: Lazy<Result<reqwest::Client, BackendError>> = Lazy::new(|| {
    reqwest::Client::builder()
        .use_rustls_tls()
        .https_only(true)
        .redirect(reqwest::redirect::Policy::none())
        .timeout(std::time::Duration::from_secs(20))
        .build()
        .map_err(|_| BackendError::Unknown)
});
static REFRESH_LOCK: Lazy<Mutex<()>> = Lazy::new(|| Mutex::new(()));
static MANAGED_SYNC_LOCK: Lazy<Mutex<()>> = Lazy::new(|| Mutex::new(()));
const MANAGED_PROFILE_NAME: &str = "XXLink Managed Subscription";
const MANAGED_PROFILE_MARKER: &str = "xxlink-managed-subscription-v1";
const MAX_BACKEND_RESPONSE_BYTES: usize = 2 * 1024 * 1024;
const MAX_MANAGED_PROFILE_BYTES: usize = 8 * 1024 * 1024;

type BackendResult<T> = Result<T, BackendError>;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum BackendError {
    Auth,
    ServiceBlocked,
    TrafficExceeded,
    Network,
    InvalidResponse,
    Unknown,
}

impl std::fmt::Display for BackendError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str(match self {
            Self::Auth => "auth",
            Self::ServiceBlocked => "service_blocked",
            Self::TrafficExceeded => "traffic_exceeded",
            Self::Network => "network",
            Self::InvalidResponse => "invalid_response",
            Self::Unknown => "unknown",
        })
    }
}

impl Serialize for BackendError {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: serde::Serializer,
    {
        serializer.serialize_str(&self.to_string())
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SubjectBound<T> {
    subject_id: String,
    data: T,
}

struct AuthenticatedReply<T> {
    subject_id: String,
    data: T,
    generation: u64,
}

impl<T> SubjectBound<T> {
    fn map<U>(self, mapper: impl FnOnce(T) -> U) -> SubjectBound<U> {
        SubjectBound {
            subject_id: self.subject_id,
            data: mapper(self.data),
        }
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SubjectBoundError {
    subject_id: Option<String>,
    kind: BackendError,
}

impl SubjectBoundError {
    const fn without_subject(kind: BackendError) -> Self {
        Self { subject_id: None, kind }
    }

    const fn for_subject(subject_id: String, kind: BackendError) -> Self {
        Self {
            subject_id: Some(subject_id),
            kind,
        }
    }
}

#[derive(Clone, Deserialize, Serialize)]
#[serde(untagged)]
pub enum NumericValue {
    Number(f64),
    String(String),
}

#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PlanView {
    id: String,
    name: String,
    description: Option<String>,
    price: f64,
    duration: u64,
    billing_period: Option<String>,
    billing_cycle: Option<String>,
    interval: Option<String>,
    period: Option<String>,
    cycle: Option<String>,
    traffic_limit: f64,
    speed_limit: Option<f64>,
    max_devices: u64,
}

#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SubscriptionView {
    id: String,
    plan_id: String,
    traffic_used: f64,
    start_at: String,
    expire_at: String,
    status: String,
    plan: PlanView,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct InternalSubscription {
    id: String,
    plan_id: String,
    sub_url: String,
    traffic_used: f64,
    start_at: String,
    expire_at: String,
    status: String,
    plan: PlanView,
}

impl From<InternalSubscription> for SubscriptionView {
    fn from(value: InternalSubscription) -> Self {
        Self {
            id: value.id,
            plan_id: value.plan_id,
            traffic_used: value.traffic_used,
            start_at: value.start_at,
            expire_at: value.expire_at,
            status: value.status,
            plan: value.plan,
        }
    }
}

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UsagePlanView {
    id: String,
    name: String,
    duration: u64,
}

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EntitlementView {
    speed_limit_mbps: Option<NumericValue>,
    max_devices: Option<u64>,
    access_tier: Option<String>,
    node_tier: Option<String>,
}

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UsageView {
    traffic_used: NumericValue,
    traffic_limit: NumericValue,
    base_traffic_limit: Option<NumericValue>,
    bonus_traffic_limit: Option<NumericValue>,
    traffic_remaining: NumericValue,
    percent_used: f64,
    plan: Option<UsagePlanView>,
    entitlement: Option<EntitlementView>,
    status: String,
    expire_at: String,
    start_at: String,
}

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PublicBenefitView {
    visible: bool,
    is_trial: bool,
    has_paid_plan: bool,
    can_claim: bool,
    email_verified: bool,
    claim_bytes: NumericValue,
    active_bonus_bytes: NumericValue,
    cooldown_hours: Option<u64>,
    valid_hours: Option<u64>,
    cooldown_days: Option<u64>,
    valid_days: Option<u64>,
    last_claimed_at: Option<String>,
    next_claim_at: Option<String>,
    active_bonus_expires_at: Option<String>,
    subscription_created: Option<bool>,
    bonus_granted: Option<bool>,
}

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NodeView {
    id: String,
    name: String,
    protocol: String,
    region: String,
    is_active: bool,
}

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UserProfileView {
    id: String,
    email: String,
    role: String,
}

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PromoRedeemView {
    code: String,
    #[serde(rename = "type")]
    promo_type: Option<String>,
    traffic_gb: Option<f64>,
    bonus_bytes: Option<NumericValue>,
    valid_days: Option<u64>,
    expires_at: Option<String>,
    plan_name: Option<String>,
    message: Option<String>,
    subscription_created: Option<bool>,
}

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TrafficReportView {
    traffic_used: NumericValue,
    traffic_limit: NumericValue,
    remaining: NumericValue,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct RefreshedTokens {
    access_token: String,
    refresh_token: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct LoginReply {
    access_token: String,
    refresh_token: String,
    user: UserProfileView,
}

fn endpoint(path: &str) -> String {
    format!("{}{}", API_BASE_URL.trim_end_matches('/'), path)
}

fn is_service_blocked(status: StatusCode, code: Option<&str>, path: &str) -> bool {
    const BLOCKED_CODES: &[&str] = &[
        "ACCOUNT_DISABLED",
        "ACCOUNT_INACTIVE",
        "ACCOUNT_NOT_FOUND",
        "ACCOUNT_BLOCKED",
        "ACCOUNT_SUSPENDED",
        "INVALID_REFRESH_TOKEN",
        "REFRESH_TOKEN_INVALID",
        "SESSION_REVOKED",
        "SESSION_EXPIRED",
        "TOKEN_REVOKED",
        "USER_DELETED",
        "USER_DISABLED",
        "USER_NOT_FOUND",
        "INVALID_REFRESH_TOKEN",
        "TOKEN_REVOKED",
    ];
    code.is_some_and(|value| BLOCKED_CODES.contains(&value))
        || (path == "/auth/refresh" && status == StatusCode::UNAUTHORIZED && code.is_none())
        || (path.starts_with("/user/")
            && status == StatusCode::NOT_FOUND
            && matches!(code, Some("ACCOUNT_NOT_FOUND" | "USER_NOT_FOUND")))
}

fn categorize_response(status: StatusCode, code: Option<&str>, path: &str) -> BackendError {
    const AUTH_CODES: &[&str] = &["INVALID_TOKEN_TYPE", "UNAUTHORIZED"];
    if is_service_blocked(status, code, path) {
        BackendError::ServiceBlocked
    } else if code == Some("TRAFFIC_EXCEEDED") {
        BackendError::TrafficExceeded
    } else if status == StatusCode::UNAUTHORIZED || code.is_some_and(|value| AUTH_CODES.contains(&value)) {
        BackendError::Auth
    } else if status.is_server_error() {
        BackendError::Network
    } else {
        BackendError::Unknown
    }
}

async fn parse_response<T: DeserializeOwned>(response: reqwest::Response, path: &str) -> BackendResult<T> {
    let status = response.status();
    if response
        .content_length()
        .is_some_and(|length| length > MAX_BACKEND_RESPONSE_BYTES as u64)
    {
        return Err(BackendError::InvalidResponse);
    }
    let mut bytes = Vec::new();
    let mut stream = response.bytes_stream();
    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(|_| BackendError::Network)?;
        if bytes.len().saturating_add(chunk.len()) > MAX_BACKEND_RESPONSE_BYTES {
            return Err(BackendError::InvalidResponse);
        }
        bytes.extend_from_slice(&chunk);
    }
    let envelope = serde_json::from_slice::<Value>(&bytes).map_err(|_| BackendError::InvalidResponse)?;
    let success = envelope
        .get("success")
        .and_then(Value::as_bool)
        .ok_or(BackendError::InvalidResponse)?;
    let code = envelope.pointer("/error/code").and_then(Value::as_str);
    if !status.is_success() || !success {
        return Err(categorize_response(status, code, path));
    }
    let data = envelope.get("data").ok_or(BackendError::InvalidResponse)?;
    serde_json::from_value(data.clone()).map_err(|_| BackendError::InvalidResponse)
}

async fn send_request(
    method: Method,
    path: &str,
    access_token: &str,
    body: Option<&Value>,
) -> BackendResult<reqwest::Response> {
    let client = HTTP_CLIENT.as_ref().map_err(|error| *error)?;
    let mut request = client
        .request(method, endpoint(path))
        .bearer_auth(access_token)
        .header(reqwest::header::CONTENT_TYPE, "application/json");
    if let Some(body) = body {
        request = request.json(body);
    }
    request.send().await.map_err(|_| BackendError::Network)
}

async fn require_session() -> BackendResult<SecureSessionSecret> {
    read_secret_internal()
        .await
        .map_err(|_| BackendError::Auth)?
        .ok_or(BackendError::Auth)
}

struct SessionSnapshot {
    secret: SecureSessionSecret,
    generation: u64,
}

async fn session_snapshot() -> BackendResult<SessionSnapshot> {
    let _guard = session_operation_guard().await;
    let secret = require_session().await?;
    Ok(SessionSnapshot {
        secret,
        generation: session_generation(),
    })
}

async fn validate_session_snapshot(subject_id: &str, generation: u64) -> BackendResult<()> {
    let _guard = session_operation_guard().await;
    validate_session_snapshot_locked(subject_id, generation).await
}

async fn validate_session_snapshot_locked(subject_id: &str, generation: u64) -> BackendResult<()> {
    if session_generation() != generation {
        return Err(BackendError::Auth);
    }
    let current = require_session().await?;
    if current.subject_id() == subject_id {
        Ok(())
    } else {
        Err(BackendError::Auth)
    }
}

async fn refresh_session(stale_access_token: &str) -> BackendResult<SecureSessionSecret> {
    let _guard = REFRESH_LOCK.lock().await;
    let snapshot = session_snapshot().await?;
    let current = snapshot.secret;
    if current.access_token() != stale_access_token {
        return Ok(current);
    }

    let client = HTTP_CLIENT.as_ref().map_err(|error| *error)?;
    let response = client
        .post(endpoint("/auth/refresh"))
        .header(reqwest::header::CONTENT_TYPE, "application/json")
        .json(&serde_json::json!({ "refreshToken": current.refresh_token() }))
        .send()
        .await
        .map_err(|_| BackendError::Network)?;
    let tokens: RefreshedTokens = parse_response(response, "/auth/refresh").await?;
    let replacement = replacement_secret(
        current.subject_id().to_owned(),
        tokens.access_token,
        tokens.refresh_token,
    )
    .map_err(|_| BackendError::InvalidResponse)?;
    let _session_guard = session_operation_guard().await;
    validate_session_snapshot_locked(current.subject_id(), snapshot.generation).await?;
    write_secret_internal(replacement.clone())
        .await
        .map_err(|_| BackendError::Unknown)?;
    Ok(replacement)
}

async fn authenticated_request_with_snapshot<T: DeserializeOwned>(
    method: Method,
    path: &str,
    body: Option<Value>,
    snapshot: SessionSnapshot,
) -> Result<AuthenticatedReply<T>, SubjectBoundError> {
    let session = snapshot.secret;
    let mut generation = snapshot.generation;
    let subject_id = session.subject_id().to_owned();
    let mut response = send_request(method.clone(), path, session.access_token(), body.as_ref())
        .await
        .map_err(|kind| SubjectBoundError::for_subject(subject_id.clone(), kind))?;
    if response.status() == StatusCode::UNAUTHORIZED {
        let refreshed = match refresh_session(session.access_token()).await {
            Ok(refreshed) => refreshed,
            Err(kind) => {
                let kind = enforce_authoritative_service_block_for_session(kind, &subject_id, generation)
                    .await
                    .map_err(|kind| SubjectBoundError::for_subject(subject_id.clone(), kind))?;
                return Err(SubjectBoundError::for_subject(subject_id, kind));
            }
        };
        if refreshed.subject_id() != subject_id {
            return Err(SubjectBoundError::for_subject(subject_id, BackendError::Auth));
        }
        generation = session_generation();
        response = send_request(method, path, refreshed.access_token(), body.as_ref())
            .await
            .map_err(|kind| SubjectBoundError::for_subject(subject_id.clone(), kind))?;
    }
    match parse_response(response, path).await {
        Ok(data) => {
            validate_session_snapshot(&subject_id, generation)
                .await
                .map_err(|kind| SubjectBoundError::for_subject(subject_id.clone(), kind))?;
            Ok(AuthenticatedReply {
                subject_id,
                data,
                generation,
            })
        }
        Err(kind) => {
            let kind = enforce_authoritative_service_block_for_session(kind, &subject_id, generation)
                .await
                .map_err(|kind| SubjectBoundError::for_subject(subject_id.clone(), kind))?;
            Err(SubjectBoundError::for_subject(subject_id, kind))
        }
    }
}

async fn authenticated_request<T: DeserializeOwned>(
    method: Method,
    path: &str,
    body: Option<Value>,
) -> Result<SubjectBound<T>, SubjectBoundError> {
    let snapshot = session_snapshot().await.map_err(SubjectBoundError::without_subject)?;
    authenticated_request_with_snapshot(method, path, body, snapshot)
        .await
        .map(|reply| SubjectBound {
            subject_id: reply.subject_id,
            data: reply.data,
        })
}

#[tauri::command]
pub async fn secure_session_login(email: String, password: String) -> Result<UserProfileView, BackendError> {
    let login_attempt = begin_login_attempt();
    let client = HTTP_CLIENT.as_ref().map_err(|error| *error)?;
    let login = tokio::time::timeout(std::time::Duration::from_secs(8), async {
        let response = client
            .post(endpoint("/auth/login"))
            .header(reqwest::header::CONTENT_TYPE, "application/json")
            .json(&serde_json::json!({ "email": email, "password": password }))
            .send()
            .await
            .map_err(|_| BackendError::Network)?;
        parse_response::<LoginReply>(response, "/auth/login").await
    })
    .await
    .map_err(|_| BackendError::Network)??;
    let secret = replacement_secret(login.user.id.clone(), login.access_token, login.refresh_token)
        .map_err(|_| BackendError::InvalidResponse)?;
    replace_active_session_for_login(secret, login_attempt)
        .await
        .map_err(|_| BackendError::Unknown)?;
    Ok(login.user)
}

#[tauri::command]
pub async fn secure_session_logout() -> Result<(), BackendError> {
    let _refresh_guard = REFRESH_LOCK.lock().await;
    let secret = take_session_for_logout().await.map_err(|_| BackendError::Unknown)?;
    if let Some(secret) = secret {
        let refresh_token = secret.refresh_token().to_owned();
        if let Ok(client) = HTTP_CLIENT.as_ref() {
            let revoke = client
                .post(endpoint("/auth/logout"))
                .header(reqwest::header::CONTENT_TYPE, "application/json")
                .json(&serde_json::json!({ "refreshToken": refresh_token }))
                .send();
            let _ = tokio::time::timeout(std::time::Duration::from_secs(5), revoke).await;
        }
    }
    Ok(())
}

#[tauri::command]
pub async fn backend_get_plans() -> Result<SubjectBound<Vec<PlanView>>, SubjectBoundError> {
    authenticated_request(Method::GET, "/subscription/plans", None).await
}

#[tauri::command]
pub async fn backend_get_subscription() -> Result<SubjectBound<Option<SubscriptionView>>, SubjectBoundError> {
    authenticated_request::<Option<InternalSubscription>>(Method::GET, "/subscription/", None)
        .await
        .map(|reply| reply.map(|subscription| subscription.map(Into::into)))
}

#[tauri::command]
pub async fn backend_get_usage() -> Result<SubjectBound<UsageView>, SubjectBoundError> {
    authenticated_request(Method::GET, "/user/usage", None).await
}

#[tauri::command]
pub async fn backend_get_public_benefit() -> Result<SubjectBound<PublicBenefitView>, SubjectBoundError> {
    authenticated_request(Method::GET, "/user/public-benefit", None).await
}

#[tauri::command]
pub async fn backend_claim_public_benefit() -> Result<SubjectBound<PublicBenefitView>, SubjectBoundError> {
    authenticated_request(Method::POST, "/user/public-benefit/claim", Some(serde_json::json!({}))).await
}

#[tauri::command]
pub async fn backend_get_nodes() -> Result<SubjectBound<Vec<NodeView>>, SubjectBoundError> {
    authenticated_request(Method::GET, "/nodes", None).await
}

#[tauri::command]
pub async fn backend_get_user_profile() -> Result<SubjectBound<UserProfileView>, SubjectBoundError> {
    authenticated_request(Method::GET, "/user/profile", None).await
}

#[tauri::command]
pub async fn backend_redeem_promo(code: String) -> Result<SubjectBound<PromoRedeemView>, SubjectBoundError> {
    let code = code.trim();
    if code.is_empty() || code.len() > 128 {
        return Err(SubjectBoundError::without_subject(BackendError::InvalidResponse));
    }
    authenticated_request(
        Method::POST,
        "/promo/redeem-traffic",
        Some(serde_json::json!({ "code": code })),
    )
    .await
}

#[tauri::command]
pub async fn backend_report_traffic(
    node_id: String,
    bytes_up: f64,
    bytes_down: f64,
    timestamp: f64,
) -> Result<SubjectBound<TrafficReportView>, SubjectBoundError> {
    validate_traffic_report(
        &node_id,
        bytes_up,
        bytes_down,
        timestamp,
        Utc::now().timestamp_millis() as f64,
    )
    .map_err(SubjectBoundError::without_subject)?;
    authenticated_request(
        Method::POST,
        "/traffic/report",
        Some(serde_json::json!({
            "nodeId": node_id,
            "bytes_up": bytes_up,
            "bytes_down": bytes_down,
            "timestamp": timestamp,
        })),
    )
    .await
}

fn validate_traffic_report(
    node_id: &str,
    bytes_up: f64,
    bytes_down: f64,
    timestamp: f64,
    now_millis: f64,
) -> BackendResult<()> {
    const MAX_BYTES_PER_REPORT: f64 = 10_000_000_000.0;
    const MAX_CLOCK_SKEW_MILLIS: f64 = 5.0 * 60.0 * 1000.0;
    if node_id.trim().is_empty()
        || node_id.len() > 100
        || !bytes_up.is_finite()
        || !(0.0..=MAX_BYTES_PER_REPORT).contains(&bytes_up)
        || bytes_up.fract() != 0.0
        || !bytes_down.is_finite()
        || !(0.0..=MAX_BYTES_PER_REPORT).contains(&bytes_down)
        || bytes_down.fract() != 0.0
        || !timestamp.is_finite()
        || timestamp <= 0.0
        || timestamp.fract() != 0.0
        || !now_millis.is_finite()
        || (timestamp - now_millis).abs() > MAX_CLOCK_SKEW_MILLIS
    {
        Err(BackendError::InvalidResponse)
    } else {
        Ok(())
    }
}

fn validated_subscription_url(value: &str) -> BackendResult<Url> {
    let base = Url::parse(API_BASE_URL).map_err(|_| BackendError::InvalidResponse)?;
    let value = value.trim();
    let mut candidate = if let Ok(candidate) = Url::parse(value) {
        candidate
    } else {
        if value.len() < 8
            || value.len() > 128
            || !value
                .bytes()
                .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-' || byte == b'_')
        {
            return Err(BackendError::InvalidResponse);
        }
        Url::parse(&endpoint(&format!("/subscription/{value}"))).map_err(|_| BackendError::InvalidResponse)?
    };
    let expected_prefix = format!("{}/subscription/", base.path().trim_end_matches('/'));
    let path_suffix = candidate
        .path()
        .strip_prefix(&expected_prefix)
        .ok_or(BackendError::InvalidResponse)?;
    if candidate.scheme() != "https"
        || candidate.scheme() != base.scheme()
        || candidate.host_str() != base.host_str()
        || candidate.port_or_known_default() != base.port_or_known_default()
        || !candidate.username().is_empty()
        || candidate.password().is_some()
        || candidate.fragment().is_some()
        || path_suffix.is_empty()
        || path_suffix.contains('/')
    {
        return Err(BackendError::InvalidResponse);
    }
    let existing_query: Vec<(String, String)> = candidate
        .query_pairs()
        .filter(|(key, _)| key != "format")
        .map(|(key, value)| (key.into_owned(), value.into_owned()))
        .collect();
    candidate.set_query(None);
    let mut query = candidate.query_pairs_mut();
    query.extend_pairs(existing_query);
    query.append_pair("format", "clash");
    drop(query);
    Ok(candidate)
}

fn is_managed_item(item: &PrfItem, api_base: &Url) -> bool {
    if item.name.as_deref() == Some(MANAGED_PROFILE_NAME)
        && item.desc.as_deref().is_some_and(|desc| {
            desc == MANAGED_PROFILE_MARKER || desc.starts_with(&format!("{MANAGED_PROFILE_MARKER}:"))
        })
    {
        return true;
    }
    item.url.as_ref().is_some_and(|value| {
        Url::parse(value).is_ok_and(|legacy| {
            legacy.scheme() == api_base.scheme()
                && legacy.host_str() == api_base.host_str()
                && legacy.port_or_known_default() == api_base.port_or_known_default()
                && legacy
                    .path()
                    .starts_with(&format!("{}/subscription/", api_base.path().trim_end_matches('/')))
        })
    })
}

fn managed_profile_marker(subject_id: &str) -> std::string::String {
    const FNV_OFFSET_BASIS: u128 = 0x6c62272e07bb014262b821756295c58d;
    const FNV_PRIME: u128 = 0x0000000001000000000000000000013b;
    let fingerprint = subject_id.bytes().fold(FNV_OFFSET_BASIS, |hash, byte| {
        (hash ^ u128::from(byte)).wrapping_mul(FNV_PRIME)
    });
    format!("{MANAGED_PROFILE_MARKER}:{fingerprint:032x}")
}

async fn deactivate_foreign_current_managed_profile(subject_id: &str) -> BackendResult<()> {
    let api_base = Url::parse(API_BASE_URL).map_err(|_| BackendError::InvalidResponse)?;
    let expected_marker = managed_profile_marker(subject_id);
    let profiles = Config::profiles().await.data_arc();
    let current_is_foreign_managed = profiles.current.as_ref().is_some_and(|current| {
        profiles.items.as_ref().into_iter().flatten().any(|item| {
            item.uid.as_ref() == Some(current)
                && is_managed_item(item, &api_base)
                && item.desc.as_deref() != Some(expected_marker.as_str())
        })
    });
    drop(profiles);
    if current_is_foreign_managed {
        deactivate_managed_profiles().await?;
    }
    Ok(())
}

fn managed_profile_option() -> PrfOption {
    PrfOption {
        allow_auto_update: Some(false),
        update_interval: None,
        with_proxy: Some(false),
        self_proxy: Some(false),
        danger_accept_invalid_certs: Some(false),
        ..Default::default()
    }
}

pub(crate) async fn deactivate_managed_profiles() -> BackendResult<()> {
    let _profile_switch_guard = crate::cmd::wait_priority_profile_switch_guard().await;
    let api_base = Url::parse(API_BASE_URL).map_err(|_| BackendError::InvalidResponse)?;
    let profiles = Config::profiles().await.data_arc();
    let managed: Vec<SmartString> = profiles
        .items
        .as_ref()
        .into_iter()
        .flatten()
        .filter(|item| is_managed_item(item, &api_base))
        .filter_map(|item| item.uid.clone())
        .collect();
    let managed_was_current = profiles
        .current
        .as_ref()
        .is_some_and(|current| managed.iter().any(|uid| uid == current));
    drop(profiles);

    if managed_was_current {
        CoreManager::global()
            .stop_core()
            .await
            .map_err(|_| BackendError::Unknown)?;
        handle::Handle::refresh_clash();
    }
    profiles_deactivate_items_safe(&managed)
        .await
        .map_err(|_| BackendError::Unknown)?;
    Ok(())
}

async fn enforce_authoritative_service_block(kind: BackendError) -> BackendError {
    if matches!(
        kind,
        BackendError::Auth | BackendError::ServiceBlocked | BackendError::TrafficExceeded
    ) && deactivate_managed_profiles().await.is_err()
    {
        BackendError::Unknown
    } else {
        kind
    }
}

async fn enforce_authoritative_service_block_for_session(
    kind: BackendError,
    subject_id: &str,
    generation: u64,
) -> BackendResult<BackendError> {
    let _guard = session_operation_guard().await;
    validate_session_snapshot_locked(subject_id, generation).await?;
    Ok(enforce_authoritative_service_block(kind).await)
}

async fn deactivate_managed_profiles_for_session(subject_id: &str, generation: u64) -> BackendResult<()> {
    let _guard = session_operation_guard().await;
    validate_session_snapshot_locked(subject_id, generation).await?;
    deactivate_managed_profiles().await
}

fn classify_managed_profile_status(status: StatusCode) -> Option<BackendError> {
    if status.is_success() {
        None
    } else if status == StatusCode::UNAUTHORIZED || status == StatusCode::FORBIDDEN {
        Some(BackendError::ServiceBlocked)
    } else if status.is_server_error() || status == StatusCode::TOO_MANY_REQUESTS {
        Some(BackendError::Network)
    } else {
        Some(BackendError::Unknown)
    }
}

async fn download_managed_profile_content(subscription_url: Url) -> BackendResult<String> {
    let client = reqwest::Client::builder()
        .use_rustls_tls()
        .https_only(true)
        .redirect(reqwest::redirect::Policy::none())
        .timeout(std::time::Duration::from_secs(20))
        .build()
        .map_err(|_| BackendError::Unknown)?;
    let response = client
        .get(subscription_url)
        .send()
        .await
        .map_err(|_| BackendError::Network)?;
    if let Some(error) = classify_managed_profile_status(response.status()) {
        return Err(error);
    }
    if response
        .content_length()
        .is_some_and(|length| length > MAX_MANAGED_PROFILE_BYTES as u64)
    {
        return Err(BackendError::InvalidResponse);
    }

    let mut body = Vec::new();
    let mut stream = response.bytes_stream();
    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(|_| BackendError::Network)?;
        if body.len().saturating_add(chunk.len()) > MAX_MANAGED_PROFILE_BYTES {
            return Err(BackendError::InvalidResponse);
        }
        body.extend_from_slice(&chunk);
    }
    let body = String::from_utf8(body).map_err(|_| BackendError::InvalidResponse)?;
    let mapping = serde_yaml_ng::from_str::<serde_yaml_ng::Mapping>(body.trim_start_matches('\u{feff}'))
        .map_err(|_| BackendError::InvalidResponse)?;
    if !mapping.contains_key("proxies") && !mapping.contains_key("proxy-providers") {
        return Err(BackendError::InvalidResponse);
    }

    Ok(body)
}

fn build_managed_items(body: String, subject_id: &str) -> BackendResult<Vec<PrfItem>> {
    let marker = managed_profile_marker(subject_id);
    let (mut item, mut helpers) = PrfItem::from_local_detached(
        MANAGED_PROFILE_NAME.into(),
        marker.into(),
        Some(body.into()),
        Some(&managed_profile_option()),
    )
    .map_err(|_| BackendError::Unknown)?;
    item.option = Some(PrfOption {
        allow_auto_update: Some(false),
        with_proxy: Some(false),
        self_proxy: Some(false),
        danger_accept_invalid_certs: Some(false),
        ..item.option.unwrap_or_default()
    });
    helpers.push(item);
    Ok(helpers)
}

async fn remove_created_items(items: &[PrfItem]) {
    for item in items.iter().rev() {
        if let Some(uid) = &item.uid {
            let _ = profiles_delete_item_safe(uid).await;
        }
        if let (Ok(directory), Some(file)) = (dirs::app_profiles_dir(), item.file.as_ref()) {
            match tokio::fs::remove_file(directory.join(file.as_str())).await {
                Ok(()) => {}
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
                Err(_) => {}
            }
        }
    }
    let _ = profiles_save_file_safe().await;
}

fn has_authoritative_service(subscription: &InternalSubscription, now: DateTime<Utc>) -> bool {
    subscription.status == "ACTIVE"
        && DateTime::parse_from_rfc3339(&subscription.expire_at)
            .map(|expires| expires.with_timezone(&Utc) > now)
            .unwrap_or(false)
}

async fn reconcile_managed_subscription_locked(_force: bool, snapshot: SessionSnapshot) -> BackendResult<()> {
    let subject_id = snapshot.secret.subject_id().to_owned();
    let response = match authenticated_request_with_snapshot::<Option<InternalSubscription>>(
        Method::GET,
        "/subscription/",
        None,
        snapshot,
    )
    .await
    {
        Ok(response) => response,
        Err(error) => return Err(error.kind),
    };
    let subscription = response.data;
    let generation = response.generation;
    let Some(subscription) = subscription else {
        return deactivate_managed_profiles_for_session(&subject_id, generation).await;
    };
    if !has_authoritative_service(&subscription, Utc::now()) {
        return deactivate_managed_profiles_for_session(&subject_id, generation).await;
    }

    let subscription_url = validated_subscription_url(&subscription.sub_url)?;
    let api_base = Url::parse(API_BASE_URL).map_err(|_| BackendError::InvalidResponse)?;

    // Fetch and validate before touching the last-known-good managed profile.
    let body = match download_managed_profile_content(subscription_url).await {
        Ok(body) => body,
        Err(error @ (BackendError::Auth | BackendError::ServiceBlocked | BackendError::TrafficExceeded)) => {
            deactivate_managed_profiles_for_session(&subject_id, generation).await?;
            return Err(error);
        }
        Err(error) => return Err(error),
    };
    let mut created = build_managed_items(body, &subject_id)?;
    let staged_uid = created
        .last()
        .and_then(|item| item.uid.clone())
        .ok_or(BackendError::InvalidResponse)?;

    let _session_guard = session_operation_guard().await;
    validate_session_snapshot_locked(&subject_id, generation).await?;
    deactivate_foreign_current_managed_profile(&subject_id).await?;
    let Some(_profile_switch_guard) = crate::cmd::try_profile_switch_guard() else {
        return Err(BackendError::Unknown);
    };
    let profiles = Config::profiles().await.data_arc();
    let managed: Vec<SmartString> = profiles
        .items
        .as_ref()
        .into_iter()
        .flatten()
        .filter(|item| is_managed_item(item, &api_base))
        .filter_map(|item| item.uid.clone())
        .collect();
    let activation_previous = profiles.current.clone();
    drop(profiles);

    for item in &mut created {
        if profiles_append_item_preserve_current_safe(item).await.is_err() {
            remove_created_items(&created).await;
            return Err(BackendError::Unknown);
        }
    }
    if profiles_save_file_safe().await.is_err() {
        remove_created_items(&created).await;
        return Err(BackendError::Unknown);
    }

    match crate::cmd::patch_profiles_config_if_current_under_guard(
        IProfiles {
            current: Some(staged_uid),
            items: None,
        },
        activation_previous,
    )
    .await
    {
        Ok(true) => {}
        Ok(false) => {
            remove_created_items(&created).await;
            return Err(BackendError::Unknown);
        }
        Err(_) => {
            remove_created_items(&created).await;
            return Err(BackendError::Unknown);
        }
    };
    if profiles_save_file_safe().await.is_err() {
        return Err(BackendError::Unknown);
    }

    profiles_retire_items_safe(&managed)
        .await
        .map_err(|_| BackendError::Unknown)?;
    Ok(())
}

async fn reconcile_managed_subscription(force: bool) -> Result<SubjectBound<()>, SubjectBoundError> {
    let snapshot = session_snapshot().await.map_err(SubjectBoundError::without_subject)?;
    let subject_id = snapshot.secret.subject_id().to_owned();
    match reconcile_managed_subscription_locked(force, snapshot).await {
        Ok(data) => Ok(SubjectBound { subject_id, data }),
        Err(kind) => Err(SubjectBoundError::for_subject(subject_id, kind)),
    }
}

#[tauri::command]
pub async fn managed_subscription_sync(force: bool) -> Result<SubjectBound<()>, SubjectBoundError> {
    let _guard = MANAGED_SYNC_LOCK.lock().await;
    reconcile_managed_subscription(force).await
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fixture_plan() -> PlanView {
        PlanView {
            id: "plan".into(),
            name: "Standard".into(),
            description: None,
            price: 10.0,
            duration: 30,
            billing_period: None,
            billing_cycle: None,
            interval: None,
            period: None,
            cycle: None,
            traffic_limit: 1000.0,
            speed_limit: Some(150.0),
            max_devices: 3,
        }
    }

    #[test]
    fn subscription_and_node_views_omit_transport_secrets() -> Result<(), serde_json::Error> {
        let subscription = SubscriptionView {
            id: "subscription".into(),
            plan_id: "plan".into(),
            traffic_used: 42.0,
            start_at: "2026-01-01".into(),
            expire_at: "2026-02-01".into(),
            status: "ACTIVE".into(),
            plan: fixture_plan(),
        };
        let node = NodeView {
            id: "node".into(),
            name: "Tokyo".into(),
            protocol: "vless".into(),
            region: "JP".into(),
            is_active: true,
        };
        let serialized = serde_json::to_string(&(subscription, node))?;
        for forbidden in ["subUrl", "host", "port", "token", "Authorization", "secret.example"] {
            assert!(!serialized.contains(forbidden), "serialized DTO leaked {forbidden}");
        }
        Ok(())
    }

    #[test]
    fn errors_serialize_to_categories_only() -> Result<(), serde_json::Error> {
        for (error, expected) in [
            (BackendError::Auth, "\"auth\""),
            (BackendError::ServiceBlocked, "\"service_blocked\""),
            (BackendError::TrafficExceeded, "\"traffic_exceeded\""),
            (BackendError::Network, "\"network\""),
            (BackendError::InvalidResponse, "\"invalid_response\""),
            (BackendError::Unknown, "\"unknown\""),
        ] {
            let serialized = serde_json::to_string(&error)?;
            assert_eq!(serialized, expected);
        }
        Ok(())
    }

    #[test]
    fn managed_profile_http_status_distinguishes_authoritative_denial() {
        assert_eq!(classify_managed_profile_status(StatusCode::OK), None);
        assert_eq!(
            classify_managed_profile_status(StatusCode::UNAUTHORIZED),
            Some(BackendError::ServiceBlocked)
        );
        assert_eq!(
            classify_managed_profile_status(StatusCode::FORBIDDEN),
            Some(BackendError::ServiceBlocked)
        );
        assert_eq!(
            classify_managed_profile_status(StatusCode::TOO_MANY_REQUESTS),
            Some(BackendError::Network)
        );
        assert_eq!(
            classify_managed_profile_status(StatusCode::BAD_GATEWAY),
            Some(BackendError::Network)
        );
    }

    #[test]
    fn business_forbidden_responses_do_not_poison_the_session() {
        for code in [
            "SUB_REQUIRED",
            "EMAIL_NOT_VERIFIED",
            "PUBLIC_BENEFIT_TRIAL_ONLY",
            "NO_ACTIVE_SUB",
        ] {
            assert_eq!(
                categorize_response(StatusCode::FORBIDDEN, Some(code), "/business"),
                BackendError::Unknown
            );
        }
        for code in ["ACCOUNT_INACTIVE", "ACCOUNT_SUSPENDED", "TOKEN_REVOKED"] {
            assert_eq!(
                categorize_response(StatusCode::FORBIDDEN, Some(code), "/business"),
                BackendError::ServiceBlocked
            );
        }
        assert_eq!(
            categorize_response(StatusCode::UNAUTHORIZED, Some("UNAUTHORIZED"), "/business"),
            BackendError::Auth
        );
    }

    #[test]
    fn traffic_report_validation_rejects_unsafe_values() {
        let now = 1_700_000_000_000.0;
        assert_eq!(validate_traffic_report("node", 0.0, 1.0, now, now), Ok(()));
        for result in [
            validate_traffic_report("", 0.0, 0.0, now, now),
            validate_traffic_report("node", -1.0, 0.0, now, now),
            validate_traffic_report("node", 0.5, 0.0, now, now),
            validate_traffic_report("node", 0.0, 10_000_000_001.0, now, now),
            validate_traffic_report("node", 0.0, f64::INFINITY, now, now),
            validate_traffic_report("node", 0.0, 0.0, f64::NAN, now),
            validate_traffic_report("node", 0.0, 0.0, now - 300_001.0, now),
            validate_traffic_report(&"n".repeat(101), 0.0, 0.0, now, now),
        ] {
            assert_eq!(result, Err(BackendError::InvalidResponse));
        }
        assert_eq!(
            categorize_response(StatusCode::FORBIDDEN, Some("TRAFFIC_EXCEEDED"), "/traffic/report"),
            BackendError::TrafficExceeded
        );
    }

    #[test]
    fn usage_accepts_authoritative_null_plan() {
        let usage = serde_json::from_value::<UsageView>(serde_json::json!({
            "trafficUsed": "0",
            "trafficLimit": "0",
            "trafficRemaining": "0",
            "percentUsed": 0,
            "plan": null,
            "status": "EXPIRED",
            "expireAt": "2026-01-01T00:00:00Z",
            "startAt": "2025-01-01T00:00:00Z"
        }));
        assert!(usage.is_ok());
        assert!(usage.ok().and_then(|value| value.plan).is_none());
    }

    #[test]
    fn managed_subscription_url_is_fixed_to_production_service() -> Result<(), BackendError> {
        for source in [
            "opaque-token-fixture",
            "https://api.xxlink.net/api/v1/subscription/opaque-token-fixture",
        ] {
            let valid = validated_subscription_url(source)?;
            assert_eq!(valid.query(), Some("format=clash"));
            assert_eq!(valid.host_str(), Some("api.xxlink.net"));
        }
        let authorized = validated_subscription_url(
            "https://api.xxlink.net/api/v1/subscription/profile?token=credential-fixture&format=sing-box",
        )?;
        let query: std::collections::HashMap<_, _> = authorized.query_pairs().into_owned().collect();
        assert_eq!(query.get("token").map(String::as_str), Some("credential-fixture"));
        assert_eq!(query.get("format").map(String::as_str), Some("clash"));
        for invalid in [
            "short",
            "token/with/path",
            "token?with=query",
            "http://api.xxlink.net/api/v1/subscription/token",
            "https://example.com/api/v1/subscription/token",
            "https://api.xxlink.net/api/v1/other/token",
            "https://api.xxlink.net/api/v1/subscription/token/extra",
        ] {
            assert_eq!(validated_subscription_url(invalid), Err(BackendError::InvalidResponse));
        }
        Ok(())
    }

    #[test]
    fn managed_item_set_is_fully_detached_before_persistence() -> Result<(), BackendError> {
        let items = build_managed_items("proxies: []".into(), "subject-a")?;
        assert_eq!(items.len(), 6);
        let main = items.last().ok_or(BackendError::InvalidResponse)?;
        let helper_ids: Vec<&str> = items[..5].iter().filter_map(|item| item.uid.as_deref()).collect();
        let option = main.option.as_ref().ok_or(BackendError::InvalidResponse)?;
        assert_eq!(main.desc.as_deref(), Some(managed_profile_marker("subject-a").as_str()));
        assert_ne!(managed_profile_marker("subject-a"), managed_profile_marker("subject-b"));
        for uid in [
            option.merge.as_deref(),
            option.script.as_deref(),
            option.rules.as_deref(),
            option.proxies.as_deref(),
            option.groups.as_deref(),
        ] {
            assert!(uid.is_some_and(|value| helper_ids.contains(&value)));
        }
        Ok(())
    }

    #[test]
    fn authoritative_inactive_or_expired_subscription_blocks_managed_service() {
        let now = DateTime::parse_from_rfc3339("2026-07-21T12:00:00Z").map(|value| value.with_timezone(&Utc));
        assert!(now.is_ok());
        let now = now.unwrap_or_else(|_| Utc::now());
        let fixture = |status: &str, expire_at: &str| InternalSubscription {
            id: "subscription".into(),
            plan_id: "plan".into(),
            sub_url: "https://api.xxlink.net/api/v1/subscription/fixture".into(),
            traffic_used: 0.0,
            start_at: "2026-01-01T00:00:00Z".into(),
            expire_at: expire_at.into(),
            status: status.into(),
            plan: fixture_plan(),
        };
        assert!(has_authoritative_service(
            &fixture("ACTIVE", "2026-07-22T00:00:00Z"),
            now
        ));
        assert!(!has_authoritative_service(
            &fixture("EXPIRED", "2026-07-22T00:00:00Z"),
            now
        ));
        assert!(!has_authoritative_service(
            &fixture("ACTIVE", "2026-07-20T00:00:00Z"),
            now
        ));
    }
}
