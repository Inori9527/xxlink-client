import { useCallback } from 'react'

import { installService, restartCore } from '@/services/cmds'
import {
  showNotice,
  showSafeClientFailureNotice,
} from '@/services/notice-service'
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
      () => installService(),
      'service-install',
      'settings.statuses.clashService.installing',
      'settings.feedback.notifications.clashService.installSuccess',
    )

    await executeWithErrorHandling(
      () => restartCore(),
      'service-restart-after-install',
      'settings.statuses.clash.restarting',
      'settings.feedback.notifications.clash.restartSuccess',
    )

    await mutateSystemState()
  }, [mutateSystemState])
  return { installServiceAndRestartCore }
}
