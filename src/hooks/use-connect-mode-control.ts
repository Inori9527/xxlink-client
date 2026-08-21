import { useLockFn } from 'ahooks'
import { useCallback, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'

import {
  loadConnectMode,
  persistConnectMode,
  type ConnectMode,
} from '@/hooks/use-connect-mode'
import { useServiceInstaller } from '@/hooks/use-service-installer'
import { useSystemState } from '@/hooks/use-system-state'
import { useVerge } from '@/hooks/use-verge'
import { showNotice } from '@/services/notice-service'
import { runtimeActionController } from '@/services/runtime-action-controller'
import {
  classifyClientError,
  reportSafeClientFailure,
  toSafeClientErrorMessage,
} from '@/services/safe-client-error'

export interface UseConnectModeControlOptions {
  onRefreshProxy?: () => Promise<unknown> | void
  onError?: () => void
}

export const useConnectModeControl = ({
  onRefreshProxy,
  onError,
}: UseConnectModeControlOptions = {}) => {
  const { t } = useTranslation()
  const { preferencesReady } = useVerge()
  const { isReady: systemStateReady, isTunModeAvailable } = useSystemState()
  const { installServiceAndRestartCore } = useServiceInstaller()
  const [mode, setMode] = useState<ConnectMode>(() => loadConnectMode())
  const [modeChanging, setModeChanging] = useState(false)
  const [pendingMode, setPendingMode] = useState<Exclude<
    ConnectMode,
    'system'
  > | null>(null)
  const [serviceInstalling, setServiceInstalling] = useState(false)
  const committedModeRef = useRef(mode)
  const modeChangeGenerationRef = useRef(0)
  const modeChangeQueueRef = useRef<Promise<void>>(Promise.resolve())

  const queueModeChange = useCallback(
    (next: ConnectMode, options?: { force?: boolean }) => {
      if (
        !preferencesReady ||
        (next === mode && options?.force !== true) ||
        modeChanging
      )
        return

      const requestId = ++modeChangeGenerationRef.current
      setMode(next)
      persistConnectMode(next)
      setModeChanging(true)

      const queuedChange = modeChangeQueueRef.current.then(async () => {
        try {
          await runtimeActionController.setConnectionMode(next)
          committedModeRef.current = next

          if (requestId === modeChangeGenerationRef.current) {
            setMode(next)
            persistConnectMode(next)
            if (onRefreshProxy) {
              try {
                await onRefreshProxy()
              } catch (refreshError) {
                reportSafeClientFailure('connect-mode-change', refreshError)
              }
            }
          }
        } catch (error) {
          reportSafeClientFailure('connect-mode-change', error)
          if (requestId === modeChangeGenerationRef.current) {
            setMode(committedModeRef.current)
            persistConnectMode(committedModeRef.current)
            showNotice.error(
              toSafeClientErrorMessage(classifyClientError(error).kind, t),
            )
            onError?.()
          }
        } finally {
          if (requestId === modeChangeGenerationRef.current) {
            setModeChanging(false)
          }
        }
      })

      modeChangeQueueRef.current = queuedChange
    },
    [mode, modeChanging, onError, onRefreshProxy, preferencesReady, t],
  )

  const handleModeChange = useCallback(
    (next: ConnectMode) => {
      if (
        !preferencesReady ||
        next === mode ||
        modeChanging ||
        serviceInstalling
      )
        return

      if (next !== 'system') {
        if (!systemStateReady) return
        if (isTunModeAvailable !== true) {
          setPendingMode(next)
          return
        }
      }

      setPendingMode(null)
      queueModeChange(next)
    },
    [
      isTunModeAvailable,
      mode,
      modeChanging,
      preferencesReady,
      queueModeChange,
      serviceInstalling,
      systemStateReady,
    ],
  )

  const serviceInstallMode = pendingMode

  const handleInstallService = useLockFn(async () => {
    const next = serviceInstallMode
    if (!next || serviceInstalling || !preferencesReady) return

    setServiceInstalling(true)
    try {
      await installServiceAndRestartCore()
      setPendingMode(null)
      queueModeChange(next, { force: true })
    } catch (error) {
      reportSafeClientFailure('service-install', error)
      showNotice.error(
        toSafeClientErrorMessage(classifyClientError(error).kind, t),
      )
      onError?.()
    } finally {
      setServiceInstalling(false)
    }
  })

  return {
    mode,
    modeChanging,
    pendingMode,
    preferencesReady,
    serviceInstallMode,
    serviceInstalling,
    systemStateReady,
    isTunModeAvailable,
    queueModeChange,
    setPendingMode,
    handleModeChange,
    handleInstallService,
  }
}
