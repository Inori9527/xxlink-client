import assert from 'node:assert/strict'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { resolve } from 'node:path'
import test from 'node:test'

const repoRoot = resolve(import.meta.dirname, '..')

const readSource = (relativePath) =>
  readFileSync(resolve(repoRoot, relativePath), 'utf8')

const readSourceIfExists = (relativePath) =>
  existsSync(resolve(repoRoot, relativePath)) ? readSource(relativePath) : ''

const cmdSource = readSource('src/services/cmds.ts')
const libSource = readSource('src-tauri/src/lib.rs')
const cmdModSource = readSource('src-tauri/src/cmd/mod.rs')

const retiredDeletedConsumerCommands = [
  ['entry_lightweight_mode', 'entry_lightweight_mode'],
  ['exitApp', 'exit_app'],
  ['getNextUpdateTime', 'get_next_update_time'],
  ['getRuntimeYaml', 'get_runtime_yaml'],
  ['invoke_uwp_tool', 'invoke_uwp_tool'],
  ['isPortInUse', 'is_port_in_use'],
  ['openAppDir', 'open_app_dir'],
  ['openCoreDir', 'open_core_dir'],
  ['openDevTools', 'open_devtools'],
  ['openLogsDir', 'open_logs_dir'],
  ['openWebUrl', 'open_web_url'],
  ['patchClashMode', 'patch_clash_mode'],
  ['readProfileFile', 'read_profile_file'],
  ['saveProfileFile', 'save_profile_file'],
  ['viewProfile', 'view_profile'],
]

const readFrontendRuntimeSources = (relativeDir) =>
  readdirSync(resolve(repoRoot, relativeDir), { withFileTypes: true }).flatMap(
    (entry) => {
      const relativePath = `${relativeDir}/${entry.name}`
      if (entry.isDirectory()) return readFrontendRuntimeSources(relativePath)
      if (!entry.isFile() || !/\.tsx?$/.test(entry.name)) return []
      if (relativePath === 'src/services/cmds.ts') return []
      return [[relativePath, readSource(relativePath)]]
    },
  )

test('retired frontend command wrappers are absent', () => {
  for (const wrapper of [
    'clearLogs',
    'cmdGetProxyDelay',
    'reorderProfile',
    ...retiredDeletedConsumerCommands.map(([name]) => name),
  ]) {
    assert.doesNotMatch(
      cmdSource,
      new RegExp(
        `export\\s+(?:(?:async\\s+)?function\\s+${wrapper}\\b|const\\s+${wrapper}\\b)`,
      ),
      `${wrapper} wrapper must remain retired`,
    )
  }

  for (const command of [
    'clear_logs',
    'clash_api_get_proxy_delay',
    'reorder_profile',
    ...retiredDeletedConsumerCommands.map(([, name]) => name),
  ]) {
    assert.equal(
      cmdSource.includes(`'${command}'`),
      false,
      `${command} invoke must remain retired from cmds.ts`,
    )
  }
})

test('commands orphaned by deleted consumers have no frontend runtime use', () => {
  const frontendSources = readFrontendRuntimeSources('src')

  for (const [wrapper, command] of retiredDeletedConsumerCommands) {
    for (const [relativePath, source] of frontendSources) {
      assert.doesNotMatch(
        source,
        new RegExp(`\\b${wrapper}\\s*\\(`),
        `${wrapper} must not have a runtime call site in ${relativePath}`,
      )
      assert.equal(
        source.includes(`'${command}'`) || source.includes(`"${command}"`),
        false,
        `${command} must not be invoked directly in ${relativePath}`,
      )
    }
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
    ...retiredDeletedConsumerCommands.map(([, name]) => name),
  ]
  const retiredHandlerSources = [
    readSource('src-tauri/src/cmd/app.rs'),
    readSource('src-tauri/src/cmd/clash.rs'),
    readSource('src-tauri/src/cmd/lightweight.rs'),
    readSource('src-tauri/src/cmd/network.rs'),
    readSource('src-tauri/src/cmd/profile.rs'),
    readSource('src-tauri/src/cmd/runtime.rs'),
    readSourceIfExists('src-tauri/src/cmd/save_profile.rs'),
    readSourceIfExists('src-tauri/src/cmd/uwp.rs'),
  ].join('\n')

  for (const command of retiredCommands) {
    assert.doesNotMatch(
      libSource,
      new RegExp(`\\bcmd::${command}\\b`),
      `${command} must not be registered`,
    )
    assert.doesNotMatch(
      retiredHandlerSources,
      command === 'is_port_in_use'
        ? new RegExp(
            `#\\[tauri::command\\]\\s*pub\\s+(?:async\\s+)?fn\\s+${command}\\b`,
          )
        : new RegExp(`\\bfn\\s+${command}\\b`),
      `${command} handler must remain retired`,
    )
  }

  assert.match(
    readSource('src-tauri/src/cmd/network.rs'),
    /pub\s+fn\s+is_port_in_use\b/,
    'internal port availability helper must remain available',
  )
})

test('retired command modules are absent', () => {
  for (const moduleName of [
    'media_unlock_checker',
    'oauth',
    'save_profile',
    'uwp',
  ]) {
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
  assert.equal(
    existsSync(resolve(repoRoot, 'src-tauri/src/cmd/save_profile.rs')),
    false,
    'raw profile write command module must remain retired',
  )
  assert.equal(
    existsSync(resolve(repoRoot, 'src-tauri/src/cmd/uwp.rs')),
    false,
    'UWP command module must remain retired',
  )
})

test('managed profile, current-selection, and tray commands remain registered', () => {
  for (const command of [
    'get_profiles',
    'enhance_profiles',
    'patch_profiles_config',
    'import_profile',
    'update_profile',
    'delete_profile',
    'patch_profile',
    'sync_tray_proxy_selection',
  ]) {
    assert.match(libSource, new RegExp(`\\bcmd::${command}\\b`))
    assert.equal(
      cmdSource.includes(`'${command}'`),
      true,
      `${command} frontend invoke must remain available`,
    )
  }
})

test('internal current-profile, lightweight, and timer capabilities remain', () => {
  const profileSource = readSource('src-tauri/src/cmd/profile.rs')
  const lightweightSource = readSource('src-tauri/src/module/lightweight.rs')
  const timerSource = readSource('src-tauri/src/core/timer.rs')

  assert.match(
    profileSource,
    /pub\s+async\s+fn\s+patch_profiles_config_by_profile_index\b/,
  )
  assert.match(
    lightweightSource,
    /pub\s+async\s+fn\s+entry_lightweight_mode\b/,
  )
  assert.match(
    lightweightSource,
    /pub\s+async\s+fn\s+exit_lightweight_mode\b/,
  )
  assert.match(timerSource, /pub\s+async\s+fn\s+get_next_update_time\b/)
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
