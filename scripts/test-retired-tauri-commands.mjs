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
const runtimeControllerSource = readSource(
  'src/services/runtime-action-controller.ts',
)
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

const retiredRawConfigCommands = [
  ['patchVergeConfig', 'patch_verge_config'],
  ['getRuntimeProxyChainConfig', 'get_runtime_proxy_chain_config'],
  ['updateProxyChainConfigInRuntime', 'update_proxy_chain_config_in_runtime'],
  [null, 'save_dns_config'],
  [null, 'apply_dns_config'],
  [null, 'check_dns_config_exists'],
  [null, 'get_dns_config_content'],
  [null, 'validate_dns_config'],
]

const retiredWebviewCommands = [
  ['getProfiles', 'get_profiles'],
  ['patchProfilesConfig', 'patch_profiles_config'],
  ['importProfile', 'import_profile'],
  ['updateProfile', 'update_profile'],
  ['deleteProfile', 'delete_profile'],
  ['patchProfile', 'patch_profile'],
  ['getRuntimeExists', 'get_runtime_exists'],
  ['syncTrayProxySelection', 'sync_tray_proxy_selection'],
  ['getAutoLaunchStatus', 'get_auto_launch_status'],
  ['changeClashCore', 'change_clash_core'],
  ['restartApp', 'restart_app'],
  ['getAppDir', 'get_app_dir'],
  ['cmdTestDelay', 'test_delay'],
  ['exportDiagnosticInfo', 'export_diagnostic_info'],
  ['getNetworkInterfaces', 'get_network_interfaces'],
  ['reinstallService', 'reinstall_service'],
  ['repairService', 'repair_service'],
  ['exit_lightweight_mode', 'exit_lightweight_mode'],
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
    ...retiredRawConfigCommands.flatMap(([name]) => (name ? [name] : [])),
    ...retiredWebviewCommands.map(([name]) => name),
    'installService',
    'uninstallService',
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
    ...retiredRawConfigCommands.map(([, name]) => name),
    ...retiredWebviewCommands.map(([, name]) => name),
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

  for (const [wrapper, command] of [
    ...retiredDeletedConsumerCommands,
    ...retiredRawConfigCommands,
  ]) {
    for (const [relativePath, source] of frontendSources) {
      if (wrapper) {
        assert.doesNotMatch(
          source,
          new RegExp(`\\b${wrapper}\\s*\\(`),
          `${wrapper} must not have a runtime call site in ${relativePath}`,
        )
      }
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
    ...retiredRawConfigCommands.map(([, name]) => name),
  ]
  const retiredHandlerSources = [
    readSource('src-tauri/src/cmd/app.rs'),
    readSource('src-tauri/src/cmd/clash.rs'),
    readSourceIfExists('src-tauri/src/cmd/lightweight.rs'),
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
    'lightweight',
    'oauth',
    'proxy',
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
    existsSync(resolve(repoRoot, 'src-tauri/src/cmd/lightweight.rs')),
    false,
    'renderer lightweight command module must remain retired',
  )
  assert.equal(
    existsSync(resolve(repoRoot, 'src-tauri/src/cmd/proxy.rs')),
    false,
    'renderer tray proxy command module must remain retired',
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

test('command-adjacent dead code and empty modules remain retired', () => {
  const coreModSource = readSource('src-tauri/src/core/mod.rs')
  const timerSource = readSource('src-tauri/src/core/timer.rs')
  const validatorSource = readSource('src-tauri/src/core/validate.rs')
  const clashFeatureSource = readSource('src-tauri/src/feat/clash.rs')

  assert.doesNotMatch(cmdModSource, /\bstringify_err_log\b/)
  assert.doesNotMatch(timerSource, /\bfn\s+get_next_update_time\b/)
  assert.doesNotMatch(validatorSource, /\bfn\s+validate_file_syntax\b/)
  assert.doesNotMatch(validatorSource, /\bfn\s+validate_config_file\b/)
  assert.doesNotMatch(clashFeatureSource, /\bfn\s+after_change_clash_mode\b/)
  assert.doesNotMatch(clashFeatureSource, /\bfn\s+change_clash_mode\b/)

  assert.doesNotMatch(cmdModSource, /\bpub\s+mod\s+validate\s*;/)
  assert.equal(
    existsSync(resolve(repoRoot, 'src-tauri/src/cmd/validate.rs')),
    false,
    'empty command validation module must remain retired',
  )
  assert.doesNotMatch(coreModSource, /\bpub\s+mod\s+win_uwp\s*;/)
  assert.equal(
    existsSync(resolve(repoRoot, 'src-tauri/src/core/win_uwp.rs')),
    false,
    'empty Windows UWP helper module must remain retired',
  )
})

test('live error conversion, timer, validation, and Clash helpers remain', () => {
  const timerSource = readSource('src-tauri/src/core/timer.rs')
  const validatorSource = readSource('src-tauri/src/core/validate.rs')
  const clashFeatureSource = readSource('src-tauri/src/feat/clash.rs')

  assert.match(cmdModSource, /\bfn\s+stringify_err\b/)
  assert.match(timerSource, /pub\s+async\s+fn\s+init\b/)
  assert.match(timerSource, /pub\s+async\s+fn\s+refresh\b/)
  assert.match(validatorSource, /async\s+fn\s+validate_config_internal\b/)
  assert.match(validatorSource, /pub\s+async\s+fn\s+validate_config\b/)
  assert.match(clashFeatureSource, /pub\s+async\s+fn\s+restart_clash_core\b/)
  assert.match(clashFeatureSource, /pub\s+async\s+fn\s+restart_app\b/)
  assert.doesNotMatch(clashFeatureSource, /pub\s+async\s+fn\s+test_delay\b/)
})

test('managed profile UI commands are retired while internal enhancement remains', () => {
  assert.match(libSource, /\bcmd::enhance_profiles\b/)
  assert.equal(cmdSource.includes("'enhance_profiles'"), true)

  for (const [, command] of retiredWebviewCommands) {
    assert.doesNotMatch(
      libSource,
      new RegExp(`\\bcmd::${command}\\b`),
      `${command} must not remain registered`,
    )
  }
})

test('raw runtime reads are retired behind typed TUN actions', () => {
  for (const [wrapper, command] of [
    ['getRuntimeConfig', 'get_runtime_config'],
    ['getClashInfo', 'get_clash_info'],
    ['patchClashConfig', 'patch_clash_config'],
  ]) {
    assert.doesNotMatch(
      cmdSource,
      new RegExp(`export\\s+(?:async\\s+)?function\\s+${wrapper}\\b`),
      `${wrapper} wrapper must remain retired`,
    )
    assert.equal(
      cmdSource.includes(`'${command}'`),
      false,
      `${command} frontend invoke must remain retired`,
    )
    assert.doesNotMatch(
      libSource,
      new RegExp(`\\bcmd::${command}\\b`),
      `${command} must remain retired`,
    )
  }

  for (const command of [
    'runtime_get_tun_settings',
    'runtime_update_tun_settings',
  ]) {
    assert.equal(runtimeControllerSource.includes(`'${command}'`), true)
    assert.match(libSource, new RegExp(`\\bcmd::${command}\\b`))
  }

  for (const command of [
    'start_core',
    'stop_core',
    'restart_core',
    'install_service',
    'uninstall_service',
  ]) {
    assert.equal(runtimeControllerSource.includes(`'${command}'`), false)
    assert.doesNotMatch(libSource, new RegExp(`\\bcmd::${command}\\b`))
  }

  for (const command of [
    'runtime_install_service_and_restart_core',
    'runtime_uninstall_service_and_restart_core',
  ]) {
    assert.equal(runtimeControllerSource.includes(`'${command}'`), true)
    assert.match(libSource, new RegExp(`\\bcmd::${command}\\b`))
  }
})

test('internal runtime-chain and DNS generation capabilities remain', () => {
  const runtimeConfigSource = readSource('src-tauri/src/config/runtime.rs')
  const clashFeatureSource = readSource('src-tauri/src/feat/config.rs')
  const enhanceSource = readSource('src-tauri/src/enhance/mod.rs')
  const initSource = readSource('src-tauri/src/utils/init.rs')

  assert.match(runtimeConfigSource, /pub\s+fn\s+patch_config\b/)
  assert.match(runtimeConfigSource, /pub\s+fn\s+update_proxy_chain_config\b/)
  assert.match(
    clashFeatureSource,
    /Config::runtime\(\)\.await\.edit_draft\(\|d\| d\.patch_config\(patch\)\)/,
  )
  assert.match(enhanceSource, /async\s+fn\s+apply_dns_settings\b/)
  assert.match(initSource, /constants::files::DNS_CONFIG/)
})

test('internal current-profile and lightweight capabilities remain', () => {
  const profileSource = readSource('src-tauri/src/cmd/profile.rs')
  const lightweightSource = readSource('src-tauri/src/module/lightweight.rs')

  assert.match(
    profileSource,
    /pub\s+async\s+fn\s+patch_profiles_config_by_profile_index\b/,
  )
  assert.match(lightweightSource, /pub\s+async\s+fn\s+entry_lightweight_mode\b/)
  assert.match(lightweightSource, /pub\s+async\s+fn\s+exit_lightweight_mode\b/)
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
    'runtime_get_diagnostics_log_summaries',
    'runtime_write_diagnostics_bundle',
  ]) {
    assert.match(libSource, new RegExp(`\\bcmd::${command}\\b`))
  }
  assert.doesNotMatch(cmdSource, /getRuntimeLogs|getClashLogs/)
  assert.doesNotMatch(libSource, /cmd::get_runtime_logs|cmd::get_clash_logs/)

  for (const command of ['get_system_info', 'get_app_uptime']) {
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

  assert.doesNotMatch(
    libSource,
    /tauri_plugin_xxlink_sysinfo::commands::export_diagnostic_info/,
  )
})
