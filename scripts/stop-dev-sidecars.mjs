import { execFileSync } from 'node:child_process'
import { resolve } from 'node:path'

if (process.platform !== 'win32') {
  process.exit(0)
}

const targetDebug = resolve(process.cwd(), 'target', 'debug').replace(
  /\\/g,
  '\\\\',
)

const script = `
$target = '${targetDebug}'
$names = @('xxlink-client.exe', 'xxlink-mihomo.exe')
Get-CimInstance Win32_Process |
  Where-Object {
    $names -contains $_.Name -and
    (
      ($_.ExecutablePath -and $_.ExecutablePath -like "$target\\\\*") -or
      ($_.CommandLine -and $_.CommandLine -like "*$target*")
    )
  } |
  ForEach-Object {
    try {
      Stop-Process -Id $_.ProcessId -Force -ErrorAction Stop
      Write-Output "Stopped stale dev process $($_.Name) ($($_.ProcessId))"
    } catch {
      Write-Output "Unable to stop stale dev process $($_.Name) ($($_.ProcessId)): $($_.Exception.Message)"
      exit 1
    }
  }
`

execFileSync(
  'powershell.exe',
  ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', script],
  { stdio: 'inherit' },
)
