import { writeAccountLkgCache } from '@/services/account-lkg-cache'
import { authStore } from '@/services/auth-store'
import {
  backendController,
  isBackendSubjectCurrent,
} from '@/services/backend-controller'
import { toSafeClientFailureRecord } from '@/services/safe-client-error'
import { syncSubscription } from '@/services/subscription-sync'

const RESUME_RECOVERY_MIN_INTERVAL_MS = 30_000
const RESUME_RECOVERY_FAILURE_BACKOFF_MS = 10_000
const STARTUP_SYNC_ERROR_KEY = 'xxlink:last-sync-error'

let started = false
let running: Promise<void> | null = null
let lastAttemptAt = 0
let lastFailureAt = 0

type ResumeReason =
  | 'startup'
  | 'focus'
  | 'visible'
  | 'online'
  | 'pageshow'
  | 'connect-visible'
  | 'plans-visible'
  | 'manual'
  | 'test'

function dispatchSyncErrorChanged(): void {
  try {
    window.dispatchEvent(new CustomEvent('xxlink:last-sync-error-changed'))
  } catch {
    /* ignore */
  }
}

function rememberResumeSyncError(error: unknown, reason: ResumeReason): void {
  try {
    localStorage.setItem(
      STARTUP_SYNC_ERROR_KEY,
      JSON.stringify({
        ...toSafeClientFailureRecord('resume-recovery', error),
        reason,
        ts: Date.now(),
      }),
    )
    dispatchSyncErrorChanged()
  } catch {
    /* ignore */
  }
}

function clearResumeSyncError(): void {
  try {
    localStorage.removeItem(STARTUP_SYNC_ERROR_KEY)
    dispatchSyncErrorChanged()
  } catch {
    /* ignore */
  }
}

async function refreshAccountLkg(userId: string): Promise<boolean> {
  const [
    plansResult,
    subscriptionResult,
    usageResult,
    benefitResult,
    nodesResult,
  ] = await Promise.allSettled([
    backendController.plans(),
    backendController.subscription(),
    backendController.usage(),
    backendController.publicBenefit(),
    backendController.nodes(),
  ])

  if (!isBackendSubjectCurrent(userId)) return false

  writeAccountLkgCache(userId, {
    plans: plansResult.status === 'fulfilled' ? plansResult.value : undefined,
    subscription:
      subscriptionResult.status === 'fulfilled'
        ? subscriptionResult.value
        : undefined,
    usage: usageResult.status === 'fulfilled' ? usageResult.value : undefined,
    publicBenefit:
      benefitResult.status === 'fulfilled' ? benefitResult.value : undefined,
    nodes: nodesResult.status === 'fulfilled' ? nodesResult.value : undefined,
  })
  return true
}

export async function runResumeRecovery(
  reason: ResumeReason = 'manual',
  options: { force?: boolean } = {},
): Promise<void> {
  const state = authStore.getState()
  if (!state.isOperational || !state.user) return
  const userId = state.user.id

  const now = Date.now()
  if (!options.force && running) return running
  if (!options.force && now - lastAttemptAt < RESUME_RECOVERY_MIN_INTERVAL_MS) {
    return
  }
  if (
    !options.force &&
    lastFailureAt > 0 &&
    now - lastFailureAt < RESUME_RECOVERY_FAILURE_BACKOFF_MS
  ) {
    return
  }

  lastAttemptAt = now
  running = (async () => {
    try {
      await backendController.userProfile()
      if (!isBackendSubjectCurrent(userId)) return
      if (!(await refreshAccountLkg(userId))) return
      await syncSubscription({ timeoutMs: 10_000 })
      if (!isBackendSubjectCurrent(userId)) return
      lastFailureAt = 0
      clearResumeSyncError()
    } catch (error) {
      if (!isBackendSubjectCurrent(userId)) return
      lastFailureAt = Date.now()
      rememberResumeSyncError(error, reason)
    }
  })().finally(() => {
    running = null
  })

  return running
}

export function startResumeRecoveryListeners(): void {
  if (started) return
  started = true

  const trigger = (reason: ResumeReason) => {
    void runResumeRecovery(reason)
  }

  window.addEventListener('focus', () => trigger('focus'))
  window.addEventListener('online', () => trigger('online'))
  window.addEventListener('pageshow', () => trigger('pageshow'))
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') trigger('visible')
  })
}
