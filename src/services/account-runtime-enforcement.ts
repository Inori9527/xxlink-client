import {
  ACCOUNT_LKG_CHANGED_EVENT,
  readInMemoryAccountAccessDecision,
  readAccountLkgCache,
} from '@/services/account-lkg-cache'
import {
  type AccountAccessDecision,
  isAccountAccessDenied,
} from '@/services/account-state-validation'
import { authStore } from '@/services/auth-store'
import { runtimeActionController } from '@/services/runtime-action-controller'
import { reportSafeClientFailure } from '@/services/safe-client-error'

export const ACCOUNT_RUNTIME_DISABLED_EVENT = 'xxlink:account-runtime-disabled'

const ENFORCEMENT_RETRY_MS = 5_000
const ENFORCEMENT_MAX_ATTEMPTS = 3

type DeniedTarget = {
  userId: string
  decision: Exclude<AccountAccessDecision, 'allowed' | 'unknown'>
  key: string
}

let started = false
let activeRun: Promise<void> | null = null
let activeRunKey: string | null = null
let lastEnforcedKey: string | null = null
let retryTimer: ReturnType<typeof setTimeout> | null = null
let retryKey: string | null = null
let reportedFailureKey: string | null = null
let attemptKey: string | null = null
let attemptCount = 0

function getDeniedTarget(): DeniedTarget | null {
  const state = authStore.getState()
  if (!state.isOperational || !state.user) return null
  const decision =
    readInMemoryAccountAccessDecision(state.user.id) ??
    readAccountLkgCache(state.user.id)?.accessDecision ??
    'unknown'
  if (!isAccountAccessDenied(decision)) return null
  return {
    userId: state.user.id,
    decision,
    key: `${state.user.id}:${decision}`,
  }
}

function clearRetry(): void {
  if (retryTimer !== null) clearTimeout(retryTimer)
  retryTimer = null
  retryKey = null
}

function resetInactiveTarget(): void {
  clearRetry()
  lastEnforcedKey = null
  reportedFailureKey = null
  attemptKey = null
  attemptCount = 0
}

function targetIsCurrent(target: DeniedTarget): boolean {
  return getDeniedTarget()?.key === target.key
}

function dispatchRuntimeDisabled(): void {
  try {
    window.dispatchEvent(new Event(ACCOUNT_RUNTIME_DISABLED_EVENT))
  } catch {
    /* ignore */
  }
}

function scheduleRetry(target: DeniedTarget): void {
  if (attemptKey !== target.key || attemptCount >= ENFORCEMENT_MAX_ATTEMPTS) {
    return
  }
  if (retryTimer !== null && retryKey === target.key) return
  clearRetry()

  const timer = setTimeout(() => {
    if (retryTimer !== timer || retryKey !== target.key) return
    retryTimer = null
    retryKey = null
    if (!targetIsCurrent(target)) return
    void enforceAuthoritativeAccountRuntime({ force: true })
  }, ENFORCEMENT_RETRY_MS)
  retryTimer = timer
  retryKey = target.key
  ;(timer as unknown as { unref?: () => void }).unref?.()
}

export async function enforceAuthoritativeAccountRuntime(
  options: { force?: boolean } = {},
): Promise<void> {
  const target = getDeniedTarget()
  if (!target) {
    resetInactiveTarget()
    return
  }
  if (!options.force && lastEnforcedKey === target.key) return
  if (!options.force && retryKey === target.key) return

  if (activeRun) {
    const currentRun = activeRun
    if (activeRunKey === target.key) return currentRun
    await currentRun
    if (!targetIsCurrent(target)) return
    return enforceAuthoritativeAccountRuntime(options)
  }

  if (attemptKey !== target.key) {
    clearRetry()
    attemptKey = target.key
    attemptCount = 0
    reportedFailureKey = null
  }
  if (attemptCount >= ENFORCEMENT_MAX_ATTEMPTS) return
  attemptCount += 1

  const run = (async () => {
    try {
      await runtimeActionController.disableConnection()
      if (!targetIsCurrent(target)) return
      clearRetry()
      lastEnforcedKey = target.key
      reportedFailureKey = null
      dispatchRuntimeDisabled()
    } catch (error) {
      if (!targetIsCurrent(target)) return
      if (reportedFailureKey !== target.key) {
        reportSafeClientFailure('account-runtime-enforcement', error)
        reportedFailureKey = target.key
      }
      scheduleRetry(target)
    }
  })()

  activeRun = run
  activeRunKey = target.key
  try {
    await run
  } finally {
    if (activeRun === run) {
      activeRun = null
      activeRunKey = null
    }
  }
}

export function startAccountRuntimeEnforcement(): void {
  if (started) return
  started = true
  const trigger = () => void enforceAuthoritativeAccountRuntime()
  authStore.subscribe(trigger)
  window.addEventListener(ACCOUNT_LKG_CHANGED_EVENT, trigger)
  trigger()
}
