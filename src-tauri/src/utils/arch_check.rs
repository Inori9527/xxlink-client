//! Helpers for detecting a CPU architecture mismatch between the host
//! process and a bundled sidecar executable.
//!
//! When a user installs the wrong architecture package of XXLink (or the
//! sidecar is replaced by an AV / manual swap), launching
//! `verge-mihomo.exe` fails with Windows OS error 216
//! (`ERROR_EXE_MACHINE_TYPE_MISMATCH`) and Windows pops a modal dialog
//! before the Rust error ever bubbles up. We want to catch that case early
//! and surface a clear, actionable notification to the UI instead of the
//! misleading "subscription config validation failed" fallback.

use std::fmt;
use std::path::Path;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum BinaryArch {
    X86,
    X64,
    Arm,
    Arm64,
    Unknown(u16),
    NotPe,
}

impl BinaryArch {
    pub fn label(&self) -> String {
        match self {
            BinaryArch::X86 => "x86".to_string(),
            BinaryArch::X64 => "x64".to_string(),
            BinaryArch::Arm => "ARM".to_string(),
            BinaryArch::Arm64 => "ARM64".to_string(),
            BinaryArch::Unknown(code) => format!("unknown(0x{code:04x})"),
            BinaryArch::NotPe => "non-PE".to_string(),
        }
    }
}

impl fmt::Display for BinaryArch {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.label())
    }
}

/// Architecture the host process was compiled for. On Windows, Windows will
/// only launch a child process whose PE machine type matches this (or a
/// subset that is emulated — see [`is_compatible`]).
pub const fn host_arch() -> BinaryArch {
    #[cfg(target_arch = "x86")]
    {
        BinaryArch::X86
    }
    #[cfg(target_arch = "x86_64")]
    {
        BinaryArch::X64
    }
    #[cfg(target_arch = "arm")]
    {
        BinaryArch::Arm
    }
    #[cfg(target_arch = "aarch64")]
    {
        BinaryArch::Arm64
    }
    #[cfg(not(any(
        target_arch = "x86",
        target_arch = "x86_64",
        target_arch = "arm",
        target_arch = "aarch64",
    )))]
    {
        BinaryArch::Unknown(0)
    }
}

/// Read the PE `IMAGE_FILE_HEADER.Machine` field from a Windows executable.
/// Returns [`BinaryArch::NotPe`] for anything that isn't a recognisable PE.
#[cfg(target_os = "windows")]
pub fn read_pe_machine<P: AsRef<Path>>(path: P) -> std::io::Result<BinaryArch> {
    use std::fs::File;
    use std::io::{Read, Seek, SeekFrom};

    let mut f = File::open(path)?;

    // IMAGE_DOS_HEADER is 64 bytes; e_lfanew is at offset 60.
    let mut dos = [0u8; 64];
    f.read_exact(&mut dos)?;
    if &dos[0..2] != b"MZ" {
        return Ok(BinaryArch::NotPe);
    }
    let e_lfanew = u32::from_le_bytes([dos[60], dos[61], dos[62], dos[63]]) as u64;

    f.seek(SeekFrom::Start(e_lfanew))?;
    // "PE\0\0" signature (4 bytes) followed by IMAGE_FILE_HEADER whose first
    // field is Machine (u16).
    let mut hdr = [0u8; 6];
    f.read_exact(&mut hdr)?;
    if &hdr[0..4] != b"PE\0\0" {
        return Ok(BinaryArch::NotPe);
    }
    let machine = u16::from_le_bytes([hdr[4], hdr[5]]);

    // Values from winnt.h IMAGE_FILE_MACHINE_*.
    Ok(match machine {
        0x014c => BinaryArch::X86,
        0x8664 => BinaryArch::X64,
        0x01c0 | 0x01c4 => BinaryArch::Arm,
        0xAA64 => BinaryArch::Arm64,
        other => BinaryArch::Unknown(other),
    })
}

/// Whether a PE binary of `bin` architecture is runnable on a host process
/// of `host` architecture. Mirrors the emulation matrix Windows actually
/// supports.
#[cfg(target_os = "windows")]
pub fn is_compatible(host: BinaryArch, bin: BinaryArch) -> bool {
    if host == bin {
        return true;
    }
    // Native + WOW: x64 can launch x86.
    if matches!(host, BinaryArch::X64) && matches!(bin, BinaryArch::X86) {
        return true;
    }
    // ARM64 Windows can run x86 (WOW64) and x64 (emulation, Win11+).
    if matches!(host, BinaryArch::Arm64)
        && matches!(bin, BinaryArch::X86 | BinaryArch::X64 | BinaryArch::Arm)
    {
        return true;
    }
    false
}

/// Suppresses the "`<exe>` is not a valid Win32 application" / "This version
/// of %1 is not compatible…" modal dialog that Windows shows synchronously
/// when `CreateProcess` fails with `ERROR_EXE_MACHINE_TYPE_MISMATCH` and
/// similar critical errors. We want to own the error surface.
#[cfg(target_os = "windows")]
pub fn suppress_critical_error_dialogs() {
    // SEM_FAILCRITICALERRORS | SEM_NOOPENFILEERRORBOX — matches what
    // well-behaved Windows services do. We deliberately leave the GP-fault
    // box alone so real crashes still bubble to WER for diagnostics.
    const SEM_FAILCRITICALERRORS: u32 = 0x0001;
    const SEM_NOOPENFILEERRORBOX: u32 = 0x8000;

    // SAFETY: `SetErrorMode` has no preconditions and is always safe to
    // call from any thread; the returned previous mode is discarded.
    unsafe {
        windows::Win32::System::Diagnostics::Debug::SetErrorMode(
            windows::Win32::System::Diagnostics::Debug::THREAD_ERROR_MODE(
                SEM_FAILCRITICALERRORS | SEM_NOOPENFILEERRORBOX,
            ),
        );
    }
}

/// Best-effort resolve the path to the `verge-mihomo` sidecar that Tauri
/// copies next to the main executable. Returns `None` if we can't figure
/// out the exe directory (which effectively disables the pre-flight check).
pub fn resolve_sidecar_path(sidecar_stem: &str) -> Option<std::path::PathBuf> {
    let exe = std::env::current_exe().ok()?;
    let dir = exe.parent()?;
    #[cfg(target_os = "windows")]
    let file = format!("{sidecar_stem}.exe");
    #[cfg(not(target_os = "windows"))]
    let file = sidecar_stem.to_string();
    Some(dir.join(file))
}

/// Result of pre-flight architecture check for a sidecar.
#[derive(Debug, Clone)]
pub struct ArchCheckReport {
    pub sidecar_path: std::path::PathBuf,
    pub host: BinaryArch,
    pub sidecar: BinaryArch,
}

impl ArchCheckReport {
    pub fn human_message(&self) -> String {
        format!(
            "Sidecar {} architecture ({}) is not compatible with the host ({}). \
             Please reinstall the XXLink build that matches your Windows version.",
            self.sidecar_path.display(),
            self.sidecar,
            self.host,
        )
    }
}

/// Pre-flight the `verge-mihomo` sidecar binary. Returns:
/// * `Ok(None)` — sidecar looks compatible (or we couldn't decide, in which
///   case we don't want to block the user).
/// * `Ok(Some(report))` — confirmed architecture mismatch.
/// * `Err(io)` — genuine IO failure reading the file.
#[cfg(target_os = "windows")]
pub fn check_sidecar_arch(sidecar_stem: &str) -> std::io::Result<Option<ArchCheckReport>> {
    let Some(path) = resolve_sidecar_path(sidecar_stem) else {
        return Ok(None);
    };
    if !path.exists() {
        return Ok(None);
    }
    let sidecar = read_pe_machine(&path)?;
    let host = host_arch();
    if matches!(sidecar, BinaryArch::NotPe) {
        return Ok(None);
    }
    if is_compatible(host, sidecar) {
        return Ok(None);
    }
    Ok(Some(ArchCheckReport {
        sidecar_path: path,
        host,
        sidecar,
    }))
}

#[cfg(not(target_os = "windows"))]
pub fn check_sidecar_arch(_sidecar_stem: &str) -> std::io::Result<Option<ArchCheckReport>> {
    Ok(None)
}

#[cfg(not(target_os = "windows"))]
pub fn suppress_critical_error_dialogs() {}
