import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import test from 'node:test'

const root = resolve(import.meta.dirname, '..')
const read = (path) => readFileSync(resolve(root, path), 'utf8')

const auth = read('src/services/auth.ts')
const vault = read('src/services/secure-session-vault.ts')
const rustController = read('src-tauri/src/cmd/backend_controller.rs')
const rustVault = read('src-tauri/src/cmd/secure_session.rs')
const lib = read('src-tauri/src/lib.rs')

test('authenticated session transport is owned by the Rust controller', () => {
  assert.match(rustController, /post\(endpoint\("\/auth\/login"\)\)/)
  assert.match(rustController, /post\(endpoint\("\/auth\/refresh"\)\)/)
  assert.match(rustController, /post\(endpoint\("\/auth\/logout"\)\)/)
  assert.match(rustController, /current\.refresh_token\(\)/)
  assert.match(
    rustController,
    /replace_active_session_for_login\(secret, login_attempt\)/,
  )
})

test('ordinary renderer auth transport cannot receive session tokens', () => {
  for (const forbidden of [
    'AuthTokens',
    'LoginResult',
    'apiLogin',
    'apiLogout',
    'apiRefreshToken',
    'apiGoogleOAuthCallback',
    '/auth/refresh',
  ]) {
    assert.equal(
      auth.includes(forbidden),
      false,
      `${forbidden} remains in auth.ts`,
    )
  }
  assert.equal(
    existsSync(resolve(root, 'src/services/auth-refresh-transport.ts')),
    false,
  )
})

test('vault commands return only state or sanitized user data', () => {
  for (const command of [
    'secure_session_probe',
    'secure_session_migrate_legacy',
    'secure_session_login',
    'secure_session_logout',
  ]) {
    assert.match(lib, new RegExp(`cmd::${command}\\b`))
    assert.equal(vault.includes(`'${command}'`), true)
  }
  for (const retired of ['secure_session_read', 'secure_session_write']) {
    assert.doesNotMatch(lib, new RegExp(`cmd::${retired}\\b`))
    assert.doesNotMatch(rustVault, new RegExp(`fn\\s+${retired}\\b`))
    assert.equal(vault.includes(`'${retired}'`), false)
  }
  assert.doesNotMatch(lib, /cmd::secure_session_delete\b/)
  assert.doesNotMatch(vault, /invoke<[^>]*(?:AuthTokens|VaultSecret)/)
})

test('legacy token access is isolated to the one-time migration bridge', () => {
  assert.match(vault, /function readLegacySession\(\)/)
  assert.match(vault, /secure_session_migrate_legacy/)
  assert.match(vault, /clearLegacySession\(\)/)
  assert.match(vault, /probeSession\(user\.id\)/)
  assert.match(rustVault, /read_secret_raw_internal\(\)[\s\S]*?\.is_some\(\)/)
  assert.doesNotMatch(vault, /return\s+\{\s*accessToken:\s*secret\./)
})

test('manual logout atomically takes the vault before detached server cleanup', () => {
  const logoutStart = rustController.indexOf(
    'pub async fn secure_session_logout()',
  )
  const logoutSource = rustController.slice(logoutStart)
  assert.ok(logoutStart >= 0)
  assert.ok(
    logoutSource.indexOf('take_session_for_logout().await') <
      logoutSource.indexOf('tauri::async_runtime::spawn'),
  )
  assert.doesNotMatch(
    vault,
    /withVaultTimeout\(invoke\('secure_session_logout'\)\)/,
  )
})
