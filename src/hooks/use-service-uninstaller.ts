import { useCallback } from 'react'

import {
  showNotice,
  showSafeClientFailureNotice,
} from '@/services/notice-service'
import { runtimeActionController } from '@/services/runtime-action-controller'
import type { SafeClientFailureScope } from '@/services/safe-client-error'

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
    try {
      await executeWithErrorHandling(
        () => runtimeActionController.stopCore(),
        'service-stop-before-uninstall',
        'settings.statuses.clash.stopping',
      )
      await executeWithErrorHandling(
        () => runtimeActionController.uninstallService(),
        'service-uninstall',
        'settings.statuses.clashService.uninstalling',
        'settings.feedback.notifications.clashService.uninstallSuccess',
      )
    } catch (ignore) {
    } finally {
      await executeWithErrorHandling(
        () => runtimeActionController.restartCore(),
        'service-restart-after-uninstall',
        'settings.statuses.clash.restarting',
        'settings.feedback.notifications.clash.restartSuccess',
      )
      await mutateSystemState()
    }
  }, [mutateSystemState])

  return { uninstallServiceAndRestartCore }
}
