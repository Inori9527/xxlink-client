import { invoke } from '@tauri-apps/api/core'
import { getProxies } from 'tauri-plugin-mihomo-api'

import {
  classifyClientError,
  reportSafeClientFailure,
  type SafeClientFailureScope,
} from '@/services/safe-client-error'

export async function enhanceProfiles() {
  return invoke<void>('enhance_profiles')
}

export async function calcuProxies(): Promise<{
  global: IProxyGroupItem
  direct: IProxyItem
  groups: IProxyGroupItem[]
  records: Record<string, IProxyItem>
  proxies: IProxyItem[]
}> {
  const proxyResponse = await getProxies()
  const proxyRecord = proxyResponse.proxies

  // compatible with proxy-providers
  const generateItem = (name: string) => {
    if (proxyRecord[name]) return proxyRecord[name]
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

export async function getSystemProxy() {
  return invoke<{
    enable: boolean
    server: string
    bypass: string
  }>('get_sys_proxy')
}

const rejectSafeRead = (
  scope: SafeClientFailureScope,
  code: string,
  error: unknown,
): never => {
  const kind = classifyClientError(error).kind
  reportSafeClientFailure(scope, error)
  throw new Error(code, { cause: kind })
}

export async function getAutotemProxy() {
  try {
    const result = await invoke<{
      enable: boolean
      url: string
    }>('get_auto_proxy')
    return result
  } catch (error) {
    return rejectSafeRead(
      'auto-proxy-read',
      'auto_proxy_state_unavailable',
      error,
    )
  }
}

export async function getSystemInfo() {
  return invoke<string>('get_system_info')
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

export type ServiceAvailability = 'absent' | 'ready' | 'installed_unavailable'

// 获取系统服务的安全展示状态
export const getServiceAvailability = async () => {
  try {
    return await invoke<ServiceAvailability>('get_service_availability')
  } catch (error) {
    return rejectSafeRead(
      'service-availability-check',
      'service_availability_unavailable',
      error,
    )
  }
}
export const isAdmin = async () => {
  try {
    return await invoke<boolean>('app_is_admin')
  } catch (error) {
    return rejectSafeRead('admin-check', 'admin_state_unavailable', error)
  }
}
