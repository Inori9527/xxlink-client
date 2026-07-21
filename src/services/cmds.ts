import { invoke } from '@tauri-apps/api/core'
import dayjs from 'dayjs'
import { getProxies, getProxyProviders } from 'tauri-plugin-mihomo-api'

import { reportSafeClientFailure } from '@/services/safe-client-error'
import { debugLog } from '@/utils/debug'

export async function getProfiles() {
  return invoke<IProfilesConfig>('get_profiles')
}

export async function enhanceProfiles() {
  return invoke<void>('enhance_profiles')
}

export async function patchProfilesConfig(profiles: IProfilesConfig) {
  return invoke<boolean>('patch_profiles_config', { profiles })
}

export async function importProfile(url: string, option?: IProfileOption) {
  return invoke<void>('import_profile', {
    url,
    option: option || { with_proxy: true },
  })
}

export async function updateProfile(index: string, option?: IProfileOption) {
  return invoke<void>('update_profile', { index, option })
}

export async function deleteProfile(index: string) {
  return invoke<void>('delete_profile', { index })
}

export async function patchProfile(
  index: string,
  profile: Partial<IProfileItem>,
) {
  return invoke<void>('patch_profile', { index, profile })
}

export async function getClashInfo() {
  return invoke<IClashInfo | null>('get_clash_info')
}

// Get runtime config which controlled by verge
export async function getRuntimeConfig() {
  return invoke<IConfigData | null>('get_runtime_config')
}

export async function getRuntimeExists() {
  return invoke<string[]>('get_runtime_exists')
}

export async function getRuntimeLogs() {
  return invoke<Record<string, [string, string][]>>('get_runtime_logs')
}

export async function getRuntimeProxyChainConfig(proxyChainExitNode: string) {
  return invoke<string>('get_runtime_proxy_chain_config', {
    proxyChainExitNode,
  })
}

export async function updateProxyChainConfigInRuntime(proxyChainConfig: any) {
  return invoke<void>('update_proxy_chain_config_in_runtime', {
    proxyChainConfig,
  })
}

export async function patchClashConfig(payload: Partial<IConfigData>) {
  return invoke<void>('patch_clash_config', { payload })
}

export async function syncTrayProxySelection() {
  return invoke<void>('sync_tray_proxy_selection')
}

export async function calcuProxies(): Promise<{
  global: IProxyGroupItem
  direct: IProxyItem
  groups: IProxyGroupItem[]
  records: Record<string, IProxyItem>
  proxies: IProxyItem[]
}> {
  const [proxyResponse, providerResponse] = await Promise.all([
    getProxies(),
    calcuProxyProviders(),
  ])

  const proxyRecord = proxyResponse.proxies
  const providerRecord = providerResponse

  // provider name map
  const providerMap = Object.fromEntries(
    Object.entries(providerRecord).flatMap(([provider, item]) =>
      item!.proxies.map((p) => [p.name, { ...p, provider }]),
    ),
  )

  // compatible with proxy-providers
  const generateItem = (name: string) => {
    if (proxyRecord[name]) return proxyRecord[name]
    if (providerMap[name]) return providerMap[name]
    return {
      name,
      type: 'unknown',
      udp: false,
      xudp: false,
      tfo: false,
      mptcp: false,
      smux: false,
      history: [],
    }
  }

  const { GLOBAL: global, DIRECT: direct, REJECT: reject } = proxyRecord

  let groups: IProxyGroupItem[] = Object.values(proxyRecord).reduce<
    IProxyGroupItem[]
  >((acc, each) => {
    if (each?.name !== 'GLOBAL' && each?.all) {
      acc.push({
        ...each,
        all: each.all!.map((item) => generateItem(item)),
      })
    }

    return acc
  }, [])

  if (global?.all) {
    const globalGroups: IProxyGroupItem[] = global.all.reduce<
      IProxyGroupItem[]
    >((acc, name) => {
      if (proxyRecord[name]?.all) {
        acc.push({
          ...proxyRecord[name],
          all: proxyRecord[name].all!.map((item) => generateItem(item)),
        })
      }
      return acc
    }, [])

    const globalNames = new Set(globalGroups.map((each) => each.name))
    groups = groups
      .filter((group) => {
        return !globalNames.has(group.name)
      })
      .concat(globalGroups)
  }

  const proxies = [direct, reject].concat(
    Object.values(proxyRecord).filter(
      (p) => !p?.all?.length && p?.name !== 'DIRECT' && p?.name !== 'REJECT',
    ),
  )

  const _global = {
    ...global,
    all: global?.all?.map((item) => generateItem(item)) || [],
  }

  return {
    global: _global as IProxyGroupItem,
    direct: direct as IProxyItem,
    groups,
    records: proxyRecord as Record<string, IProxyItem>,
    proxies: (proxies as IProxyItem[]) ?? [],
  }
}

export async function calcuProxyProviders() {
  const providers = await getProxyProviders()
  return Object.fromEntries(
    Object.entries(providers.providers)
      .sort()
      .filter(
        ([_, item]) =>
          item?.vehicleType === 'HTTP' || item?.vehicleType === 'File',
      ),
  )
}

export async function getClashLogs() {
  const regex = /time="(.+?)"\s+level=(.+?)\s+msg="(.+?)"/
  const newRegex = /(.+?)\s+(.+?)\s+(.+)/
  const logs = await invoke<string[]>('get_clash_logs')

  return logs.reduce<ILogItem[]>((acc, log) => {
    const result = log.match(regex)
    if (result) {
      const [_, _time, type, payload] = result
      const time = dayjs(_time).format('MM-DD HH:mm:ss')
      acc.push({ time, type, payload })
      return acc
    }

    const result2 = log.match(newRegex)
    if (result2) {
      const [_, time, type, payload] = result2
      acc.push({ time, type, payload })
    }
    return acc
  }, [])
}

export async function getVergeConfig() {
  return invoke<IVergeConfig>('get_verge_config')
}

export async function patchVergeConfig(payload: IVergeConfig) {
  return invoke<void>('patch_verge_config', { payload })
}

export async function getSystemProxy() {
  return invoke<{
    enable: boolean
    server: string
    bypass: string
  }>('get_sys_proxy')
}

export async function getAutotemProxy() {
  try {
    debugLog('[API] 开始调用 get_auto_proxy')
    const result = await invoke<{
      enable: boolean
      url: string
    }>('get_auto_proxy')
    debugLog('[API] get_auto_proxy 调用成功:', result)
    return result
  } catch (error) {
    reportSafeClientFailure('auto-proxy-read', error)
    return {
      enable: false,
      url: '',
    }
  }
}

export async function getAutoLaunchStatus() {
  try {
    return await invoke<boolean>('get_auto_launch_status')
  } catch (error) {
    reportSafeClientFailure('auto-launch-read', error)
    return false
  }
}

export async function changeClashCore(clashCore: string) {
  return invoke<string | null>('change_clash_core', { clashCore })
}

export async function startCore() {
  return invoke<void>('start_core')
}

export async function stopCore() {
  return invoke<void>('stop_core')
}

export async function restartCore() {
  return invoke<void>('restart_core')
}

export async function restartApp() {
  return invoke<void>('restart_app')
}

export async function getAppDir() {
  return invoke<string>('get_app_dir')
}

export async function cmdTestDelay(url: string) {
  return invoke<number>('test_delay', { url })
}

export async function exportDiagnosticInfo() {
  return invoke('export_diagnostic_info')
}

export async function getSystemInfo() {
  return invoke<string>('get_system_info')
}

export async function getNetworkInterfaces() {
  return invoke<string[]>('get_network_interfaces')
}

export async function getSystemHostname() {
  return invoke<string>('get_system_hostname')
}

export async function getNetworkInterfacesInfo() {
  return invoke<INetworkInterface[]>('get_network_interfaces_info')
}

// 获取当前运行模式
export const getRunningMode = async () => {
  return invoke<string>('get_running_mode')
}

// 获取应用运行时间
export const getAppUptime = async () => {
  return invoke<number>('get_app_uptime')
}

// 安装系统服务
export const installService = async () => {
  return invoke<void>('install_service')
}

// 卸载系统服务
export const uninstallService = async () => {
  return invoke<void>('uninstall_service')
}

// 重装系统服务
export const reinstallService = async () => {
  return invoke<void>('reinstall_service')
}

// 修复系统服务
export const repairService = async () => {
  return invoke<void>('repair_service')
}

// 系统服务是否可用
export const isServiceAvailable = async () => {
  try {
    return await invoke<boolean>('is_service_available')
  } catch (error) {
    reportSafeClientFailure('service-availability-check', error)
    return false
  }
}
export const exit_lightweight_mode = async () => {
  return invoke<void>('exit_lightweight_mode')
}
export const isAdmin = async () => {
  try {
    return await invoke<boolean>('app_is_admin')
  } catch (error) {
    reportSafeClientFailure('admin-check', error)
    return false
  }
}
