use super::CmdResult;
use crate::core::{
    CoreManager,
    service::{self, SERVICE_MANAGER, ServiceStatus},
};
use smartstring::SmartString;
#[cfg(any(target_os = "linux", target_os = "macos"))]
use std::fs;
use std::io;
use std::io::ErrorKind;

#[derive(Clone, Copy, Debug, Eq, PartialEq, serde::Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ServiceAvailabilityView {
    Absent,
    Ready,
    InstalledUnavailable,
}

impl ServiceAvailabilityView {
    pub(super) const fn is_ready(self) -> bool {
        matches!(self, Self::Ready)
    }

    pub(super) const fn is_installed(self) -> bool {
        !matches!(self, Self::Absent)
    }
}

async fn execute_service_operation_sync(status: ServiceStatus, op_type: &str) -> CmdResult {
    if let Err(e) = SERVICE_MANAGER.lock().await.handle_service_status(&status).await {
        let emsg = format!("{} Service failed: {}", op_type, e);
        return Err(SmartString::from(emsg));
    }
    Ok(())
}

#[tauri::command]
pub async fn install_service() -> CmdResult {
    execute_service_operation_sync(ServiceStatus::InstallRequired, "Install").await
}

#[tauri::command]
pub async fn uninstall_service() -> CmdResult {
    execute_service_operation_sync(ServiceStatus::UninstallRequired, "Uninstall").await
}

#[tauri::command]
pub async fn get_service_availability() -> CmdResult<ServiceAvailabilityView> {
    let _transaction_guard = CoreManager::begin_config_transaction().await;
    probe_service_availability().await
}

pub(crate) async fn probe_service_availability() -> CmdResult<ServiceAvailabilityView> {
    if service::is_service_available().await.is_ok() {
        return Ok(ServiceAvailabilityView::Ready);
    }

    classify_service_availability(service_registration_present().map_err(|_| ()))
}

fn classify_service_availability(registration_present: Result<bool, ()>) -> CmdResult<ServiceAvailabilityView> {
    match registration_present {
        Ok(true) => Ok(ServiceAvailabilityView::InstalledUnavailable),
        Ok(false) => Ok(ServiceAvailabilityView::Absent),
        Err(()) => Err(SmartString::from("service_probe_failed")),
    }
}

fn classify_registration_open_result(result: io::Result<()>) -> io::Result<bool> {
    match result {
        Ok(()) => Ok(true),
        Err(error) if error.kind() == ErrorKind::NotFound => Ok(false),
        Err(error) => Err(error),
    }
}

#[cfg(target_os = "windows")]
fn service_registration_present() -> io::Result<bool> {
    use winreg::{
        RegKey,
        enums::{HKEY_LOCAL_MACHINE, KEY_READ},
    };

    let hklm = RegKey::predef(HKEY_LOCAL_MACHINE);
    classify_registration_open_result(
        hklm.open_subkey_with_flags(r"SYSTEM\CurrentControlSet\Services\xxlink_service", KEY_READ)
            .map(|_| ()),
    )
}

#[cfg(target_os = "linux")]
fn service_registration_present() -> io::Result<bool> {
    registration_path_present("/etc/systemd/system/xxlink-service.service")
}

#[cfg(target_os = "macos")]
fn service_registration_present() -> io::Result<bool> {
    registration_path_present("/Library/LaunchDaemons/com.xxlink.desktop.service.plist")
}

#[cfg(not(any(target_os = "windows", target_os = "linux", target_os = "macos")))]
fn service_registration_present() -> io::Result<bool> {
    Ok(false)
}

#[cfg(any(target_os = "linux", target_os = "macos"))]
fn registration_path_present(path: &str) -> io::Result<bool> {
    match fs::symlink_metadata(path) {
        Ok(metadata) if metadata.file_type().is_file() || metadata.file_type().is_symlink() => Ok(true),
        Ok(_) => Err(io::Error::new(
            ErrorKind::InvalidData,
            "service registration path is not a file or symlink",
        )),
        Err(error) if error.kind() == ErrorKind::NotFound => Ok(false),
        Err(error) => Err(error),
    }
}

#[cfg(test)]
mod runtime_boundary_tests {
    #[cfg(any(target_os = "linux", target_os = "macos"))]
    use super::registration_path_present;
    use super::{ServiceAvailabilityView, classify_registration_open_result, classify_service_availability};

    #[test]
    fn registration_state_preserves_absent_unavailable_and_unknown() {
        assert!(matches!(
            classify_service_availability(Ok(false)),
            Ok(ServiceAvailabilityView::Absent)
        ));
        assert!(matches!(
            classify_service_availability(Ok(true)),
            Ok(ServiceAvailabilityView::InstalledUnavailable)
        ));
        assert!(classify_service_availability(Err(())).is_err());
    }

    #[test]
    fn registration_open_result_preserves_present_absent_and_probe_errors() {
        assert!(matches!(classify_registration_open_result(Ok(())), Ok(true)));
        assert!(matches!(
            classify_registration_open_result(Err(std::io::Error::from(std::io::ErrorKind::NotFound))),
            Ok(false)
        ));
        assert!(matches!(
            classify_registration_open_result(Err(std::io::Error::from(
                std::io::ErrorKind::PermissionDenied
            ))),
            Err(error) if error.kind() == std::io::ErrorKind::PermissionDenied
        ));
    }

    #[cfg(any(target_os = "linux", target_os = "macos"))]
    #[test]
    fn registration_path_rejects_directories() -> std::io::Result<()> {
        use std::{
            fs, io,
            time::{SystemTime, UNIX_EPOCH},
        };

        let unique = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map_err(io::Error::other)?
            .as_nanos();
        let root = std::env::temp_dir().join(format!("xxlink-service-registration-{}-{unique}", std::process::id()));
        fs::create_dir(&root)?;

        let result = registration_path_present(
            root.to_str()
                .ok_or_else(|| io::Error::other("temporary path is not UTF-8"))?,
        );
        fs::remove_dir(&root)?;

        assert_eq!(
            result
                .expect_err("directory was accepted as service registration")
                .kind(),
            io::ErrorKind::InvalidData
        );
        Ok(())
    }
}
