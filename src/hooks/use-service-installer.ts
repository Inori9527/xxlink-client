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

export const useServiceInstaller = () => {
  const { mutateSystemState } = useSystemState()

  const installServiceAndRestartCore = useCallback(async () => {
    await executeWithErrorHandling(
      () => runtimeActionController.installService(),
      'service-install',
      'settings.statuses.clashService.installing',
      'settings.feedback.notifications.clashService.installSuccess',
    )

    await executeWithErrorHandling(
      () => runtimeActionController.restartCore(),
      'service-restart-after-install',
      'settings.statuses.clash.restarting',
      'settings.feedback.notifications.clash.restartSuccess',
    )

    await mutateSystemState()
  }, [mutateSystemState])
  return { installServiceAndRestartCore }
}
