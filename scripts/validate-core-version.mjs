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

// Identity by path. argv[2] used to name ANY executable, and a path that did
// not exist was silently dropped so a default binary was validated instead:
// measured, passing node.exe with XXLINK_EXPECTED_MIHOMO_VERSION=v24.14 exited
// 0 and printed "mihomo version OK: v24.14".
const SIDECAR_NAME = /^xxlink-mihomo-[A-Za-z0-9_.-]+\.exe$/i

if (explicitPath && !SIDECAR_NAME.test(path.basename(explicitPath))) {
  console.error(
    `refusing to validate ${explicitPath}: only a bundled xxlink-mihomo-*.exe is a mihomo sidecar`,
  )
  process.exit(1)
}
if (explicitPath && !fs.existsSync(explicitPath)) {
  console.error(
    `sidecar named on the command line does not exist: ${explicitPath}`,
  )
  process.exit(1)
}

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

// Equality, not a substring search: `includes('24.14')` is satisfied by
// 24.14.1, by 124.14, and by any line that merely mentions the digits.
// The reported version is the token after the product name, compared whole.
if (!/^Mihomo\b/i.test(output)) {
  console.error(`not a mihomo binary: -v printed "${output.split(/\r?\n/)[0]}"`)
  process.exit(1)
}

const reported = output.match(/\bv?(\d+\.\d+\.\d+(?:[-+][A-Za-z0-9.]+)?)\b/)
if (!reported) {
  console.error(`could not read a version out of "${output.split(/\r?\n/)[0]}"`)
  process.exit(1)
}
if (reported[1] !== EXPECTED_VERSION.replace(/^v/, '')) {
  console.error(
    `mihomo version mismatch: expected ${EXPECTED_VERSION}, got v${reported[1]}`,
  )
  process.exit(1)
}

console.log(`mihomo version OK: v${reported[1]} (${path.basename(binaryPath)})`)
