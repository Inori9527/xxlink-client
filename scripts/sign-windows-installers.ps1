param(
  [string]$InstallersDir = "builds\windows-installers"
)

$ErrorActionPreference = "Stop"

$tauriCli = Join-Path $PSScriptRoot "..\node_modules\.bin\tauri.cmd"
if (-not (Test-Path -LiteralPath $tauriCli)) {
  throw "Tauri CLI not found. Run pnpm install before signing."
}

$privateKeyPath = [Environment]::GetEnvironmentVariable("TAURI_SIGNING_PRIVATE_KEY_PATH", "User")
if (-not $privateKeyPath) {
  $privateKeyPath = [Environment]::GetEnvironmentVariable("TAURI_SIGNING_PRIVATE_KEY_PATH", "Process")
}

$privateKeyPassword = [Environment]::GetEnvironmentVariable("TAURI_SIGNING_PRIVATE_KEY_PASSWORD", "User")
if (-not $privateKeyPassword) {
  $privateKeyPassword = [Environment]::GetEnvironmentVariable("TAURI_SIGNING_PRIVATE_KEY_PASSWORD", "Process")
}

if (-not $privateKeyPath) {
  throw "TAURI_SIGNING_PRIVATE_KEY_PATH is not configured."
}

if (-not (Test-Path -LiteralPath $privateKeyPath)) {
  throw "Private key file not found: $privateKeyPath"
}

$resolvedInstallersDir = Resolve-Path $InstallersDir
$installers = Get-ChildItem -LiteralPath $resolvedInstallersDir -Filter "*-setup.exe" | Sort-Object Name

if (-not $installers) {
  throw "No setup.exe installers found in $resolvedInstallersDir"
}

foreach ($installer in $installers) {
  Write-Host "Signing $($installer.Name)..."
  $args = @(
    "signer",
    "sign",
    "--private-key-path",
    $privateKeyPath
  )

  if ($privateKeyPassword -and -not [Environment]::GetEnvironmentVariable("TAURI_SIGNING_PRIVATE_KEY_PASSWORD", "Process")) {
    [Environment]::SetEnvironmentVariable("TAURI_SIGNING_PRIVATE_KEY_PASSWORD", $privateKeyPassword, "Process")
  }

  $args += $installer.FullName
  & $tauriCli @args

  if ($LASTEXITCODE -ne 0) {
    throw "Failed to sign $($installer.Name)"
  }
}

Write-Host "Signed $($installers.Count) installer(s)."
