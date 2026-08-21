import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import test from 'node:test'
import ts from 'typescript'
import vm from 'node:vm'

const repoRoot = resolve(import.meta.dirname, '..')

const loadPolicy = () => {
  const fileName = resolve(repoRoot, 'src/services/runtime-state-policy.ts')
  const source = readFileSync(fileName, 'utf8')
  const { outputText } = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
    },
    fileName,
  })
  const module = { exports: {} }
  const fn = vm.runInNewContext(
    `(function (exports, module) {\n${outputText}\n})`,
    {},
    { filename: fileName },
  )
  fn(module.exports, module)
  return module.exports
}

test('unknown runtime capability state never disables TUN', () => {
  const policy = loadPolicy()

  assert.equal(policy.getTunRuntimeAvailability(undefined), null)
  assert.equal(
    policy.shouldDisableTunForUnavailableRuntime({
      tunEnabled: true,
      preferencesReady: true,
      systemState: undefined,
      isStartingUp: false,
    }),
    false,
  )
})

test('cached or failed preference reads never become authoritative', () => {
  const policy = loadPolicy()

  assert.equal(
    policy.isRuntimePreferencesReady({
      hasPreferences: true,
      dataUpdatedAt: 0,
      hasReadError: false,
    }),
    false,
  )
  assert.equal(
    policy.isRuntimePreferencesReady({
      hasPreferences: true,
      dataUpdatedAt: 1,
      hasReadError: true,
    }),
    false,
  )
  assert.equal(
    policy.isRuntimePreferencesReady({
      hasPreferences: true,
      dataUpdatedAt: 1,
      hasReadError: false,
    }),
    true,
  )
})

test('unknown system proxy state blocks enable but preserves safe disable', () => {
  const policy = loadPolicy()

  assert.equal(
    policy.canSetSystemProxyEnabled({
      requestedEnabled: true,
      authoritativeStateReady: false,
      lastKnownEnabled: true,
    }),
    false,
  )
  assert.equal(
    policy.canSetSystemProxyEnabled({
      requestedEnabled: false,
      authoritativeStateReady: false,
      lastKnownEnabled: true,
    }),
    true,
  )
  assert.equal(
    policy.canSetSystemProxyEnabled({
      requestedEnabled: false,
      authoritativeStateReady: false,
      lastKnownEnabled: false,
    }),
    false,
  )
  assert.equal(
    policy.canSetSystemProxyEnabled({
      requestedEnabled: true,
      authoritativeStateReady: true,
      lastKnownEnabled: null,
    }),
    true,
  )
})

test('last-known-good capability state survives a transient read failure', () => {
  const policy = loadPolicy()
  const cachedState = {
    isAdminMode: false,
    isServiceOk: true,
    serviceAvailability: 'ready',
  }

  assert.equal(policy.getTunRuntimeAvailability(cachedState), true)
  assert.equal(
    policy.shouldDisableTunForUnavailableRuntime({
      tunEnabled: true,
      preferencesReady: true,
      systemState: cachedState,
      isStartingUp: false,
    }),
    false,
  )
})

test('only an authoritative unavailable state disables TUN', () => {
  const policy = loadPolicy()
  const unavailableState = {
    isAdminMode: false,
    isServiceOk: false,
    serviceAvailability: 'absent',
  }
  const installedUnavailableState = {
    isAdminMode: false,
    isServiceOk: false,
    serviceAvailability: 'installed_unavailable',
  }

  assert.equal(
    policy.shouldDisableTunForUnavailableRuntime({
      tunEnabled: true,
      preferencesReady: true,
      systemState: installedUnavailableState,
      isStartingUp: false,
    }),
    false,
  )
  assert.equal(
    policy.shouldDisableTunForUnavailableRuntime({
      tunEnabled: true,
      preferencesReady: true,
      systemState: unavailableState,
      isStartingUp: false,
    }),
    true,
  )
  assert.equal(
    policy.shouldDisableTunForUnavailableRuntime({
      tunEnabled: true,
      preferencesReady: false,
      systemState: unavailableState,
      isStartingUp: false,
    }),
    false,
  )
})

test('state refresh never replaces a primary lifecycle failure', async () => {
  const policy = loadPolicy()
  const operationError = new Error('operation_failed')
  const refreshError = new Error('refresh_failed')
  const reported = []

  await assert.rejects(
    policy.executeWithStateRefresh({
      operation: async () => {
        throw operationError
      },
      refresh: async () => {
        throw refreshError
      },
      onRefreshError: (error) => reported.push(error),
    }),
    (error) => error === operationError,
  )
  assert.deepEqual(reported, [refreshError])

  await assert.rejects(
    policy.executeWithStateRefresh({
      operation: async () => 'ok',
      refresh: async () => {
        throw refreshError
      },
      onRefreshError: () => {},
    }),
    (error) => error === refreshError,
  )
})

test('runtime controls reject failed reads and gate unsafe mutations', () => {
  const commands = readFileSync(
    resolve(repoRoot, 'src/services/cmds.ts'),
    'utf8',
  )
  const proxyState = readFileSync(
    resolve(repoRoot, 'src/hooks/use-system-proxy-state.ts'),
    'utf8',
  )
  const preferences = readFileSync(
    resolve(repoRoot, 'src/hooks/use-verge.ts'),
    'utf8',
  )
  const appData = readFileSync(
    resolve(repoRoot, 'src/providers/app-data-provider.tsx'),
    'utf8',
  )
  const systemState = readFileSync(
    resolve(repoRoot, 'src/hooks/use-system-state.ts'),
    'utf8',
  )
  const connect = readFileSync(
    resolve(repoRoot, 'src/pages/connect.tsx'),
    'utf8',
  )
  const runtimeController = readFileSync(
    resolve(repoRoot, 'src-tauri/src/cmd/runtime_action_controller.rs'),
    'utf8',
  )
  const systemProxy = readFileSync(
    resolve(repoRoot, 'src-tauri/src/core/sysopt.rs'),
    'utf8',
  )
  const embeddedServer = readFileSync(
    resolve(repoRoot, 'src-tauri/src/utils/server.rs'),
    'utf8',
  )
  assert.match(commands, /service_availability_unavailable/)
  assert.match(commands, /admin_state_unavailable/)
  assert.doesNotMatch(
    commands,
    /service-availability-check'[\s\S]{0,160}return false/,
  )
  assert.doesNotMatch(commands, /admin-check'[\s\S]{0,160}return false/)
  assert.doesNotMatch(connect, /ProxyControlSwitches/)
  assert.doesNotMatch(connect, /handleProxyControlError/)
  assert.match(proxyState, /canSetSystemProxyEnabled\(\{/)
  assert.match(proxyState, /proxy_host_valid === true/)
  assert.match(
    proxyState,
    /authoritativeStateReady \|\| lastKnownEnabled === true/,
  )
  assert.match(preferences, /initialDataUpdatedAt:\s*0/)
  assert.match(preferences, /hasReadError:\s*isError/)
  assert.match(preferences, /hasLastKnownPreferences:/)
  assert.match(proxyState, /const lastKnownEnabled = hasLastKnownPreferences/)
  assert.match(proxyState, /!autoproxyReadFailed/)
  assert.match(appData, /!proxySettingsReadFailed/)
  assert.match(appData, /!sysproxyReadFailed/)
  assert.match(systemState, /isError:\s*systemStateReadFailed/)
  assert.match(
    systemState,
    /const authoritativeSystemState = systemStateReadFailed[\s\S]{0,80}\?\s*undefined/,
  )
  assert.match(systemState, /serviceAvailability: 'unknown'/)
  assert.match(
    systemState,
    /serviceAvailability === 'ready'[\s\S]{0,120}serviceAvailability === 'installed_unavailable'/,
  )
  assert.match(systemState, /systemState:\s*authoritativeSystemState/)
  assert.match(
    connect,
    /const \{ verge, preferencesReady, refreshVerge \} = useVerge\(\)/,
  )
  assert.match(
    connect,
    /if \(\s*!preferencesReady\s*\|\|\s*next === mode\s*\|\|\s*modeChanging\s*\|\|\s*serviceInstalling\s*\)/,
  )
  assert.match(connect, /if \(isTunModeAvailable !== true\)/)
  assert.match(connect, /await installServiceAndRestartCore\(\)/)
  assert.match(connect, /setPendingMode\(next\)/)
  assert.match(connect, /const serviceInstallMode/)
  assert.match(
    connect,
    /\(!preferencesReady && !runtimeMayRequireDisable\) \|\|\s*busy/,
  )
  assert.match(
    connect,
    /const tunEnabled = preferencesReady && lastKnownTunEnabled/,
  )
  assert.match(
    connect,
    /const sysEnabled = preferencesReady && lastKnownSystemProxyEnabled/,
  )
  assert.match(connect, /const next = !runtimeMayRequireDisable/)
  assert.match(
    runtimeController,
    /should_disable_tun_for_service_availability\(is_admin, service_availability\)/,
  )
  assert.match(
    systemProxy,
    /None if sys_enable[\s\S]{0,180}source_read_failed\(\)/,
  )
  assert.match(embeddedServer, /StatusCode::SERVICE_UNAVAILABLE/)
})
