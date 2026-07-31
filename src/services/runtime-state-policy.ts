import type { ServiceAvailability } from '@/services/cmds'

export type RuntimeCapabilitySnapshot = {
  isAdminMode: boolean
  isServiceOk: boolean
  serviceAvailability: ServiceAvailability | 'unknown'
}

export const isRuntimePreferencesReady = ({
  hasPreferences,
  dataUpdatedAt,
  hasReadError,
}: {
  hasPreferences: boolean
  dataUpdatedAt: number
  hasReadError: boolean
}): boolean => hasPreferences && dataUpdatedAt > 0 && !hasReadError

export const canSetSystemProxyEnabled = ({
  requestedEnabled,
  authoritativeStateReady,
  lastKnownEnabled,
}: {
  requestedEnabled: boolean
  authoritativeStateReady: boolean
  lastKnownEnabled: boolean | null
}): boolean =>
  authoritativeStateReady || (!requestedEnabled && lastKnownEnabled === true)

export const getTunRuntimeAvailability = (
  state?: RuntimeCapabilitySnapshot,
): boolean | null => {
  if (state === undefined) return null
  if (state.isAdminMode || state.serviceAvailability === 'ready') return true
  if (state.serviceAvailability === 'absent') return false
  return null
}

export const shouldDisableTunForUnavailableRuntime = ({
  tunEnabled,
  preferencesReady,
  systemState,
  isStartingUp,
}: {
  tunEnabled: boolean
  preferencesReady: boolean
  systemState?: RuntimeCapabilitySnapshot
  isStartingUp: boolean
}) =>
  tunEnabled &&
  preferencesReady &&
  !isStartingUp &&
  getTunRuntimeAvailability(systemState) === false

export const executeWithStateRefresh = async <T>({
  operation,
  refresh,
  onRefreshError,
}: {
  operation: () => Promise<T>
  refresh: () => Promise<unknown>
  onRefreshError: (error: unknown) => void
}): Promise<T> => {
  let operationFailed = false
  let operationError: unknown
  let result: T | undefined

  try {
    result = await operation()
  } catch (error) {
    operationFailed = true
    operationError = error
  }

  try {
    await refresh()
  } catch (refreshError) {
    onRefreshError(refreshError)
    if (!operationFailed) throw refreshError
  }

  if (operationFailed) throw operationError
  return result as T
}
