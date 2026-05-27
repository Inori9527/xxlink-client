import fs from 'fs'
import path from 'path'

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

  if (
    path.basename(filePath).startsWith('xxlink-service-install') &&
    !binaryIncludesText(buffer, EXPECTED_BRANDING)
  ) {
    console.error(
      `${filePath}: expected service helper branding not found: ${EXPECTED_BRANDING}`,
    )
    process.exit(1)
  }
}

console.log(`service helper branding OK: ${EXPECTED_BRANDING}`)
