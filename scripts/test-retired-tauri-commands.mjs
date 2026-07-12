import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import test from 'node:test'

const repoRoot = resolve(import.meta.dirname, '..')

const readSource = (relativePath) =>
  readFileSync(resolve(repoRoot, relativePath), 'utf8')

const cmdSource = readSource('src/services/cmds.ts')
const libSource = readSource('src-tauri/src/lib.rs')
const cmdModSource = readSource('src-tauri/src/cmd/mod.rs')

test('retired frontend command wrappers are absent', () => {
  for (const wrapper of ['clearLogs', 'cmdGetProxyDelay', 'reorderProfile']) {
    assert.doesNotMatch(
      cmdSource,
      new RegExp(`export\\s+(?:async\\s+)?function\\s+${wrapper}\\b`),
      `${wrapper} wrapper must remain retired`,
    )
  }

  for (const command of [
    'clear_logs',
    'clash_api_get_proxy_delay',
    'reorder_profile',
  ]) {
    assert.equal(
      cmdSource.includes(`'${command}'`),
      false,
      `${command} invoke must remain retired from cmds.ts`,
    )
  }
})

test('retired Rust commands and registrations are absent', () => {
  const retiredCommands = [
    'reorder_profile',
    'get_unlock_items',
    'check_media_unlock',
    'open_app_log',
    'open_core_log',
    'open_oauth_window',
  ]
  const retiredHandlerSources = [
    readSource('src-tauri/src/cmd/app.rs'),
    readSource('src-tauri/src/cmd/profile.rs'),
  ].join('\n')

  for (const command of retiredCommands) {
    assert.doesNotMatch(
      libSource,
      new RegExp(`\\bcmd::${command}\\b`),
      `${command} must not be registered`,
    )
    assert.doesNotMatch(
      retiredHandlerSources,
      new RegExp(`\\bfn\\s+${command}\\b`),
      `${command} handler must remain retired`,
    )
  }
})

test('retired media unlock and OAuth command modules are absent', () => {
  for (const moduleName of ['media_unlock_checker', 'oauth']) {
    assert.doesNotMatch(
      cmdModSource,
      new RegExp(`\\bpub\\s+mod\\s+${moduleName}\\s*;`),
      `${moduleName} module declaration must remain retired`,
    )
    assert.doesNotMatch(
      cmdModSource,
      new RegExp(`\\bpub\\s+use\\s+${moduleName}::\\*\\s*;`),
      `${moduleName} module export must remain retired`,
    )
  }

  assert.equal(
    existsSync(resolve(repoRoot, 'src-tauri/src/cmd/media_unlock_checker')),
    false,
    'media unlock command module must remain retired',
  )
  assert.equal(
    existsSync(resolve(repoRoot, 'src-tauri/src/cmd/oauth.rs')),
    false,
    'OAuth command module must remain retired',
  )
})

test('managed profile and current-selection commands remain registered', () => {
  for (const command of [
    'get_profiles',
    'patch_profiles_config',
    'import_profile',
    'update_profile',
    'delete_profile',
    'patch_profile',
  ]) {
    assert.match(libSource, new RegExp(`\\bcmd::${command}\\b`))
    assert.equal(
      cmdSource.includes(`'${command}'`),
      true,
      `${command} frontend invoke must remain available`,
    )
  }
})

test('deep-link handling remains wired to the redacting resolver', () => {
  assert.match(libSource, /tauri_plugin_deep_link::init\(\)/)
  assert.match(libSource, /app\.deep_link\(\)\.on_open_url/)
  assert.match(libSource, /resolve::resolve_scheme\(url\.as_ref\(\)\)/)

  const resolverSource = readSource('src-tauri/src/utils/resolve/scheme.rs')
  assert.match(resolverSource, /redacted_deep_link_for_log\(param\)/)
  assert.match(resolverSource, /post_import_updates/)
})

test('system proxy and diagnostics commands remain available', () => {
  for (const command of [
    'get_sys_proxy',
    'get_auto_proxy',
    'get_runtime_logs',
    'get_clash_logs',
    'get_running_mode',
  ]) {
    assert.match(libSource, new RegExp(`\\bcmd::${command}\\b`))
    assert.equal(
      cmdSource.includes(`'${command}'`),
      true,
      `${command} frontend invoke must remain available`,
    )
  }

  for (const command of [
    'get_system_info',
    'get_app_uptime',
    'export_diagnostic_info',
  ]) {
    assert.match(
      libSource,
      new RegExp(`tauri_plugin_xxlink_sysinfo::commands::${command}`),
    )
    assert.equal(
      cmdSource.includes(`'${command}'`),
      true,
      `${command} frontend invoke must remain available`,
    )
  }
})
