import fs from 'fs'
import path from 'path'

// PROVES:         Reads build artifacts on disk. A green run proves only that three
//                 already-built Windows binaries exist on disk and pass a raw byte
//                 scan: src-tauri/resources/xxlink-service.exe,
//                 xxlink-service-install.exe and xxlink-service-uninstall.exe --
//                 but only when no paths are passed on the command line. argv
//                 REPLACES that default set rather than adding to it, so a green
//                 run invoked with arguments says nothing about the three above.
//                 Worse, the only POSITIVE branding assertion is gated on the
//                 supplied basename starting, case-sensitively, with
//                 'xxlink-service-install': measured, passing package.json exits 0
//                 with "service helper branding OK". An arbitrary argv input need
//                 only lack the legacy string. Filed to the guard item.
// DOES NOT PROVE: Nothing is executed: no helper is launched, no Windows service is
//                 installed, registered, queried or removed, so green says nothing
//                 about the display name Windows actually registers for xxlink_service,
//                 nor that the bytes found here are the bytes a running service uses.

const EXPECTED_BRANDING = 'XXLink Service'
const LEGACY_BRANDING = 'Clash Verge Service'

const cwd = process.cwd()
const defaultTargets = [
  'src-tauri/resources/xxlink-service.exe',
  'src-tauri/resources/xxlink-service-install.exe',
  'src-tauri/resources/xxlink-service-uninstall.exe',
]

const targets = process.argv.slice(2)
const files = targets.length > 0 ? targets : defaultTargets

function binaryIncludesText(buffer, text) {
  return (
    buffer.includes(Buffer.from(text, 'utf8')) ||
    buffer.includes(Buffer.from(text, 'utf16le'))
  )
}

for (const file of files) {
  const filePath = path.resolve(cwd, file)
  if (!fs.existsSync(filePath)) {
    console.error(`service helper not found: ${filePath}`)
    process.exit(1)
  }

  const buffer = fs.readFileSync(filePath)
  if (binaryIncludesText(buffer, LEGACY_BRANDING)) {
    console.error(
      `${filePath}: stale service helper branding found: ${LEGACY_BRANDING}`,
    )
    process.exit(1)
  }

  // Case-insensitive, and the gate no longer decides whether the positive
  // assertion runs at all -- it used to skip silently for any other name, so
  // `validate-service-helper-branding.mjs package.json` exited 0 printing
  // "service helper branding OK".
  const base = path.basename(filePath).toLowerCase()
  if (!base.startsWith('xxlink-service')) {
    console.error(
      `${filePath}: not a service helper; this guard checks xxlink-service*.exe only`,
    )
    process.exit(1)
  }

  if (
    base.startsWith('xxlink-service-install') &&
    !binaryIncludesText(buffer, EXPECTED_BRANDING)
  ) {
    console.error(
      `${filePath}: expected service helper branding not found: ${EXPECTED_BRANDING}`,
    )
    process.exit(1)
  }
}

console.log(`service helper branding OK: ${EXPECTED_BRANDING}`)
