import { readFileSync } from 'node:fs'
import { existsSync } from 'node:fs'
import { resolve } from 'node:path'

const root = process.cwd()
const read = (path) => readFileSync(resolve(root, path), 'utf8')
const assert = (condition, message) => {
  if (!condition) throw new Error(`[runtime-action-boundary] ${message}`)
}

const controller = read('src/services/runtime-action-controller.ts')
const rust = read('src-tauri/src/cmd/runtime_action_controller.rs')
const lib = read('src-tauri/src/lib.rs')
const connect = read('src/pages/connect.tsx')
const nodes = read('src/pages/nodes.tsx')
const mine = read('src/pages/mine.tsx')
const selection = read('src/hooks/use-proxy-selection.ts')
const systemProxy = read('src/hooks/use-system-proxy-state.ts')
const controls = read('src/components/shared/proxy-control-switches.tsx')
const systemState = read('src/hooks/use-system-state.ts')

for (const command of [
  'runtime_set_connection_enabled',
  'runtime_set_connection_mode',
  'runtime_set_tun_enabled',
  'runtime_set_system_proxy_enabled',
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
  rust.includes('enum RuntimeConnectMode') &&
    rust.includes('validate_node_label') &&
    rust.includes('MAX_NODE_LABEL_BYTES'),
  'Rust controller accepts unbounded runtime configuration input',
)
assert(
  rust.includes('return patch_connection_state(mode, true).await'),
  'connected mode changes do not keep TUN and system proxy state aligned',
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

for (const [name, source] of [
  ['connect', connect],
  ['nodes', nodes],
  ['mine', mine],
  ['selection', selection],
  ['system-proxy', systemProxy],
  ['proxy-controls', controls],
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
    connect.includes('runtimeActionController.setConnectionMode'),
  'Connect does not use typed connection actions',
)
assert(
  selection.includes('runtimeActionController.selectNode') &&
    nodes.includes('runtimeActionController.testNodeLatency'),
  'node selection or latency test bypasses typed actions',
)
assert(
  mine.includes('runtimeActionController.copyDiagnostics') &&
    controller.includes("'runtime_check_update'") &&
    controller.includes("'runtime_install_update'"),
  'diagnostics or updater check is outside the approved facade',
)

console.log('Runtime action boundary validation passed.')
