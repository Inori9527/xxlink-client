import { useQuery } from '@tanstack/react-query'
import { useCallback } from 'react'

import { getPreloadConfig, setPreloadConfig } from '@/services/preload'
import {
  runtimeActionController,
  type RuntimePreferencesUpdate,
  type RuntimePreferencesView,
} from '@/services/runtime-action-controller'
import { isRuntimePreferencesReady } from '@/services/runtime-state-policy'

export const useVerge = () => {
  const initialVergeConfig = getPreloadConfig()

  const {
    data: verge,
    dataUpdatedAt,
    isError,
    refetch,
  } = useQuery({
    queryKey: ['getVergeConfig'],
    queryFn: async () => {
      const config = await runtimeActionController.getPreferences()
      setPreloadConfig(config)
      return config
    },
    initialData: initialVergeConfig ?? undefined,
    initialDataUpdatedAt: 0,
    staleTime: 5000,
  })

  const refreshVerge = useCallback(async () => {
    const result = await refetch()
    if (result.error) throw result.error
    if (!result.data) throw new Error('runtime_preferences_unavailable')
    return result.data
  }, [refetch])

  const patchVerge = useCallback(
    async (value: RuntimePreferencesUpdate) => {
      let operationError: unknown
      try {
        await runtimeActionController.updatePreferences(value)
      } catch (error) {
        operationError = error
      }

      let refreshError: unknown
      let refreshed: RuntimePreferencesView | undefined
      try {
        refreshed = await refreshVerge()
      } catch (error) {
        refreshError = error
      }

      if (operationError) throw operationError
      if (refreshError) throw refreshError
      return refreshed
    },
    [refreshVerge],
  )

  return {
    verge,
    hasLastKnownPreferences:
      verge !== undefined &&
      verge !== null &&
      (initialVergeConfig !== undefined && initialVergeConfig !== null
        ? true
        : dataUpdatedAt > 0),
    preferencesReady: isRuntimePreferencesReady({
      hasPreferences: verge !== undefined && verge !== null,
      dataUpdatedAt,
      hasReadError: isError,
    }),
    patchVerge,
    refreshVerge,
  }
}
