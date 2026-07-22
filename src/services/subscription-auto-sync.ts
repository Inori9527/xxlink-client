import { authStore } from '@/services/auth-store'
import { reportSafeClientFailure } from '@/services/safe-client-error'
import { syncSubscription } from '@/services/subscription-sync'

const AUTO_SYNC_INTERVAL_MS = 12 * 60 * 60 * 1000

let started = false
let syncTimer: ReturnType<typeof setInterval> | null = null
let unsubscribe: (() => void) | null = null
let running = false

async function runAutoSync(): Promise<void> {
  if (running || !authStore.getState().isOperational) return

  running = true
  try {
    await syncSubscription()
  } catch (error) {
    reportSafeClientFailure('subscription-auto-sync', error)
  } finally {
    running = false
  }
}

function stopTimer(): void {
  if (syncTimer) {
    clearInterval(syncTimer)
    syncTimer = null
  }
}

function syncTimerState(): void {
  if (!authStore.getState().isOperational) {
    stopTimer()
    return
  }

  if (!syncTimer) {
    syncTimer = setInterval(() => {
      void runAutoSync()
    }, AUTO_SYNC_INTERVAL_MS)
  }
}

export function startSubscriptionAutoSync(): void {
  if (started) return
  started = true

  syncTimerState()
  unsubscribe = authStore.subscribe(syncTimerState)
}

export function stopSubscriptionAutoSync(): void {
  stopTimer()
  unsubscribe?.()
  unsubscribe = null
  started = false
}
