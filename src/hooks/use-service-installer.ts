import { useCallback } from 'react'

import {
  showNotice,
  showSafeClientFailureNotice,
} from '@/services/notice-service'
import { runtimeActionController } from '@/services/runtime-action-controller'
import { executeWithStateRefresh } from '@/services/runtime-state-policy'
import {
  reportSafeClientFailure,
  type SafeClientFailureScope,
} from '@/services/safe-client-error'

import { useSystemState } from './use-system-state'

const executeWithErrorHandling = async (
  operation: () => Promise<void>,
  failureScope: SafeClientFailureScope,
  loadingKey: string,
  successKey?: string,
) => {
  try {
    showNotice.info(loadingKey)
    await operation()
    if (successKey) {
      showNotice.success(successKey)
    }
  } catch (err) {
    showSafeClientFailureNotice(failureScope, err)
    throw err
  }
}

export const useServiceInstaller = () => {
  const { mutateSystemState } = useSystemState()

  const installServiceAndRestartCore = useCallback(async () => {
    await executeWithStateRefresh({
      operation: () =>
        executeWithErrorHandling(
          () => runtimeActionController.installServiceAndRestartCore(),
          'service-install',
          'settings.statuses.clashService.installing',
          'settings.feedback.notifications.clashService.installSuccess',
        ),
      refresh: mutateSystemState,
      onRefreshError: (error) =>
        reportSafeClientFailure('service-install', error),
    })
  }, [mutateSystemState])
  return { installServiceAndRestartCore }
}
