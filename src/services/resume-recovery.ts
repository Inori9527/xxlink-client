import {
  readLatestAccountAccessDecision,
  writeAccountLkgCache,
} from '@/services/account-lkg-cache'
import { runAccountRefreshExclusive } from '@/services/account-refresh-coordinator'
import {
  getUsageAuthorizationEvidence,
  isRecognizedNodesSnapshot,
  isRecognizedPlansSnapshot,
  isRecognizedPublicBenefitSnapshot,
  isRecognizedSubscriptionSnapshot,
  isRecognizedUsageSnapshot,
  parseAuthoritativeBytes,
  resolveAccountAccessDecision,
} from '@/services/account-state-validation'
import { authStore } from '@/services/auth-store'
import {
  backendController,
  isBackendSubjectCurrent,
  isSubscriptionActiveNow,
} from '@/services/backend-controller'
import { toSafeClientFailureRecord } from '@/services/safe-client-error'
import { syncSubscription } from '@/services/subscription-sync'

const RESUME_RECOVERY_MIN_INTERVAL_MS = 30_000
const RESUME_RECOVERY_FAILURE_BACKOFF_MS = 10_000
const STARTUP_SYNC_ERROR_KEY = 'xxlink:last-sync-error'

let started = false
let running: Promise<void> | null = null
let runningUserId: string | null = null
let lastAttempt: { userId: string; at: number } | null = null
let lastFailure: { userId: string; at: number } | null = null
let retryTimer: ReturnType<typeof setTimeout> | null = null
let retryTimerUserId: string | null = null

type ResumeReason =
  | 'startup'
  | 'focus'
  | 'visible'
  | 'online'
  | 'pageshow'
  | 'connect-visible'
  | 'plans-visible'
  | 'retry'
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

type AccountRefreshOutcome = 'refreshed' | 'partial' | 'stale'

async function refreshAccountLkg(
  userId: string,
): Promise<AccountRefreshOutcome> {
  return runAccountRefreshExclusive(async () => {
    if (!isBackendSubjectCurrent(userId)) return 'stale'
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

    if (!isBackendSubjectCurrent(userId)) return 'stale'

    const plansKnown =
      plansResult.status === 'fulfilled' &&
      isRecognizedPlansSnapshot(plansResult.value)
    const subscriptionKnown =
      subscriptionResult.status === 'fulfilled' &&
      isRecognizedSubscriptionSnapshot(subscriptionResult.value)
    const usageKnown =
      usageResult.status === 'fulfilled' &&
      isRecognizedUsageSnapshot(usageResult.value)
    const publicBenefitKnown =
      benefitResult.status === 'fulfilled' &&
      isRecognizedPublicBenefitSnapshot(benefitResult.value)
    const nodesKnown =
      nodesResult.status === 'fulfilled' &&
      isRecognizedNodesSnapshot(nodesResult.value)
    const usageAuthorization = usageKnown
      ? getUsageAuthorizationEvidence(usageResult.value)
      : { known: false, authorized: false }
    const accessDecision = resolveAccountAccessDecision({
      previousDecision: readLatestAccountAccessDecision(userId),
      subscriptionKnown,
      subscriptionActive:
        subscriptionKnown && isSubscriptionActiveNow(subscriptionResult.value),
      publicBenefitKnown,
      activeBenefitBytes: publicBenefitKnown
        ? (parseAuthoritativeBytes(benefitResult.value.activeBonusBytes) ?? 0)
        : 0,
      usageKnown,
      usageAuthorizationKnown: usageAuthorization.known,
      usageAuthorized: usageAuthorization.authorized,
      trafficRemaining: usageKnown
        ? (parseAuthoritativeBytes(usageResult.value.trafficRemaining) ?? 0)
        : 0,
    })

    writeAccountLkgCache(userId, {
      plans:
        plansResult.status === 'fulfilled' && plansKnown
          ? plansResult.value
          : undefined,
      subscription:
        subscriptionResult.status === 'fulfilled' && subscriptionKnown
          ? subscriptionResult.value
          : undefined,
      usage:
        usageResult.status === 'fulfilled' && usageKnown
          ? usageResult.value
          : undefined,
      publicBenefit:
        benefitResult.status === 'fulfilled' && publicBenefitKnown
          ? benefitResult.value
          : undefined,
      nodes:
        nodesResult.status === 'fulfilled' && nodesKnown
          ? nodesResult.value
          : undefined,
      accessDecision: accessDecision === 'unknown' ? undefined : accessDecision,
    })
    return plansKnown &&
      subscriptionKnown &&
      usageKnown &&
      publicBenefitKnown &&
      nodesKnown
      ? 'refreshed'
      : 'partial'
  })
}

function cancelScheduledRetry(userId: string): void {
  if (retryTimer === null) return
  if (retryTimerUserId !== userId) return
  clearTimeout(retryTimer)
  retryTimer = null
  retryTimerUserId = null
}

function scheduleRecoveryRetry(userId: string): void {
  if (retryTimer !== null && retryTimerUserId === userId) return
  if (retryTimer !== null) clearTimeout(retryTimer)

  const timer = setTimeout(() => {
    if (retryTimer !== timer || retryTimerUserId !== userId) return
    retryTimer = null
    retryTimerUserId = null
    if (!isBackendSubjectCurrent(userId)) return
    void runResumeRecovery('retry', { force: true })
  }, RESUME_RECOVERY_FAILURE_BACKOFF_MS)
  retryTimer = timer
  retryTimerUserId = userId
  ;(timer as unknown as { unref?: () => void }).unref?.()
}

export async function runResumeRecovery(
  reason: ResumeReason = 'manual',
  options: { force?: boolean } = {},
): Promise<void> {
  const state = authStore.getState()
  if (!state.isOperational || !state.user) return
  const userId = state.user.id

  const now = Date.now()
  if (running) {
    const activeRun = running
    if (runningUserId === userId) return activeRun
    await activeRun
    if (running === activeRun) {
      running = null
      runningUserId = null
    }
    if (!isBackendSubjectCurrent(userId)) return
    return runResumeRecovery(reason, options)
  }
  if (
    !options.force &&
    lastAttempt?.userId === userId &&
    now - lastAttempt.at < RESUME_RECOVERY_MIN_INTERVAL_MS
  ) {
    return
  }
  if (
    !options.force &&
    lastFailure?.userId === userId &&
    now - lastFailure.at < RESUME_RECOVERY_FAILURE_BACKOFF_MS
  ) {
    return
  }

  lastAttempt = { userId, at: now }
  const recovery = (async () => {
    try {
      await backendController.userProfile()
      if (!isBackendSubjectCurrent(userId)) return
      const accountRefresh = await refreshAccountLkg(userId)
      if (accountRefresh === 'stale') return
      await syncSubscription({ timeoutMs: 10_000 })
      if (!isBackendSubjectCurrent(userId)) return
      if (accountRefresh === 'partial') {
        throw new Error('account_state_refresh_failed')
      }
      if (lastFailure?.userId === userId) lastFailure = null
      cancelScheduledRetry(userId)
      clearResumeSyncError()
    } catch (error) {
      if (!isBackendSubjectCurrent(userId)) return
      lastFailure = { userId, at: Date.now() }
      rememberResumeSyncError(error, reason)
      scheduleRecoveryRetry(userId)
    }
  })()
  running = recovery
  runningUserId = userId

  try {
    await recovery
  } finally {
    if (running === recovery) {
      running = null
      runningUserId = null
    }
  }
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
