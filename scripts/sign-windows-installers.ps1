param(
  [string]$InstallersDir = "builds\windows-installers"
)

$ErrorActionPreference = "Stop"

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
    "pnpm",
    "tauri",
    "signer",
    "sign",
    "--private-key-path",
    $privateKeyPath
  )

  if ($privateKeyPassword) {
    $args += @("--password", $privateKeyPassword)
  }

  $args += $installer.FullName
  & corepack @args

  if ($LASTEXITCODE -ne 0) {
    throw "Failed to sign $($installer.Name)"
  }
}

Write-Host "Signed $($installers.Count) installer(s)."
