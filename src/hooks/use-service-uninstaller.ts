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

export const useServiceUninstaller = () => {
  const { mutateSystemState } = useSystemState()

  const uninstallServiceAndRestartCore = useCallback(async () => {
    await executeWithStateRefresh({
      operation: () =>
        executeWithErrorHandling(
          () => runtimeActionController.uninstallServiceAndRestartCore(),
          'service-uninstall',
          'settings.statuses.clashService.uninstalling',
          'settings.feedback.notifications.clashService.uninstallSuccess',
        ),
      refresh: mutateSystemState,
      onRefreshError: (error) =>
        reportSafeClientFailure('service-uninstall', error),
    })
  }, [mutateSystemState])

  return { uninstallServiceAndRestartCore }
}
