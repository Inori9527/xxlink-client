import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'

// PROVES:         Source text only. A green run proves facts about the current content
//                 of seven checked-in files, read from disk relative to process.cwd().
// DOES NOT PROVE: That the shipped app is actually minimized.

const root = process.cwd()
const read = (path) => readFileSync(resolve(root, path), 'utf8')
const json = (path) => JSON.parse(read(path))

const desktop = json('src-tauri/capabilities/desktop.json')
const windowCapability = json('src-tauri/capabilities/desktop-window.json')
const tauriConfig = json('src-tauri/tauri.conf.json')
const windowsConfig = json('src-tauri/tauri.windows.conf.json')
const lib = read('src-tauri/src/lib.rs')
const cmds = read('src/services/cmds.ts')

const desktopPermissions = desktop.permissions.map((permission) =>
  typeof permission === 'string' ? permission : permission.identifier,
)
assert.deepEqual(desktop.webviews, ['main'])
assert.deepEqual(desktop.windows, ['main'])
assert.deepEqual(windowCapability.webviews, ['main'])
assert.deepEqual(windowCapability.windows, ['main'])

for (const forbidden of [
  'updater:default',
  'updater:allow-check',
  'updater:allow-download-and-install',
  'process:allow-restart',
  'process:allow-exit',
  'dialog:default',
  'fs:allow-read-file',
  'fs:allow-write-file',
  'clipboard-manager:allow-read-text',
  'core:webview:allow-create-webview',
  'core:webview:allow-create-webview-window',
  'mihomo:default',
  'http:default',
  'shell:default',
  'core:default',
  'mihomo:allow-get-rules',
  'mihomo:allow-get-rule-providers',
  'mihomo:allow-get-version',
]) {
  assert.equal(
    [...desktopPermissions, ...windowCapability.permissions].includes(
      forbidden,
    ),
    false,
    `forbidden broad permission remains: ${forbidden}`,
  )
}

const httpPermission = desktop.permissions.find(
  (permission) =>
    typeof permission === 'object' &&
    permission.identifier === 'http:allow-fetch',
)
assert.deepEqual(httpPermission?.allow, [{ url: 'https://api.xxlink.net/**' }])
assert.equal(
  tauriConfig.plugins.shell.open,
  '^https://(?:(?:www\\.)?xxlink\\.net(?:/.*)?|api\\.xxlink\\.net(?:/.*)?|github\\.com/Inori9527/xxlink-client(?:/.*)?)$',
)
assert.equal(tauriConfig.app.security.assetProtocol, undefined)
assert.equal(
  read('src-tauri/Cargo.toml').includes('"protocol-asset"'),
  false,
  'unused filesystem asset protocol remains enabled',
)

for (const permission of [
  'core:event:allow-listen',
  'core:event:allow-unlisten',
  'core:window:allow-close',
  'core:window:allow-minimize',
  'core:window:allow-maximize',
  'core:window:allow-unmaximize',
  'core:window:allow-is-maximized',
  'core:window:allow-is-fullscreen',
  'core:window:allow-is-decorated',
  'core:window:allow-hide',
  'core:window:allow-show',
  'core:window:allow-set-decorations',
  'core:window:allow-set-minimizable',
  'core:window:allow-set-fullscreen',
]) {
  assert.equal(
    windowCapability.permissions.includes(permission),
    true,
    `required main-window permission missing: ${permission}`,
  )
}

assert.deepEqual(tauriConfig.app.security.capabilities, [
  'desktop-capability',
  'desktop-window-capability',
])
assert.deepEqual(windowsConfig.app.security.capabilities, [
  'desktop-capability',
  'desktop-window-capability',
])
assert.equal(
  existsSync(resolve(root, 'src-tauri/capabilities/migrated.json')),
  false,
)
assert.equal(
  existsSync(resolve(root, 'src-tauri/capabilities/desktop-windows.json')),
  false,
)
assert.equal(existsSync(resolve(root, 'src/utils/announcements.ts')), false)

for (const command of [
  'get_profiles',
  'patch_profiles_config',
  'import_profile',
  'update_profile',
  'delete_profile',
  'patch_profile',
  'get_runtime_exists',
  'sync_tray_proxy_selection',
  'get_auto_launch_status',
  'change_clash_core',
  'restart_app',
  'get_app_dir',
  'test_delay',
  'export_diagnostic_info',
  'get_network_interfaces',
  'reinstall_service',
  'repair_service',
  'exit_lightweight_mode',
  'get_clash_info',
  'get_runtime_config',
  'patch_clash_config',
]) {
  assert.doesNotMatch(
    lib,
    new RegExp(`(?:cmd::|commands::)${command}\\b`),
    `retired command remains registered: ${command}`,
  )
  assert.equal(
    cmds.includes(`'${command}'`) || cmds.includes(`"${command}"`),
    false,
    `retired command remains invokable from cmds.ts: ${command}`,
  )
}

for (const command of [
  'runtime_set_connection_enabled',
  'runtime_set_connection_mode',
  'runtime_set_tun_enabled',
  'runtime_set_system_proxy_enabled',
  'runtime_get_tun_settings',
  'runtime_update_tun_settings',
  'runtime_select_node',
  'runtime_check_update',
  'runtime_install_update',
  'managed_subscription_sync',
]) {
  assert.match(lib, new RegExp(`cmd::${command}\\b`))
}

console.log('Capability and retired IPC minimization validation passed.')
