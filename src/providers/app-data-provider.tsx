import { useQuery } from '@tanstack/react-query'
import { listen } from '@tauri-apps/api/event'
import React, { useCallback, useEffect, useMemo, useState } from 'react'

import { useVerge } from '@/hooks/use-verge'
import {
  calcuProxies,
  getAppUptime,
  getRunningMode,
  getSystemProxy,
} from '@/services/cmds'
import { runtimeActionController } from '@/services/runtime-action-controller'
import { reportSafeClientFailure } from '@/services/safe-client-error'

import { AppDataContext, AppDataContextType } from './app-data-context'

const TQ_MIHOMO = {
  refetchOnWindowFocus: false,
  refetchOnReconnect: false,
  staleTime: 1500,
  retry: 1,
  retryDelay: 1200,
} as const

const TQ_DEFAULTS = {
  refetchOnWindowFocus: false,
  refetchOnReconnect: false,
  staleTime: 5000,
  retry: 2,
} as const

const STARTUP_QUERY_DELAY_MS = 800
const STARTUP_QUERY_TIMEOUT_MS = 6_000

class StartupQueryTimeoutError extends Error {
  constructor(label: string) {
    super(`${label} timed out`)
    this.name = 'StartupQueryTimeoutError'
  }
}

const withStartupTimeout = async <T,>(
  label: string,
  promise: Promise<T>,
): Promise<T> => {
  let timeoutId: number | undefined
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timeoutId = window.setTimeout(
          () => reject(new StartupQueryTimeoutError(label)),
          STARTUP_QUERY_TIMEOUT_MS,
        )
      }),
    ])
  } finally {
    if (timeoutId !== undefined) window.clearTimeout(timeoutId)
  }
}

// 全局数据提供者组件
export const AppDataProvider = ({
  children,
}: {
  children: React.ReactNode
}) => {
  const { verge } = useVerge()
  const [startupQueriesEnabled, setStartupQueriesEnabled] = useState(false)

  useEffect(() => {
    const timer = window.setTimeout(
      () => setStartupQueriesEnabled(true),
      STARTUP_QUERY_DELAY_MS,
    )
    return () => window.clearTimeout(timer)
  }, [])

  const { data: proxiesData, refetch: refreshProxy } = useQuery({
    queryKey: ['getProxies'],
    queryFn: () => withStartupTimeout('getProxies', calcuProxies()),
    enabled: startupQueriesEnabled,
    ...TQ_MIHOMO,
  })

  const { data: proxySettings, refetch: refreshProxySettings } = useQuery({
    queryKey: ['getProxySettings'],
    queryFn: () =>
      withStartupTimeout(
        'getProxySettings',
        runtimeActionController.getProxySettings(),
      ),
    enabled: startupQueriesEnabled,
    ...TQ_MIHOMO,
  })

  useEffect(() => {
    let lastUpdateTime = 0
    const refreshThrottle = 800

    let isUnmounted = false
    const scheduledTimeouts = new Set<number>()
    const cleanupFns: Array<() => void> = []

    const registerCleanup = (fn: () => void) => {
      if (isUnmounted) {
        try {
          fn()
        } catch (error) {
          reportSafeClientFailure('app-data-immediate-cleanup', error)
        }
      } else {
        cleanupFns.push(fn)
      }
    }

    const addWindowListener = (eventName: string, handler: EventListener) => {
      // eslint-disable-next-line @eslint-react/web-api-no-leaked-event-listener
      window.addEventListener(eventName, handler)
      return () => window.removeEventListener(eventName, handler)
    }

    const scheduleTimeout = (
      callback: () => void | Promise<void>,
      delay: number,
    ) => {
      if (isUnmounted) return -1

      const timeoutId = window.setTimeout(() => {
        scheduledTimeouts.delete(timeoutId)
        if (!isUnmounted) {
          void callback()
        }
      }, delay)

      scheduledTimeouts.add(timeoutId)
      return timeoutId
    }

    const clearAllTimeouts = () => {
      scheduledTimeouts.forEach((timeoutId) => clearTimeout(timeoutId))
      scheduledTimeouts.clear()
    }

    const handleRefreshClash = () => {
      const now = Date.now()
      if (now - lastUpdateTime <= refreshThrottle) return

      lastUpdateTime = now
      scheduleTimeout(async () => {
        await Promise.all([
          refreshProxy().catch((error) =>
            reportSafeClientFailure('app-data-proxy-refresh', error),
          ),
          refreshProxySettings().catch((error) =>
            reportSafeClientFailure('app-data-clash-refresh', error),
          ),
        ])
      }, 200)
    }

    const handleRefreshProxy = () => {
      const now = Date.now()
      if (now - lastUpdateTime <= refreshThrottle) return

      lastUpdateTime = now
      scheduleTimeout(() => {
        refreshProxy().catch((error) =>
          reportSafeClientFailure('app-data-proxy-refresh', error),
        )
      }, 200)
    }

    const initializeListeners = async () => {
      try {
        const unlistenClash = await listen(
          'verge://refresh-clash-config',
          handleRefreshClash,
        )
        const unlistenProxy = await listen(
          'verge://refresh-proxy-config',
          handleRefreshProxy,
        )

        registerCleanup(() => {
          unlistenClash()
          unlistenProxy()
        })
      } catch (error) {
        reportSafeClientFailure('app-data-event-listeners', error)

        const fallbackHandlers: Array<[string, EventListener]> = [
          ['verge://refresh-clash-config', handleRefreshClash],
          ['verge://refresh-proxy-config', handleRefreshProxy],
        ]

        fallbackHandlers.forEach(([eventName, handler]) => {
          registerCleanup(addWindowListener(eventName, handler))
        })
      }
    }

    void initializeListeners()

    return () => {
      isUnmounted = true
      clearAllTimeouts()

      cleanupFns.splice(0).forEach((fn) => {
        try {
          fn()
        } catch (error) {
          reportSafeClientFailure('app-data-cleanup', error)
        }
      })
    }
  }, [refreshProxy, refreshProxySettings])

  const { data: sysproxy, refetch: refreshSysproxy } = useQuery({
    queryKey: ['getSystemProxy'],
    queryFn: () => withStartupTimeout('getSystemProxy', getSystemProxy()),
    enabled: startupQueriesEnabled,
    ...TQ_DEFAULTS,
  })

  const { data: runningMode } = useQuery({
    queryKey: ['getRunningMode'],
    queryFn: () => withStartupTimeout('getRunningMode', getRunningMode()),
    enabled: startupQueriesEnabled,
    ...TQ_DEFAULTS,
  })

  const { data: uptimeData } = useQuery({
    queryKey: ['appUptime'],
    queryFn: () => withStartupTimeout('getAppUptime', getAppUptime()),
    enabled: startupQueriesEnabled,
    ...TQ_DEFAULTS,
    refetchInterval: 3000,
    retry: 1,
  })

  // 提供统一的刷新方法
  const refreshAll = useCallback(async () => {
    await Promise.all([
      refreshProxy(),
      refreshProxySettings(),
      refreshSysproxy(),
    ])
  }, [refreshProxy, refreshProxySettings, refreshSysproxy])

  // 聚合所有数据
  const value = useMemo(() => {
    // 计算系统代理地址
    const calculateSystemProxyAddress = () => {
      if (!verge || !proxySettings) return '-'

      const isPacMode = verge.proxy_auto_config ?? false

      if (isPacMode) {
        // PAC模式：显示我们期望设置的代理地址
        const proxyHost = verge.proxy_host || '127.0.0.1'
        const proxyPort =
          verge.verge_mixed_port || proxySettings.mixedPort || 7897
        return `${proxyHost}:${proxyPort}`
      } else {
        // HTTP代理模式：优先使用系统地址，但如果格式不正确则使用期望地址
        const systemServer = sysproxy?.server
        if (
          systemServer &&
          systemServer !== '-' &&
          !systemServer.startsWith(':')
        ) {
          return systemServer
        } else {
          // 系统地址无效，返回期望的代理地址
          const proxyHost = verge.proxy_host || '127.0.0.1'
          const proxyPort =
            verge.verge_mixed_port || proxySettings.mixedPort || 7897
          return `${proxyHost}:${proxyPort}`
        }
      }
    }

    return {
      // 数据
      proxies: proxiesData,
      proxySettings,
      sysproxy,
      runningMode,
      uptime: uptimeData || 0,

      // 提供者数据
      systemProxyAddress: calculateSystemProxyAddress(),

      // 刷新方法
      refreshProxy,
      refreshProxySettings,
      refreshSysproxy,
      refreshAll,
    } as AppDataContextType
  }, [
    proxiesData,
    proxySettings,
    sysproxy,
    runningMode,
    uptimeData,
    verge,
    refreshProxy,
    refreshProxySettings,
    refreshSysproxy,
    refreshAll,
  ])

  return <AppDataContext value={value}>{children}</AppDataContext>
}
