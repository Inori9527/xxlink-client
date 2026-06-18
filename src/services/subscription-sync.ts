/**
 * Subscription sync service.
 *
 * After login (or on app startup when already authenticated), this module
 * fetches the user's active subscription from the backend and ensures the
 * corresponding Clash remote profile is imported and set as current.
 */

import {
  api,
  getSubUrl,
  isSubscriptionActiveNow,
  type Node,
  type Subscription,
} from '@/services/api'
import {
  getProfiles,
  importProfile,
  updateProfile,
  deleteProfile,
  patchProfile,
  patchProfilesConfig,
} from '@/services/cmds'
import delayManager from '@/services/delay'

/**
 * Fetch the current subscription from the backend, import (or refresh) the
 * Clash profile, then activate it.
 *
 * Designed to be called fire-and-forget:
 *   syncSubscription().catch(console.error)
 */
let inflight: Promise<void> | null = null
const APPLIED_GENERATION_KEY = 'xxlink:subscription-profile-generation'

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
  const work = doSync(options?.force ?? false)
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

async function doSync(force: boolean): Promise<void> {
  const sub = await api.subscription.current()

  if (!sub || !isSubscriptionActiveNow(sub)) {
    return
  }

  let visibleNodes: Node[] | null = null
  try {
    visibleNodes = await api.nodes.list()
  } catch (err) {
    console.warn('[subscription-sync] node generation probe failed', err)
  }

  const clashUrl = getSubUrl(sub.subUrl, 'clash')
  const nextGeneration = visibleNodes
    ? buildSubscriptionProfileGeneration(sub, visibleNodes)
    : null
  const lastGeneration = readAppliedGeneration()
  const generationChanged =
    nextGeneration !== null &&
    lastGeneration !== null &&
    nextGeneration !== lastGeneration
  const profilesConfig = await getProfiles()

  const remoteProfiles =
    profilesConfig.items?.filter(
      (item) =>
        item.url &&
        item.url.includes('/subscription/') &&
        isSameSubscriptionOrigin(item.url, clashUrl),
    ) ?? []

  console.log(
    '[subscription-sync] Found',
    remoteProfiles.length,
    'matching profiles out of',
    profilesConfig.items?.length ?? 0,
  )

  const exactMatch = remoteProfiles.find(
    (item) => item.url && isSameSubscriptionUrl(item.url, clashUrl),
  )

  // Rebuild on force refresh or when the token/format changed. This avoids
  // reusing a same-origin profile that still points at an expired token.
  const shouldReimport =
    force || generationChanged || (remoteProfiles.length > 0 && !exactMatch)

  if (shouldReimport && remoteProfiles.length > 0) {
    console.log(
      '[subscription-sync] Rebuilding - deleting',
      remoteProfiles.length,
      'existing profile(s)',
    )
    for (const stale of remoteProfiles) {
      try {
        await deleteProfile(stale.uid)
      } catch (err) {
        console.warn('[subscription-sync] rebuild delete failed', err)
      }
    }

    try {
      localStorage.removeItem('clash-verge-selected-proxy-group')
      localStorage.removeItem('clash-verge-selected-proxy')
      localStorage.removeItem('clash-verge-proxy-sort-type')
    } catch {
      /* ignore */
    }
  }

  const existingItem = shouldReimport ? undefined : exactMatch
  const profileWillChange = shouldReimport || !existingItem
  let targetUid: string

  if (existingItem) {
    targetUid = existingItem.uid

    if (existingItem.name && existingItem.name.includes('\\"')) {
      await patchProfile(targetUid, { name: 'subscription.yaml' })
    }

    await updateProfile(targetUid)
  } else {
    await importProfile(clashUrl, { with_proxy: false })

    const updated = await getProfiles()
    const newItem = updated.items?.find(
      (item) => item.url && isSameSubscriptionUrl(item.url, clashUrl),
    )

    if (!newItem) {
      console.warn(
        '[subscription-sync] Imported profile not found in list after import',
      )
      return
    }

    targetUid = newItem.uid
  }

  const staleProfiles = remoteProfiles.filter((p) => p.uid !== targetUid)
  for (const stale of staleProfiles) {
    try {
      await deleteProfile(stale.uid)
    } catch {
      /* ignore */
    }
  }

  await patchProfilesConfig({ current: targetUid })

  try {
    window.dispatchEvent(new Event('verge://refresh-clash-config'))
    window.dispatchEvent(new Event('verge://refresh-proxy-config'))
  } catch {
    /* ignore */
  }

  try {
    localStorage.removeItem('xxlink:last-sync-error')
    window.dispatchEvent(new CustomEvent('xxlink:last-sync-error-changed'))
  } catch {
    /* ignore */
  }

  if (nextGeneration) {
    writeAppliedGeneration(nextGeneration)
  }

  if (profileWillChange) {
    delayManager.clearCache()
    console.log('[subscription-sync] Cleared delay cache after profile refresh')
    try {
      window.dispatchEvent(new CustomEvent('xxlink:subscription-resync'))
    } catch {
      /* ignore */
    }
  }
}

function readAppliedGeneration(): string | null {
  try {
    return localStorage.getItem(APPLIED_GENERATION_KEY)
  } catch {
    return null
  }
}

function writeAppliedGeneration(value: string): void {
  try {
    localStorage.setItem(APPLIED_GENERATION_KEY, value)
  } catch {
    /* ignore */
  }
}

function buildSubscriptionProfileGeneration(
  sub: Subscription,
  nodes: Node[],
): string {
  const plan = sub.plan
  const nodeKey = nodes
    .map((node) =>
      [
        node.id,
        node.protocol,
        node.host ?? '',
        node.port ?? '',
        node.isActive ? '1' : '0',
      ].join(':'),
    )
    .sort()
    .join('|')

  return JSON.stringify({
    status: sub.status,
    planId: sub.planId,
    planName: plan.name,
    speedLimit: plan.speedLimit,
    trafficLimit: plan.trafficLimit,
    maxDevices: plan.maxDevices,
    expireAt: sub.expireAt,
    nodes: nodeKey,
  })
}

function isSameSubscriptionOrigin(urlA: string, urlB: string): boolean {
  const keyA = getSubscriptionServiceKey(urlA)
  const keyB = getSubscriptionServiceKey(urlB)
  if (keyA && keyB) return keyA === keyB

  try {
    const a = new URL(urlA)
    const b = new URL(urlB)
    return a.origin === b.origin && a.pathname === b.pathname
  } catch {
    return false
  }
}

function isSameSubscriptionUrl(urlA: string, urlB: string): boolean {
  try {
    return new URL(urlA).toString() === new URL(urlB).toString()
  } catch {
    return urlA === urlB
  }
}

function getSubscriptionServiceKey(url: string): string | null {
  try {
    const parsed = new URL(url)
    const marker = '/subscription/'
    const markerIndex = parsed.pathname.indexOf(marker)
    if (markerIndex === -1) return null
    return `${parsed.origin}${parsed.pathname.slice(0, markerIndex + marker.length)}`
  } catch {
    return null
  }
}
