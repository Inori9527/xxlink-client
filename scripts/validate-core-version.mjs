import { execFileSync } from 'child_process'
import fs from 'fs'
import path from 'path'

const EXPECTED_VERSION =
  process.env.XXLINK_EXPECTED_MIHOMO_VERSION || 'v1.19.25'
const cwd = process.cwd()
const explicitPath = process.argv[2]
const candidates = [
  explicitPath,
  path.join(
    cwd,
    'src-tauri',
    'sidecar',
    'xxlink-mihomo-x86_64-pc-windows-gnu.exe',
  ),
  path.join(
    cwd,
    'src-tauri',
    'sidecar',
    'xxlink-mihomo-x86_64-pc-windows-msvc.exe',
  ),
].filter(Boolean)

const binaryPath = candidates.find((candidate) => fs.existsSync(candidate))

if (!binaryPath) {
  console.error(
    'mihomo binary not found. Pass the bundled binary path as the first argument.',
  )
  process.exit(1)
}

let output = ''
try {
  output = execFileSync(binaryPath, ['-v'], {
    encoding: 'utf8',
    windowsHide: true,
    timeout: 10000,
  }).trim()
} catch (error) {
  console.error(`failed to execute mihomo version check: ${error.message}`)
  process.exit(1)
}

if (!output.includes(EXPECTED_VERSION.replace(/^v/, ''))) {
  console.error(
    `mihomo version mismatch: expected ${EXPECTED_VERSION}, got "${output}"`,
  )
  process.exit(1)
}

console.log(`mihomo version OK: ${EXPECTED_VERSION}`)
