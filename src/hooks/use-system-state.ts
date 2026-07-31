import { useQuery } from '@tanstack/react-query'
import { useCallback, useEffect, useRef, useState } from 'react'

import {
  getRunningMode,
  getServiceAvailability,
  isAdmin,
  type ServiceAvailability,
} from '@/services/cmds'
import { showNotice } from '@/services/notice-service'
import { runtimeActionController } from '@/services/runtime-action-controller'
import {
  getTunRuntimeAvailability,
  shouldDisableTunForUnavailableRuntime,
} from '@/services/runtime-state-policy'
import { reportSafeClientFailure } from '@/services/safe-client-error'

import { useVerge } from './use-verge'

export interface SystemState {
  runningMode: 'Sidecar' | 'Service'
  isAdminMode: boolean
  isServiceOk: boolean
  serviceAvailability: ServiceAvailability | 'unknown'
}

const defaultSystemState = {
  runningMode: 'Sidecar',
  isAdminMode: false,
  isServiceOk: false,
  serviceAvailability: 'unknown',
} as SystemState

// Grace period for service initialization during startup
const STARTUP_GRACE_MS = 10_000

/**
 * 自定义 hook 用于获取系统运行状态
 * 包括运行模式、管理员状态、系统服务是否可用
 */
export function useSystemState() {
  const { verge, preferencesReady } = useVerge()
  const disablingTunRef = useRef(false)
  const [isStartingUp, setIsStartingUp] = useState(true)

  useEffect(() => {
    const timer = setTimeout(() => setIsStartingUp(false), STARTUP_GRACE_MS)
    return () => clearTimeout(timer)
  }, [])

  const {
    data: systemState,
    isError: systemStateReadFailed,
    refetch: refetchSystemState,
    isLoading,
  } = useQuery({
    queryKey: ['getSystemState'],
    queryFn: async () => {
      const [runningMode, isAdminMode, serviceAvailability] = await Promise.all(
        [getRunningMode(), isAdmin(), getServiceAvailability()],
      )
      return {
        runningMode,
        isAdminMode,
        isServiceOk: serviceAvailability === 'ready',
        serviceAvailability,
      } as SystemState
    },
    refetchInterval: isStartingUp ? 2000 : 30000,
  })

  const mutateSystemState = useCallback(async () => {
    const result = await refetchSystemState()
    if (result.error) throw result.error
    if (!result.data) throw new Error('system_state_unavailable')
    return result.data
  }, [refetchSystemState])

  const authoritativeSystemState = systemStateReadFailed
    ? undefined
    : systemState
  const effectiveSystemState = authoritativeSystemState ?? defaultSystemState
  const systemStateReady = authoritativeSystemState !== undefined
  const isSidecarMode = effectiveSystemState.runningMode === 'Sidecar'
  const isServiceMode = effectiveSystemState.runningMode === 'Service'
  const isServiceInstalled =
    effectiveSystemState.serviceAvailability === 'ready' ||
    effectiveSystemState.serviceAvailability === 'installed_unavailable'
  const isTunModeAvailable =
    getTunRuntimeAvailability(authoritativeSystemState) === true
  const isReady = preferencesReady && systemStateReady

  const enable_tun_mode = verge?.enable_tun_mode
  const cooldownTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => {
    if (enable_tun_mode === undefined) return

    if (
      !disablingTunRef.current &&
      shouldDisableTunForUnavailableRuntime({
        tunEnabled: enable_tun_mode === true,
        preferencesReady,
        systemState: authoritativeSystemState,
        isStartingUp,
      })
    ) {
      disablingTunRef.current = true
      runtimeActionController
        .disableTunIfUnavailable()
        .then(async (disabled) => {
          if (disabled) {
            showNotice.info(
              'settings.sections.system.notifications.tunMode.autoDisabled',
            )
          } else {
            await mutateSystemState()
          }
        })
        .catch((err) => {
          reportSafeClientFailure('system-tun-disable', err)
          showNotice.error(
            'settings.sections.system.notifications.tunMode.autoDisableFailed',
          )
        })
        .finally(() => {
          // 避免 verge 数据更新不及时导致重复执行关闭 Tun 模式
          cooldownTimerRef.current = setTimeout(() => {
            disablingTunRef.current = false
            cooldownTimerRef.current = null
          }, 1000)
        })
    }

    return () => {
      if (cooldownTimerRef.current != null) {
        clearTimeout(cooldownTimerRef.current)
        cooldownTimerRef.current = null
        disablingTunRef.current = false
      }
    }
  }, [
    enable_tun_mode,
    preferencesReady,
    authoritativeSystemState,
    isStartingUp,
    mutateSystemState,
  ])

  return {
    runningMode: effectiveSystemState.runningMode,
    isAdminMode: effectiveSystemState.isAdminMode,
    isServiceOk: effectiveSystemState.isServiceOk,
    serviceAvailability: effectiveSystemState.serviceAvailability,
    isServiceInstalled,
    isSidecarMode,
    isServiceMode,
    isTunModeAvailable,
    isReady,
    mutateSystemState,
    isLoading,
  }
}
