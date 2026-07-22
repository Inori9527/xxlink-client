import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

const readSource = (path) =>
  readFileSync(new URL(`../${path}`, import.meta.url), 'utf8')

function collectRendererFiles(path) {
  return readdirSync(new URL(`../${path}`, import.meta.url), {
    withFileTypes: true,
  }).flatMap((entry) => {
    const relative = join(path, entry.name).replaceAll('\\', '/')
    return entry.isDirectory()
      ? collectRendererFiles(relative)
      : /\.(ts|tsx)$/.test(entry.name)
        ? [relative]
        : []
  })
}

function migrationDecision({ user, vault, legacy, write, readback }) {
  if (!user) return { state: 'signed_out', preserveLegacy: true }
  if (vault === 'valid') return { state: 'operational', preserveLegacy: false }
  if (vault === 'subject_mismatch') {
    return { state: 'recovery_required', preserveLegacy: true }
  }
  if (vault === 'error') {
    return { state: 'recovery_required', preserveLegacy: true }
  }
  if (legacy !== 'complete') {
    return { state: 'recovery_required', preserveLegacy: true }
  }
  if (write !== 'ok' || readback !== 'matching') {
    return { state: 'recovery_required', preserveLegacy: true }
  }
  return { state: 'operational', preserveLegacy: false }
}

const cases = [
  ['existing vault', { user: true, vault: 'valid' }, 'operational', false],
  [
    'vault subject mismatch',
    { user: true, vault: 'subject_mismatch' },
    'recovery_required',
    true,
  ],
  [
    'successful migration',
    {
      user: true,
      vault: 'empty',
      legacy: 'complete',
      write: 'ok',
      readback: 'matching',
    },
    'operational',
    false,
  ],
  [
    'failed vault write',
    { user: true, vault: 'empty', legacy: 'complete', write: 'failed' },
    'recovery_required',
    true,
  ],
  [
    'failed readback',
    {
      user: true,
      vault: 'empty',
      legacy: 'complete',
      write: 'ok',
      readback: 'failed',
    },
    'recovery_required',
    true,
  ],
  [
    'partial legacy state',
    { user: true, vault: 'empty', legacy: 'partial' },
    'recovery_required',
    true,
  ],
  [
    'corrupted legacy account shell',
    { user: false, vault: 'empty', legacy: 'complete' },
    'signed_out',
    true,
  ],
]

for (const [name, input, state, preserveLegacy] of cases) {
  assert.deepEqual(migrationDecision(input), { state, preserveLegacy }, name)
}

const vault = readSource('src/services/secure-session-vault.ts')
const authStore = readSource('src/services/auth-store.ts')
const login = readSource('src/pages/login.tsx')
const mine = readSource('src/pages/mine.tsx')
const api = readSource('src/services/api.ts')
const main = readSource('src/main.tsx')
const rust = readSource('src-tauri/src/cmd/secure_session.rs')
const cargo = readSource('src-tauri/Cargo.toml')

assert.match(vault, /await writeAndVerify\([\s\S]*?clearLegacySession\(\)/)
assert.match(vault, /stored\.subjectId !== user\.id/)
assert.match(vault, /catch \{[\s\S]*?authStore\.preserveCachedShell\(\)/)
assert.match(main, /await initializeSecureSession\(\)/)
assert.match(vault, /export async function initializeSecureSession/)
assert.match(vault, /export async function manualLogout/)
assert.match(vault, /secure_session_delete[\s\S]*?authStore\.clearAuth\(\)/)
assert.match(vault, /VAULT_OPERATION_TIMEOUT_MS/)
assert.doesNotMatch(login, /accessToken|refreshToken|apiLogin|setAuth/)
assert.doesNotMatch(mine, /accessToken|refreshToken|apiLogout|clearAuth/)
assert.doesNotMatch(api, /state\.(accessToken|refreshToken)|authStore\.setAuth/)
assert.doesNotMatch(authStore, /interface AuthState[\s\S]{0,180}accessToken/)
assert.match(rust, /VAULT_SERVICE[\s\S]*?Entry::new/)
assert.match(cargo, /keyring = "4\.1\.5"/)
assert.doesNotMatch(rust, /logging!|println!|dbg!/)

for (const path of [
  ...collectRendererFiles('src/pages'),
  ...collectRendererFiles('src/components'),
]) {
  const source = readSource(path)
  assert.doesNotMatch(
    source,
    /\b(accessToken|refreshToken)\b/,
    `${path} must not receive authentication tokens`,
  )
  assert.doesNotMatch(
    source,
    /services\/secure-session-vault|\bapi(Login|GoogleOAuthCallback)\b/,
    `${path} must use the token-free session controller`,
  )
}

console.log(`secure session migration cases passed: ${cases.length}`)
console.log('secure session source boundary checks passed')
