import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useCallback } from 'react'

import { getVergeConfig } from '@/services/cmds'
import { getPreloadConfig, setPreloadConfig } from '@/services/preload'
import {
  runtimeActionController,
  RuntimePreferencesUpdate,
} from '@/services/runtime-action-controller'

export const useVerge = () => {
  const qc = useQueryClient()
  const initialVergeConfig = getPreloadConfig()

  const { data: verge, refetch } = useQuery({
    queryKey: ['getVergeConfig'],
    queryFn: async () => {
      const config = await getVergeConfig()
      setPreloadConfig(config)
      return config
    },
    initialData: initialVergeConfig ?? undefined,
    staleTime: 5000,
  })

  const mutateVerge = (
    updaterOrData?:
      | IVergeConfig
      | ((prev: IVergeConfig | undefined) => IVergeConfig | undefined)
      | undefined,
    _revalidate?: boolean,
  ) => {
    if (updaterOrData === undefined) {
      void refetch()
      return
    }
    if (typeof updaterOrData === 'function') {
      const prev = qc.getQueryData<IVergeConfig>(['getVergeConfig'])
      const next = updaterOrData(prev)
      qc.setQueryData(['getVergeConfig'], next)
    } else {
      qc.setQueryData(['getVergeConfig'], updaterOrData)
    }
  }

  const patchVerge = useCallback(
    async (value: RuntimePreferencesUpdate) => {
      await runtimeActionController.updatePreferences(value)
      await refetch()
    },
    [refetch],
  )

  return {
    verge,
    mutateVerge,
    patchVerge,
  }
}
