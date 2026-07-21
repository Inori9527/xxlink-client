import {
  rebuildManagedSubscriptionProfile,
  refreshManagedSubscriptionProfile,
} from '@/services/managed-subscription-profile'

/**
 * Fetch the current subscription from the backend, import (or refresh) the
 * Clash profile, then activate it.
 *
 * Designed to be called fire-and-forget:
 *   syncSubscription().catch((error) =>
 *     reportSafeClientFailure('subscription-sync', error),
 *   )
 */
let inflight: Promise<void> | null = null

export interface SyncOptions {
  /**
   * Force a full rebuild: delete every matching remote profile, then
   * re-import from the current subscription URL. Use when a regular sync
   * is stuck (stale cached data, bad profile state, etc.).
   */
  force?: boolean
  timeoutMs?: number
}

export class SubscriptionSyncTimeoutError extends Error {
  constructor(timeoutMs: number) {
    super(`Subscription sync timed out after ${timeoutMs}ms`)
    this.name = 'SubscriptionSyncTimeoutError'
  }
}

export async function syncSubscription(options?: SyncOptions): Promise<void> {
  // Share the in-flight promise so concurrent callers observe the actual
  // outcome instead of a spurious early-return success.
  if (inflight) return inflight
  const timeoutMs = options?.timeoutMs ?? 15_000
  const work = options?.force
    ? rebuildManagedSubscriptionProfile()
    : refreshManagedSubscriptionProfile()
  work.catch(() => {
    /* observed by race below */
  })
  const timeout = new Promise<never>((_, reject) => {
    window.setTimeout(
      () => reject(new SubscriptionSyncTimeoutError(timeoutMs)),
      timeoutMs,
    )
  })
  inflight = Promise.race([work, timeout]).finally(() => {
    inflight = null
  })
  return inflight
}
