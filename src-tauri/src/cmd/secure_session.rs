use keyring::{Entry, Error as KeyringError};
use serde::{Deserialize, Serialize};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use tokio::sync::{Mutex, MutexGuard};

const VAULT_SERVICE: &str = "com.xxlink.desktop.secure-session";
const VAULT_ACCOUNT: &str = "primary";
const VAULT_LOGOUT_MARKER_ACCOUNT: &str = "logout-pending";
const VAULT_VERSION: u8 = 1;
static SESSION_OPERATION_LOCK: Mutex<()> = Mutex::const_new(());
static VAULT_IO_LOCK: Mutex<()> = Mutex::const_new(());
static LOGOUT_REQUESTED: AtomicBool = AtomicBool::new(false);
static SESSION_GENERATION: AtomicU64 = AtomicU64::new(1);
static LOGIN_ATTEMPT_GENERATION: AtomicU64 = AtomicU64::new(1);

#[derive(Clone, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SecureSessionSecret {
    version: u8,
    subject_id: String,
    access_token: String,
    refresh_token: String,
    #[serde(default)]
    logout_pending: bool,
}

impl SecureSessionSecret {
    pub(crate) fn subject_id(&self) -> &str {
        &self.subject_id
    }

    pub(crate) fn access_token(&self) -> &str {
        &self.access_token
    }

    pub(crate) fn refresh_token(&self) -> &str {
        &self.refresh_token
    }

    pub(crate) const fn is_logout_pending(&self) -> bool {
        self.logout_pending
    }
}

pub(crate) async fn session_operation_guard() -> MutexGuard<'static, ()> {
    SESSION_OPERATION_LOCK.lock().await
}

pub(crate) fn session_generation() -> u64 {
    SESSION_GENERATION.load(Ordering::Acquire)
}

fn advance_session_generation() {
    SESSION_GENERATION.fetch_add(1, Ordering::AcqRel);
}

pub(crate) fn begin_login_attempt() -> u64 {
    LOGIN_ATTEMPT_GENERATION.fetch_add(1, Ordering::AcqRel) + 1
}

fn invalidate_login_attempts() {
    LOGIN_ATTEMPT_GENERATION.fetch_add(1, Ordering::AcqRel);
}

#[derive(Clone, Copy, Debug, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
enum VaultErrorKind {
    Unavailable,
    Corrupted,
    WriteFailed,
    ReadFailed,
    DeleteFailed,
}

impl std::fmt::Display for VaultErrorKind {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        let value = match self {
            Self::Unavailable => "unavailable",
            Self::Corrupted => "corrupted",
            Self::WriteFailed => "write_failed",
            Self::ReadFailed => "read_failed",
            Self::DeleteFailed => "delete_failed",
        };
        formatter.write_str(value)
    }
}

fn entry() -> Result<Entry, VaultErrorKind> {
    Entry::new(VAULT_SERVICE, VAULT_ACCOUNT).map_err(|_| VaultErrorKind::Unavailable)
}

fn logout_marker_entry() -> Result<Entry, VaultErrorKind> {
    Entry::new(VAULT_SERVICE, VAULT_LOGOUT_MARKER_ACCOUNT).map_err(|_| VaultErrorKind::Unavailable)
}

fn decode_secret(value: &str) -> Result<SecureSessionSecret, VaultErrorKind> {
    let secret = serde_json::from_str::<SecureSessionSecret>(value).map_err(|_| VaultErrorKind::Corrupted)?;
    if secret.version != VAULT_VERSION
        || secret.access_token.trim().is_empty()
        || secret.refresh_token.trim().is_empty()
        || secret.subject_id.trim().is_empty()
    {
        return Err(VaultErrorKind::Corrupted);
    }
    Ok(secret)
}

fn encode_secret(subject_id: String, access_token: String, refresh_token: String) -> Result<String, VaultErrorKind> {
    if subject_id.trim().is_empty() || access_token.trim().is_empty() || refresh_token.trim().is_empty() {
        return Err(VaultErrorKind::Corrupted);
    }
    serde_json::to_string(&SecureSessionSecret {
        version: VAULT_VERSION,
        subject_id,
        access_token,
        refresh_token,
        logout_pending: false,
    })
    .map_err(|_| VaultErrorKind::WriteFailed)
}

fn read_secret() -> Result<Option<SecureSessionSecret>, VaultErrorKind> {
    match entry()?.get_password() {
        Ok(value) => decode_secret(&value).map(Some),
        Err(KeyringError::NoEntry) => Ok(None),
        Err(_) => Err(VaultErrorKind::ReadFailed),
    }
}

async fn read_secret_raw_internal() -> Result<Option<SecureSessionSecret>, ()> {
    let _guard = VAULT_IO_LOCK.lock().await;
    tauri::async_runtime::spawn_blocking(read_secret)
        .await
        .map_err(|_| ())?
        .map_err(|_| ())
}

pub(crate) async fn read_secret_internal() -> Result<Option<SecureSessionSecret>, ()> {
    if LOGOUT_REQUESTED.load(Ordering::Acquire) {
        return Ok(None);
    }
    let secret = read_secret_raw_internal().await?;
    if LOGOUT_REQUESTED.load(Ordering::Acquire) {
        Ok(None)
    } else {
        Ok(secret.filter(|value| !value.is_logout_pending()))
    }
}

pub(crate) async fn write_secret_internal(secret: SecureSessionSecret) -> Result<(), ()> {
    let _guard = VAULT_IO_LOCK.lock().await;
    if LOGOUT_REQUESTED.load(Ordering::Acquire) {
        return Err(());
    }
    write_secret_without_guard(secret).await?;
    advance_session_generation();
    Ok(())
}

pub(crate) async fn replace_active_session_for_login(
    secret: SecureSessionSecret,
    login_attempt: u64,
) -> Result<(), ()> {
    let _guard = session_operation_guard().await;
    if LOGIN_ATTEMPT_GENERATION.load(Ordering::Acquire) != login_attempt {
        return Err(());
    }
    if read_logout_marker_internal().await? {
        crate::cmd::backend_controller::deactivate_managed_profiles()
            .await
            .map_err(|_| ())?;
        delete_credential_internal().await?;
        delete_logout_marker_internal().await?;
    }
    let existing = read_secret_raw_internal().await?;
    if existing
        .as_ref()
        .is_some_and(|current| current.subject_id() != secret.subject_id() || current.is_logout_pending())
    {
        crate::cmd::backend_controller::deactivate_managed_profiles()
            .await
            .map_err(|_| ())?;
    }
    LOGOUT_REQUESTED.store(false, Ordering::Release);
    write_secret_internal(secret).await
}

async fn write_pending_secret_internal(secret: SecureSessionSecret) -> Result<(), ()> {
    let _guard = VAULT_IO_LOCK.lock().await;
    write_secret_without_guard(secret).await
}

async fn write_secret_without_guard(secret: SecureSessionSecret) -> Result<(), ()> {
    let encoded = serde_json::to_string(&secret).map_err(|_| ())?;
    tauri::async_runtime::spawn_blocking(move || {
        let vault = entry()?;
        vault.set_password(&encoded).map_err(|_| VaultErrorKind::WriteFailed)?;
        let confirmed = vault
            .get_password()
            .map_err(|_| VaultErrorKind::ReadFailed)
            .and_then(|value| decode_secret(&value))?;
        if confirmed == secret {
            Ok(())
        } else {
            Err(VaultErrorKind::ReadFailed)
        }
    })
    .await
    .map_err(|_| ())?
    .map_err(|_| ())
}

pub(crate) fn replacement_secret(
    subject_id: String,
    access_token: String,
    refresh_token: String,
) -> Result<SecureSessionSecret, ()> {
    decode_secret(&encode_secret(subject_id, access_token, refresh_token).map_err(|_| ())?).map_err(|_| ())
}

#[derive(Serialize)]
#[serde(rename_all = "snake_case")]
pub enum SecureSessionProbe {
    Operational,
    Missing,
    SubjectMismatch,
}

#[tauri::command]
pub async fn secure_session_probe(subject_id: String) -> Result<SecureSessionProbe, String> {
    let _guard = session_operation_guard().await;
    let secret = read_secret_internal()
        .await
        .map_err(|_| VaultErrorKind::ReadFailed.to_string())?;
    Ok(match secret {
        Some(secret) if secret.subject_id() == subject_id => SecureSessionProbe::Operational,
        Some(_) => SecureSessionProbe::SubjectMismatch,
        None => SecureSessionProbe::Missing,
    })
}

#[tauri::command]
pub async fn secure_session_migrate_legacy(
    subject_id: String,
    access_token: String,
    refresh_token: String,
) -> Result<(), String> {
    let _guard = session_operation_guard().await;
    if read_secret_raw_internal()
        .await
        .map_err(|_| VaultErrorKind::ReadFailed.to_string())?
        .is_some()
    {
        return Err(VaultErrorKind::WriteFailed.to_string());
    }
    let secret = replacement_secret(subject_id, access_token, refresh_token)
        .map_err(|_| VaultErrorKind::Corrupted.to_string())?;
    LOGOUT_REQUESTED.store(false, Ordering::Release);
    write_secret_internal(secret)
        .await
        .map_err(|_| VaultErrorKind::WriteFailed.to_string())
}

pub(crate) async fn take_session_for_logout() -> Result<Option<SecureSessionSecret>, String> {
    LOGOUT_REQUESTED.store(true, Ordering::Release);
    invalidate_login_attempts();
    advance_session_generation();
    let marker_written = write_logout_marker_internal().await.is_ok();
    let _guard = session_operation_guard().await;
    let secret = read_secret_raw_internal().await.ok().flatten();
    if let Some(mut pending_secret) = secret.clone() {
        pending_secret.logout_pending = true;
        let _ = write_pending_secret_internal(pending_secret).await;
    }
    let profiles_cleaned = crate::cmd::backend_controller::deactivate_managed_profiles()
        .await
        .is_ok();
    let credential_cleaned = delete_credential_internal().await.is_ok();
    let marker_cleaned = if profiles_cleaned && credential_cleaned {
        delete_logout_marker_internal().await.is_ok()
    } else {
        false
    };
    if profiles_cleaned && credential_cleaned && marker_cleaned {
        Ok(secret)
    } else {
        if !marker_written {
            let _ = write_logout_marker_internal().await;
        }
        Err(VaultErrorKind::DeleteFailed.to_string())
    }
}

async fn delete_credential_internal() -> Result<(), ()> {
    let _guard = VAULT_IO_LOCK.lock().await;
    tauri::async_runtime::spawn_blocking(move || match entry()?.delete_credential() {
        Ok(()) | Err(KeyringError::NoEntry) => Ok(()),
        Err(_) => Err(VaultErrorKind::DeleteFailed),
    })
    .await
    .map_err(|_| ())?
    .map_err(|_| ())
}

async fn write_logout_marker_internal() -> Result<(), ()> {
    let _guard = VAULT_IO_LOCK.lock().await;
    tauri::async_runtime::spawn_blocking(move || {
        logout_marker_entry()?
            .set_password("pending")
            .map_err(|_| VaultErrorKind::WriteFailed)
    })
    .await
    .map_err(|_| ())?
    .map_err(|_| ())
}

async fn read_logout_marker_internal() -> Result<bool, ()> {
    let _guard = VAULT_IO_LOCK.lock().await;
    tauri::async_runtime::spawn_blocking(move || match logout_marker_entry()?.get_password() {
        Ok(_) => Ok(true),
        Err(KeyringError::NoEntry) => Ok(false),
        Err(_) => Err(VaultErrorKind::ReadFailed),
    })
    .await
    .map_err(|_| ())?
    .map_err(|_| ())
}

async fn delete_logout_marker_internal() -> Result<(), ()> {
    let _guard = VAULT_IO_LOCK.lock().await;
    tauri::async_runtime::spawn_blocking(move || match logout_marker_entry()?.delete_credential() {
        Ok(()) | Err(KeyringError::NoEntry) => Ok(()),
        Err(_) => Err(VaultErrorKind::DeleteFailed),
    })
    .await
    .map_err(|_| ())?
    .map_err(|_| ())
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PendingLogoutRecovery {
    pending: bool,
    cleaned: bool,
}

#[tauri::command]
pub async fn secure_session_recover_pending_logout() -> Result<PendingLogoutRecovery, String> {
    let marker_pending = read_logout_marker_internal()
        .await
        .map_err(|_| VaultErrorKind::ReadFailed.to_string())?;
    let secret_pending = read_secret_raw_internal()
        .await
        .map(|secret| secret.is_some_and(|value| value.is_logout_pending()))
        .unwrap_or(marker_pending);
    let pending = marker_pending || secret_pending;
    if !pending {
        return Ok(PendingLogoutRecovery {
            pending: false,
            cleaned: true,
        });
    }

    LOGOUT_REQUESTED.store(true, Ordering::Release);
    invalidate_login_attempts();
    advance_session_generation();
    let _guard = session_operation_guard().await;
    let profiles_cleaned = crate::cmd::backend_controller::deactivate_managed_profiles()
        .await
        .is_ok();
    let credential_cleaned = delete_credential_internal().await.is_ok();
    let marker_cleaned = if profiles_cleaned && credential_cleaned {
        delete_logout_marker_internal().await.is_ok()
    } else {
        false
    };
    let cleaned = profiles_cleaned && credential_cleaned && marker_cleaned;
    Ok(PendingLogoutRecovery { pending: true, cleaned })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn session_secret_round_trips_without_logging_material() {
        let decoded = encode_secret("user-fixture".into(), "access-fixture".into(), "refresh-fixture".into())
            .and_then(|encoded| decode_secret(&encoded));
        assert!(
            decoded
                == Ok(SecureSessionSecret {
                    version: VAULT_VERSION,
                    subject_id: "user-fixture".into(),
                    access_token: "access-fixture".into(),
                    refresh_token: "refresh-fixture".into(),
                    logout_pending: false,
                })
        );
    }

    #[test]
    fn malformed_or_partial_secret_is_rejected() {
        for fixture in [
            "not-json",
            r#"{"version":1,"subjectId":"","accessToken":"access","refreshToken":"refresh"}"#,
            r#"{"version":1,"subjectId":"user","accessToken":"","refreshToken":"refresh"}"#,
            r#"{"version":1,"subjectId":"user","accessToken":"access","refreshToken":""}"#,
            r#"{"version":2,"subjectId":"user","accessToken":"access","refreshToken":"refresh"}"#,
        ] {
            assert!(matches!(decode_secret(fixture), Err(VaultErrorKind::Corrupted)));
        }
    }

    #[test]
    fn legacy_secret_defaults_to_active_and_pending_secret_round_trips() {
        assert_eq!(
            decode_secret(r#"{"version":1,"subjectId":"user","accessToken":"access","refreshToken":"refresh"}"#)
                .map(|secret| secret.is_logout_pending()),
            Ok(false)
        );
        assert_eq!(
            decode_secret(
                r#"{"version":1,"subjectId":"user","accessToken":"access","refreshToken":"refresh","logoutPending":true}"#,
            )
            .map(|secret| secret.is_logout_pending()),
            Ok(true)
        );
    }

    #[test]
    fn newest_login_attempt_invalidates_older_attempts() {
        let older = begin_login_attempt();
        let newer = begin_login_attempt();
        assert_ne!(older, newer);
        assert_eq!(LOGIN_ATTEMPT_GENERATION.load(Ordering::Acquire), newer);
    }

    #[tokio::test]
    async fn session_operation_guard_blocks_account_replacement_until_request_finishes() {
        let first = session_operation_guard().await;
        assert!(
            tokio::time::timeout(std::time::Duration::from_millis(10), session_operation_guard())
                .await
                .is_err()
        );
        drop(first);
        assert!(
            tokio::time::timeout(std::time::Duration::from_secs(1), session_operation_guard())
                .await
                .is_ok()
        );
    }
}
