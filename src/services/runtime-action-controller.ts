import { invoke } from '@tauri-apps/api/core'

import delayManager from '@/services/delay'
import { copyDiagnosticsBundleToClipboard } from '@/services/diagnostics-bundle'

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

export type RuntimePreferencesView = {
  language?: string | null
  theme_mode?: 'light' | 'dark' | 'system' | null
  traffic_graph?: boolean | null
  enable_memory_usage?: boolean | null
  menu_icon?: 'monochrome' | 'colorful' | 'disable' | null
  notice_position?:
    | 'top-left'
    | 'top-right'
    | 'bottom-left'
    | 'bottom-right'
    | null
  collapse_navbar?: boolean | null
  enable_tun_mode: boolean
  enable_system_proxy: boolean
  enable_proxy_guard?: boolean | null
  enable_bypass_check?: boolean | null
  use_default_bypass?: boolean | null
  system_proxy_bypass?: string | null
  proxy_guard_duration?: number | null
  proxy_auto_config?: boolean | null
  proxy_host?: string | null
  proxy_host_valid: boolean
  verge_mixed_port?: number | null
  auto_close_connection?: boolean | null
  auto_check_update?: boolean | null
  default_latency_timeout?: number | null
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
  proxy_host?: string
}

type NodeSelection = {
  groupName: string
  proxyName: string
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

  disableTunIfUnavailable() {
    return invoke<boolean>('runtime_disable_tun_if_unavailable')
  },

  setSystemProxyEnabled(enabled: boolean) {
    return invoke<void>('runtime_set_system_proxy_enabled', { enabled })
  },

  getProxySettings() {
    return invoke<RuntimeProxySettingsView>('runtime_get_proxy_settings')
  },

  getPreferences() {
    return invoke<RuntimePreferencesView>('runtime_get_preferences')
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

  installServiceAndRestartCore() {
    return invoke<void>('runtime_install_service_and_restart_core')
  },

  uninstallServiceAndRestartCore() {
    return invoke<void>('runtime_uninstall_service_and_restart_core')
  },

  selectNode({
    groupName,
    proxyName,
    closePreviousConnections = false,
    persist = true,
  }: NodeSelection) {
    return invoke<void>('runtime_select_node', {
      groupName,
      proxyName,
      persist,
      closePreviousConnections,
    })
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
