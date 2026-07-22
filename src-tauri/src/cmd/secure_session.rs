use keyring::{Entry, Error as KeyringError};
use serde::{Deserialize, Serialize};
use tokio::sync::{Mutex, MutexGuard};

const VAULT_SERVICE: &str = "com.xxlink.desktop.secure-session";
const VAULT_ACCOUNT: &str = "primary";
const VAULT_VERSION: u8 = 1;
static SESSION_OPERATION_LOCK: Mutex<()> = Mutex::const_new(());

#[derive(Clone, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SecureSessionSecret {
    version: u8,
    subject_id: String,
    access_token: String,
    refresh_token: String,
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
}

pub(crate) async fn session_operation_guard() -> MutexGuard<'static, ()> {
    SESSION_OPERATION_LOCK.lock().await
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

pub(crate) async fn read_secret_internal() -> Result<Option<SecureSessionSecret>, ()> {
    tauri::async_runtime::spawn_blocking(read_secret)
        .await
        .map_err(|_| ())?
        .map_err(|_| ())
}

pub(crate) async fn write_secret_internal(secret: SecureSessionSecret) -> Result<(), ()> {
    let encoded = encode_secret(
        secret.subject_id.clone(),
        secret.access_token.clone(),
        secret.refresh_token.clone(),
    )
    .map_err(|_| ())?;
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

#[tauri::command]
pub async fn secure_session_read() -> Result<Option<SecureSessionSecret>, String> {
    let _guard = session_operation_guard().await;
    tauri::async_runtime::spawn_blocking(read_secret)
        .await
        .map_err(|_| VaultErrorKind::ReadFailed.to_string())?
        .map_err(|error| error.to_string())
}

#[tauri::command]
pub async fn secure_session_write(
    subject_id: String,
    access_token: String,
    refresh_token: String,
) -> Result<(), String> {
    let _guard = session_operation_guard().await;
    let existing = read_secret_internal()
        .await
        .map_err(|_| VaultErrorKind::ReadFailed.to_string())?;
    if existing
        .as_ref()
        .is_some_and(|secret| secret.subject_id() != subject_id)
    {
        crate::cmd::backend_controller::deactivate_managed_profiles()
            .await
            .map_err(|_| VaultErrorKind::WriteFailed.to_string())?;
    }
    let encoded = encode_secret(subject_id, access_token, refresh_token).map_err(|error| error.to_string())?;
    tauri::async_runtime::spawn_blocking(move || {
        entry()?.set_password(&encoded).map_err(|_| VaultErrorKind::WriteFailed)
    })
    .await
    .map_err(|_| VaultErrorKind::WriteFailed.to_string())?
    .map_err(|error| error.to_string())
}

#[tauri::command]
pub async fn secure_session_delete() -> Result<(), String> {
    let _guard = session_operation_guard().await;
    crate::cmd::backend_controller::deactivate_managed_profiles()
        .await
        .map_err(|_| VaultErrorKind::DeleteFailed.to_string())?;
    tauri::async_runtime::spawn_blocking(move || match entry()?.delete_credential() {
        Ok(()) | Err(KeyringError::NoEntry) => Ok(()),
        Err(_) => Err(VaultErrorKind::DeleteFailed),
    })
    .await
    .map_err(|_| VaultErrorKind::DeleteFailed.to_string())?
    .map_err(|error| error.to_string())
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
