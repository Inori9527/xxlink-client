import { execFileSync } from 'child_process'
import fs from 'fs'
import path from 'path'

// PROVES:         Executes the code under test. A green run proves that ONE mihomo
//                 sidecar binary — argv[2] if passed, otherwise the first existing of
//                 src-tauri/sidecar/xxlink-mihomo-x86_64-pc-windows-gnu.exe then
//                 ...-x86_64-pc-windows-msvc.exe -- exists on disk and, run with -v,
//                 (an argv[2] that does not exist is dropped rather than reported,
//                 so passing a wrong path silently validates a default binary)
//                 reports the expected mihomo version (XXLINK_EXPECTED_MIHOMO_VERSION,
//                 default v1.19.25).
// DOES NOT PROVE: It does not prove every bundled sidecar is at the pinned version,
//                 nor that the binary it checked is mihomo at all, nor that the
//                 version is EQUAL to the expected one. argv[2] may name any
//                 executable and the check is a substring search of its -v output:
//                 measured, `validate-core-version.mjs <path to node.exe>` with
//                 XXLINK_EXPECTED_MIHOMO_VERSION=v24.14 exits 0 and prints
//                 "mihomo version OK: v24.14" while node reports v24.14.1.
//                 Identity and exact-version checking are filed to the guard item.

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
