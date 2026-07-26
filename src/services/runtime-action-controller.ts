import { invoke } from '@tauri-apps/api/core'
import { closeConnection, getConnections } from 'tauri-plugin-mihomo-api'

import delayManager from '@/services/delay'
import { copyDiagnosticsBundleToClipboard } from '@/services/diagnostics-bundle'
import { reportSafeClientFailure } from '@/services/safe-client-error'

export type ApprovedUpdateView = {
  version: string
  body: string | null
  date: string | null
}

export type TunSettingsView = {
  stack: 'gvisor' | 'system' | 'mixed'
  device: string
  autoRoute: boolean
  autoRedirect: boolean
  autoDetectInterface: boolean
  dnsHijack: string[]
  routeExcludeAddress: string[]
  strictRoute: boolean
  mtu: number
}

export type RuntimeProxySettingsView = {
  mixedPort: number
}

export type RuntimePreferencesUpdate = {
  collapse_navbar?: boolean
  language?: string
  enable_proxy_guard?: boolean
  enable_bypass_check?: boolean
  proxy_guard_duration?: number
  system_proxy_bypass?: string
  proxy_auto_config?: boolean
  use_default_bypass?: boolean
  pac_file_content?: string
  proxy_host?: string
}

type NodeSelection = {
  groupName: string
  proxyName: string
  previousProxy?: string
  closePreviousConnections?: boolean
  persist?: boolean
}

type RuntimeConnectMode = 'system' | 'both' | 'smart'

type LatencyTest = {
  nodeNames: string[]
  groupName: string
  timeoutMs: number
  concurrency?: number
}

const cleanupPreviousConnections = async (previousProxy: string) => {
  const { connections } = await getConnections()
  await Promise.allSettled(
    (connections ?? [])
      .filter((connection) => connection.chains.includes(previousProxy))
      .map((connection) => closeConnection(connection.id)),
  )
}

export const runtimeActionController = {
  setConnectionEnabled(mode: RuntimeConnectMode, enabled: boolean) {
    return invoke<void>('runtime_set_connection_enabled', { mode, enabled })
  },

  setConnectionMode(mode: RuntimeConnectMode) {
    return invoke<void>('runtime_set_connection_mode', { mode })
  },

  setTunEnabled(enabled: boolean) {
    return invoke<void>('runtime_set_tun_enabled', { enabled })
  },

  setSystemProxyEnabled(enabled: boolean) {
    return invoke<void>('runtime_set_system_proxy_enabled', { enabled })
  },

  getProxySettings() {
    return invoke<RuntimeProxySettingsView>('runtime_get_proxy_settings')
  },

  getTunSettings() {
    return invoke<TunSettingsView>('runtime_get_tun_settings')
  },

  updateTunSettings(settings: TunSettingsView) {
    return invoke<TunSettingsView>('runtime_update_tun_settings', { settings })
  },

  updatePreferences(preferences: RuntimePreferencesUpdate) {
    return invoke<void>('runtime_update_preferences', { preferences })
  },

  refreshSystemProxy() {
    return invoke<void>('runtime_refresh_system_proxy')
  },

  startCore() {
    return invoke<void>('start_core')
  },

  stopCore() {
    return invoke<void>('stop_core')
  },

  restartCore() {
    return invoke<void>('restart_core')
  },

  installService() {
    return invoke<void>('install_service')
  },

  uninstallService() {
    return invoke<void>('uninstall_service')
  },

  async selectNode({
    groupName,
    proxyName,
    previousProxy,
    closePreviousConnections = false,
    persist = true,
  }: NodeSelection) {
    await invoke<void>('runtime_select_node', { groupName, proxyName, persist })
    if (closePreviousConnections && previousProxy) {
      setTimeout(() => {
        void cleanupPreviousConnections(previousProxy).catch((error) => {
          reportSafeClientFailure('proxy-selection-cleanup', error)
        })
      }, 0)
    }
  },

  testNodeLatency({
    nodeNames,
    groupName,
    timeoutMs,
    concurrency = 6,
  }: LatencyTest) {
    return delayManager.checkListDelay(
      nodeNames,
      groupName,
      timeoutMs,
      concurrency,
    )
  },

  copyDiagnostics() {
    return copyDiagnosticsBundleToClipboard()
  },

  checkUpdate() {
    return invoke<ApprovedUpdateView | null>('runtime_check_update')
  },

  installUpdate(expectedVersion: string) {
    return invoke<void>('runtime_install_update', { expectedVersion })
  },
} as const
