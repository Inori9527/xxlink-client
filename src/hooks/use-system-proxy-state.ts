import { useQuery } from '@tanstack/react-query'

import { useVerge } from '@/hooks/use-verge'
import { useAppData } from '@/providers/app-data-context'
import { getAutotemProxy } from '@/services/cmds'
import { queryClient } from '@/services/query-client'
import { runtimeActionController } from '@/services/runtime-action-controller'
import { canSetSystemProxyEnabled } from '@/services/runtime-state-policy'

// 系统代理状态检测统一逻辑
export const useSystemProxyState = () => {
  const { verge, hasLastKnownPreferences, preferencesReady, refreshVerge } =
    useVerge()
  const { sysproxy, proxySettings, proxySettingsReady, sysproxyReady } =
    useAppData()
  const { data: autoproxy, isError: autoproxyReadFailed } = useQuery({
    queryKey: ['getAutotemProxy'],
    queryFn: getAutotemProxy,
    refetchOnWindowFocus: true,
    refetchOnReconnect: true,
  })

  const {
    enable_system_proxy,
    proxy_auto_config,
    proxy_host,
    proxy_host_valid,
    verge_mixed_port,
  } = verge ?? {}
  const authoritativeStateReady =
    preferencesReady &&
    proxy_host_valid === true &&
    proxySettingsReady &&
    sysproxyReady &&
    autoproxy !== undefined &&
    !autoproxyReadFailed
  const lastKnownEnabled = hasLastKnownPreferences
    ? (enable_system_proxy ?? false)
    : null

  // OS 实际状态：enable + 地址匹配本应用
  const indicator = (() => {
    if (!authoritativeStateReady) {
      return lastKnownEnabled === true ? true : null
    }
    const host = proxy_host || '127.0.0.1'
    if (proxy_auto_config) {
      if (!autoproxy?.enable) return false
      const pacPort = import.meta.env.DEV ? 11233 : 33331
      return autoproxy.url === `http://${host}:${pacPort}/commands/pac`
    } else {
      if (!sysproxy?.enable) return false
      const port = verge_mixed_port || proxySettings?.mixedPort || 7897
      return sysproxy.server === `${host}:${port}`
    }
  })()

  const canToggle = authoritativeStateReady || lastKnownEnabled === true

  const toggleSystemProxy = async (enabled: boolean) => {
    if (
      !canSetSystemProxyEnabled({
        requestedEnabled: enabled,
        authoritativeStateReady,
        lastKnownEnabled,
      })
    ) {
      throw new Error('system_proxy_state_unavailable')
    }
    let operationError: unknown
    try {
      await runtimeActionController.setSystemProxyEnabled(enabled)
    } catch (error) {
      operationError = error
    }

    const refreshResults = await Promise.allSettled([
      refreshVerge(),
      queryClient.invalidateQueries({ queryKey: ['getSystemProxy'] }),
      queryClient.invalidateQueries({ queryKey: ['getAutotemProxy'] }),
    ])
    if (operationError) throw operationError
    const refreshFailure = refreshResults.find(
      (result): result is PromiseRejectedResult => result.status === 'rejected',
    )
    if (refreshFailure) throw refreshFailure.reason
  }

  const invalidateProxyState = () =>
    Promise.all([
      queryClient.invalidateQueries({ queryKey: ['getSystemProxy'] }),
      queryClient.invalidateQueries({ queryKey: ['getAutotemProxy'] }),
    ])

  return {
    indicator,
    ready: authoritativeStateReady,
    canToggle,
    configState: preferencesReady ? (enable_system_proxy ?? false) : null,
    toggleSystemProxy,
    invalidateProxyState,
  }
}
