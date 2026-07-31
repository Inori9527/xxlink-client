import { useCallback, useMemo, useRef } from 'react'

import { useVerge } from '@/hooks/use-verge'
import { runtimeActionController } from '@/services/runtime-action-controller'
import { reportSafeClientFailure } from '@/services/safe-client-error'

interface ProxySelectionOptions {
  onSuccess?: () => void
  onError?: (error: unknown) => void
  enableConnectionCleanup?: boolean
  forceConnectionCleanup?: boolean
}

interface ProxyChangeRequest {
  groupName: string
  proxyName: string
  skipConfigSave: boolean
}

export const useProxySelection = (options: ProxySelectionOptions = {}) => {
  const { verge } = useVerge()
  const pendingRequestRef = useRef<ProxyChangeRequest | null>(null)
  const isProcessingRef = useRef(false)

  const {
    onSuccess,
    onError,
    enableConnectionCleanup = true,
    forceConnectionCleanup = false,
  } = options

  const config = useMemo(
    () => ({
      autoCloseConnection: verge?.auto_close_connection ?? false,
      enableConnectionCleanup,
      forceConnectionCleanup,
    }),
    [
      verge?.auto_close_connection,
      enableConnectionCleanup,
      forceConnectionCleanup,
    ],
  )

  const executeChange = useCallback(
    async (request: ProxyChangeRequest) => {
      const { groupName, proxyName, skipConfigSave } = request
      try {
        await runtimeActionController.selectNode({
          groupName,
          proxyName,
          persist: !skipConfigSave,
          closePreviousConnections:
            config.enableConnectionCleanup &&
            (config.forceConnectionCleanup || config.autoCloseConnection),
        })
        onSuccess?.()
      } catch (error) {
        reportSafeClientFailure('proxy-selection-change', error)
        onError?.(error)
      }
    },
    [config, onError, onSuccess],
  )

  const flushChangeQueue = useCallback(async () => {
    if (isProcessingRef.current) return
    isProcessingRef.current = true
    try {
      while (pendingRequestRef.current) {
        const request = pendingRequestRef.current
        pendingRequestRef.current = null
        await executeChange(request)
      }
    } finally {
      isProcessingRef.current = false
      if (pendingRequestRef.current) void flushChangeQueue()
    }
  }, [executeChange])

  const changeProxy = useCallback(
    (groupName: string, proxyName: string, skipConfigSave: boolean = false) => {
      pendingRequestRef.current = {
        groupName,
        proxyName,
        skipConfigSave,
      }
      void flushChangeQueue()
    },
    [flushChangeQueue],
  )

  const handleSelectChange = useCallback(
    (groupName: string, skipConfigSave: boolean = false) =>
      (event: { target: { value: string } }) =>
        changeProxy(groupName, event.target.value, skipConfigSave),
    [changeProxy],
  )

  const handleProxyGroupChange = useCallback(
    (group: { name: string; now?: string }, proxy: { name: string }) =>
      changeProxy(group.name, proxy.name),
    [changeProxy],
  )

  return { changeProxy, handleSelectChange, handleProxyGroupChange }
}
