import { readFileSync } from 'node:fs'
import { existsSync } from 'node:fs'
import { resolve } from 'node:path'

// PROVES:         Source text only. Textual facts about the checked-in sources it
//                 reads as plain strings and matches with String#includes/indexOf
//                 and a few regexes, PLUS two filesystem facts -- notably that
//                 src/services/update.ts is absent, which fails the guard without
//                 any read file changing. The file count is deliberately not stated:
//                 four such counts in this corpus were wrong when checked.
// DOES NOT PROVE: That any of the asserted behaviour happens at runtime.

const root = process.cwd()
const read = (path) => readFileSync(resolve(root, path), 'utf8')
const assert = (condition, message) => {
  if (!condition) throw new Error(`[runtime-action-boundary] ${message}`)
}

const controller = read('src/services/runtime-action-controller.ts')
const rust = read('src-tauri/src/cmd/runtime_action_controller.rs')
const configManager = read('src-tauri/src/core/manager/config.rs')
const configFeature = read('src-tauri/src/feat/config.rs')
const lib = read('src-tauri/src/lib.rs')
const connect = read('src/pages/connect.tsx')
// 2026-08-21: connection-mode queue ownership moved to the shared hook used
// by the Connect gate and Mine settings control.
const modeControl = read('src/hooks/use-connect-mode-control.ts')
const nodes = read('src/pages/nodes.tsx')
// 2026-08-21: node grouping, selection, and latency testing are shared by
// Connect's region sheet and the route-only Nodes page.
const nodeCatalog = read('src/hooks/use-node-catalog.ts')
const mine = read('src/pages/mine.tsx')
const selection = read('src/hooks/use-proxy-selection.ts')
const systemProxy = read('src/hooks/use-system-proxy-state.ts')
const systemState = read('src/hooks/use-system-state.ts')
const tunViewer = read('src/components/setting/mods/tun-viewer.tsx')
const sysproxyViewer = read('src/components/setting/mods/sysproxy-viewer.tsx')
const commands = read('src/services/cmds.ts')
const nodeController = read('src/services/runtime-node-controller.ts')
const readiness = read('src/services/selected-node-readiness.ts')
const delayService = read('src/services/delay.ts')
const lifecycleController = read('src/services/app-lifecycle-controller.ts')
const appInitialization = read(
  'src/pages/_layout/hooks/use-app-initialization.ts',
)
const runtimeStatePolicy = read('src/services/runtime-state-policy.ts')
const serviceCommands = read('src-tauri/src/cmd/service.rs')
const sysopt = read('src-tauri/src/core/sysopt.rs')
const profiles = read('src-tauri/src/config/profiles.rs')
const appDataProvider = read('src/providers/app-data-provider.tsx')
const desktopCapability = read('src-tauri/capabilities/desktop.json')

for (const command of [
  'runtime_set_connection_enabled',
  'runtime_set_connection_mode',
  'runtime_set_tun_enabled',
  'runtime_set_system_proxy_enabled',
  'runtime_disable_tun_if_unavailable',
  'runtime_get_proxy_settings',
  'runtime_get_preferences',
  'runtime_get_tun_settings',
  'runtime_update_tun_settings',
  'runtime_update_preferences',
  'runtime_refresh_system_proxy',
  'runtime_install_service_and_restart_core',
  'runtime_select_node',
  'runtime_check_update',
  'runtime_install_update',
]) {
  assert(
    controller.includes(`'${command}'`),
    `missing typed facade command ${command}`,
  )
  assert(
    lib.includes(`cmd::${command}`),
    `command ${command} is not registered`,
  )
}

assert(
  nodeController.includes("'runtime_probe_node_delay'") &&
    lib.includes('cmd::runtime_probe_node_delay'),
  'fixed-target node probe command is not registered behind its typed facade',
)

assert(
  rust.includes('enum RuntimeConnectMode') &&
    rust.includes('validate_node_label') &&
    rust.includes('MAX_NODE_LABEL_BYTES'),
  'Rust controller accepts unbounded runtime configuration input',
)
assert(
  configManager.includes('static CONFIG_TRANSACTION_LOCK') &&
    configManager.includes('force_update_config_in_transaction') &&
    configFeature.includes('CoreManager::begin_config_transaction().await') &&
    configFeature.includes('.force_update_config_in_transaction()') &&
    configFeature.indexOf('Config::verge().await.latest_arc()') <
      configFeature.indexOf('Config::verge().await.apply()') &&
    configFeature.includes('previous_verge.save_file().await') &&
    configFeature.includes(
      'process_terminated_flags(update_flags, &previous_verge)',
    ),
  'runtime configuration writes are not serialized or can be silently skipped by debounce',
)
assert(
  rust.includes(
    'return patch_connection_state_in_transaction(mode, true).await',
  ),
  'connected mode changes do not keep TUN and system proxy state aligned',
)
assert(
  rust.includes('patch_clash_mode_in_transaction') &&
    rust.includes(
      'let _transaction_guard = CoreManager::begin_config_transaction().await',
    ) &&
    rust.includes('let clash = Config::clash().await.data_arc()') &&
    rust.includes('let previous_mode = clash.0.get("mode")') &&
    rust.includes('ensure_clash_source_readable(&clash)') &&
    rust.includes('rollback_connection_state_in_transaction') &&
    rust.includes('previous_connection_state') &&
    rust
      .slice(
        rust.indexOf('pub async fn runtime_set_connection_mode'),
        rust.indexOf('pub async fn runtime_set_tun_enabled'),
      )
      .includes('CoreManager::begin_config_transaction().await'),
  'connection mode and proxy-state changes are not atomic or compensating',
)
assert(
  controller.includes("'runtime_refresh_system_proxy'") &&
    rust.includes('pub async fn runtime_refresh_system_proxy') &&
    /sysopt::Sysopt::global\(\)\s*\.update_sysproxy\(\)/.test(rust),
  'system proxy refresh still requires a renderer-side disable/enable sequence',
)
assert(
  rust.match(/PENDING_UPDATE\.lock\(\)\.await = Some\(update\)/g)?.length >= 2,
  'failed or stale updater installs cannot be retried safely',
)
assert(
  rust.includes('tokio::time::timeout(Duration::from_secs(10)') &&
    !existsSync(resolve(root, 'src/services/update.ts')),
  'updater check lacks a timeout or leaves the raw WebView updater path reachable',
)
assert(
  !controller.includes('command: string') &&
    !controller.includes('path: string') &&
    !controller.includes('url: string') &&
    !controller.includes('profile:') &&
    !controller.includes('config:'),
  'frontend runtime facade exposes arbitrary privileged input',
)
assert(
  !lib.includes('cmd::get_clash_info') &&
    !lib.includes('cmd::get_runtime_config') &&
    !lib.includes('cmd::patch_clash_config') &&
    !lib.includes('cmd::patch_verge_config') &&
    !lib.includes('cmd::get_verge_config') &&
    !lib.includes('cmd::start_core') &&
    !lib.includes('cmd::stop_core') &&
    !lib.includes('cmd::restart_core') &&
    !lib.includes('cmd::install_service') &&
    !lib.includes('cmd::uninstall_service'),
  'raw Mihomo secret/config commands remain registered',
)
assert(
  controller.includes('type RuntimePreferencesUpdate') &&
    controller.includes("'runtime_update_preferences'") &&
    rust.includes('struct RuntimePreferencesUpdate') &&
    rust.includes('validate_runtime_preferences') &&
    rust.includes('serde(deny_unknown_fields)'),
  'renderer preferences are not constrained by a typed allowlist',
)
assert(
  rust.includes('struct TunSettingsView') &&
    rust.includes('struct TunSettingsUpdate') &&
    rust.includes('validate_tun_settings') &&
    rust.includes('serde(deny_unknown_fields'),
  'TUN settings are not constrained by a typed Rust boundary',
)
assert(
  tunViewer.includes('enabled: false') &&
    tunViewer.includes('refreshRequestRef') &&
    tunViewer.includes('mutationInFlightRef') &&
    /if \(!error && data\) \{\s*setValues\(toTunSettingsForm\(data\)\)\s*setAuthoritativeLoaded\(true\)\s*return\s*\}\s*setAuthoritativeLoaded\(false\)/.test(
      tunViewer,
    ) &&
    tunViewer.includes('setAuthoritativeLoaded(false)') &&
    tunViewer.includes(
      'if (mutationInFlightRef.current || busy || !authoritativeLoaded) return',
    ) &&
    tunViewer.includes(
      'if (mutationInFlightRef.current || busy || !authoritativeLoaded) {',
    ) &&
    tunViewer.includes('disabled={busy || !authoritativeLoaded}') &&
    tunViewer.includes('disableOk={busy || !authoritativeLoaded}') &&
    tunViewer.includes('.finally(() =>') &&
    tunViewer.includes(
      'inert={busy || !authoritativeLoaded ? true : undefined}',
    ) &&
    tunViewer.includes('disableCancel={mutating}') &&
    tunViewer.includes('authoritativeLoaded') &&
    tunViewer.includes('const applied = await') &&
    rust.includes('static TUN_SETTINGS_MUTATION_LOCK') &&
    rust.includes('TUN_SETTINGS_MUTATION_LOCK.lock().await') &&
    !rust
      .slice(
        rust.indexOf('pub async fn runtime_update_tun_settings'),
        rust.indexOf('fn validate_node_label'),
      )
      .includes('feat::patch_clash') &&
    rust.includes('Config::clash().await.edit_draft') &&
    rust.includes('CoreManager::global()') &&
    rust.includes('.apply_generate_config_in_transaction()') &&
    rust.includes('Config::clash().await.data_arc()') &&
    rust.includes('existing.cloned().unwrap_or_default()') &&
    !rust
      .slice(
        rust.indexOf('pub async fn runtime_get_tun_settings'),
        rust.indexOf('pub async fn runtime_update_preferences'),
      )
      .includes('Config::runtime()') &&
    rust.includes('async fn rollback_staged_tun_settings()') &&
    rust.includes('rollback_staged_tun_settings().await') &&
    rust.includes('Config::clash().await.latest_arc()') &&
    rust.includes(
      'runtime_update_tun_settings(settings: TunSettingsUpdate) -> CmdResult<TunSettingsView>',
    ),
  'TUN settings refresh can overwrite edits or leave the dialog locked',
)
assert(
  tunViewer.includes('const defaultTunSettings = ()') &&
    tunViewer.includes('settings?.stack ??') &&
    tunViewer.includes('settings?.mtu ?? 1500') &&
    tunViewer.includes(
      'runtimeActionController.updateTunSettings(defaultTunSettings())',
    ),
  'malformed persisted TUN settings cannot be recovered through typed defaults',
)
assert(
  rust.includes('is_valid_ip_cidr') &&
    rust.includes('IpAddr::from_str') &&
    rust.includes('not-a-cidr') &&
    rust.includes('tun_settings_read_rejects_malformed_or_truncated_lists') &&
    !rust.includes('.take(MAX_TUN_LIST_ITEMS)'),
  'Rust TUN boundary does not semantically validate route-exclude CIDRs',
)
assert(
  !appDataProvider.includes('getBaseConfig') &&
    appDataProvider.includes('runtimeActionController.getProxySettings') &&
    !desktopCapability.includes('mihomo:allow-get-base-config'),
  'raw Mihomo base configuration remains reachable from the main WebView',
)

for (const [name, source] of [
  ['connect', connect],
  ['nodes', nodes],
  ['mine', mine],
  ['selection', selection],
  ['system-proxy', systemProxy],
  ['system-state', systemState],
]) {
  assert(
    !source.includes("from '@tauri-apps/api/core'") &&
      !source.includes('selectNodeForGroup(') &&
      !source.includes('patchClash(') &&
      !source.includes('patchVerge('),
    `${name} bypasses the approved runtime action facade`,
  )
}

assert(
  connect.includes('runtimeActionController.setConnectionEnabled') &&
    modeControl.includes('runtimeActionController.setConnectionMode'),
  'Connect does not use typed connection actions',
)
assert(
  modeControl.includes('modeChangeQueueRef') &&
    modeControl.includes('modeChangeGenerationRef') &&
    modeControl.includes('committedModeRef') &&
    modeControl.includes('requestId === modeChangeGenerationRef.current') &&
    !modeControl.includes("'connect-mode-rollback'"),
  'stale connection-mode failures can overwrite a newer successful request',
)
assert(
  selection.includes('runtimeActionController.selectNode') &&
    nodeCatalog.includes('runtimeActionController.testNodeLatency'),
  'node selection or latency test bypasses typed actions',
)
const nodeSelectionCommand = rust.slice(
  rust.indexOf('pub async fn runtime_select_node'),
  rust.indexOf('pub async fn runtime_check_update'),
)
assert(
  nodeSelectionCommand.includes('persist_node_selection') &&
    nodeSelectionCommand.includes('profiles_replace_item_selected_safe') &&
    nodeSelectionCommand.includes('previous_selected') &&
    nodeSelectionCommand.includes('previous_runtime_selection') &&
    nodeSelectionCommand.includes('restore_runtime_node') &&
    nodeSelectionCommand.includes('runtime_rollback') &&
    nodeSelectionCommand.includes('persistence_rollback') &&
    nodeSelectionCommand.includes('current_runtime_node') &&
    nodeSelectionCommand.includes(
      'schedule_previous_node_connection_cleanup',
    ) &&
    profiles.includes('replace_item_selected') &&
    !nodeSelectionCommand.includes('get_proxy_by_name') &&
    !controller.includes('getConnections') &&
    !controller.includes('closeConnection'),
  'node selection cannot recover from an empty current selection or failed runtime apply',
)
assert(
  nodeController.includes('target: RuntimeProbeTarget') &&
    readiness.includes('READINESS_PROBE_TARGET_BY_URL') &&
    !readiness.includes('delayProxyByName') &&
    !delayService.includes('delayProxyByName') &&
    !desktopCapability.includes('mihomo:allow-delay-proxy-by-name') &&
    !desktopCapability.includes('mihomo:allow-get-connections') &&
    !desktopCapability.includes('mihomo:allow-close-connection'),
  'renderer retains arbitrary URL probes or raw connection controls',
)
assert(
  commands.includes('service_availability_unavailable') &&
    commands.includes('admin_state_unavailable') &&
    serviceCommands.includes('enum ServiceAvailabilityView') &&
    serviceCommands.includes('InstalledUnavailable') &&
    systemState.includes("serviceAvailability: 'unknown'") &&
    runtimeStatePolicy.includes('shouldDisableTunForUnavailableRuntime'),
  'unknown service or admin state can be treated as authoritative disabled state',
)
assert(
  rust.includes('static SERVICE_ACTION_LOCK') &&
    rust.includes('runtime_install_service_and_restart_core') &&
    rust.includes('service_rollback') &&
    rust.includes('core_rollback') &&
    rust.includes('runtime_disable_tun_if_unavailable'),
  'service lifecycle is not serialized, compensating, and atomically revalidated',
)
assert(
  sysopt.includes('WindowsProxyRecoveryRecord') &&
    sysopt.includes('win_registry_begin_proxy_mutation') &&
    sysopt.includes('win_registry_commit_proxy_mutation') &&
    sysopt.includes('win_registry_abort_proxy_mutation') &&
    sysproxyViewer.includes('authoritativePreferences') &&
    sysproxyViewer.includes('!authoritativeLoaded') &&
    !sysproxyViewer.includes('pac_file_content') &&
    !sysproxyViewer.includes('pac_content'),
  'system proxy mutation or settings UI lacks transactional recovery and authoritative reads',
)
assert(
  lifecycleController.includes("'update_ui_stage'") &&
    lifecycleController.includes("'notify_ui_ready'") &&
    !appInitialization.includes('@tauri-apps/api/core') &&
    appInitialization.includes('appLifecycleController'),
  'application startup bypasses the typed lifecycle controller',
)
assert(
  mine.includes('runtimeActionController.copyDiagnostics') &&
    controller.includes("'runtime_check_update'") &&
    controller.includes("'runtime_install_update'"),
  'diagnostics or updater check is outside the approved facade',
)

console.log('Runtime action boundary validation passed.')
