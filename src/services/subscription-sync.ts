/**
 * Subscription sync service.
 *
 * After login (or on app startup when already authenticated), this module
 * fetches the user's active subscription from the backend and ensures the
 * corresponding Clash remote profile is imported and set as current.
 */

import { api, getSubUrl, isSubscriptionActiveNow } from '@/services/api'
import {
  getProfiles,
  importProfile,
  updateProfile,
  deleteProfile,
  patchProfile,
  patchProfilesConfig,
} from '@/services/cmds'

/**
 * Fetch the current subscription from the backend, import (or refresh) the
 * Clash profile, then activate it.
 *
 * Designed to be called fire-and-forget:
 *   syncSubscription().catch(console.error)
 */
let inflight: Promise<void> | null = null

export interface SyncOptions {
  /**
   * Force a full rebuild: delete every matching remote profile, then
   * re-import from the current subscription URL. Use when a regular sync
   * is stuck (stale cached data, bad profile state, etc.).
   */
  force?: boolean
}

export async function syncSubscription(options?: SyncOptions): Promise<void> {
  // Share the in-flight promise so concurrent callers observe the actual
  // outcome instead of a spurious early-return success.
  if (inflight) return inflight
  inflight = doSync(options?.force ?? false).finally(() => {
    inflight = null
  })
  return inflight
}

async function doSync(force: boolean): Promise<void> {
  const sub = await api.subscription.current()

  if (!sub || !isSubscriptionActiveNow(sub)) {
    return
  }

  const clashUrl = getSubUrl(sub.subUrl, 'clash')
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
  const shouldReimport = force || (remoteProfiles.length > 0 && !exactMatch)

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

  if (shouldReimport) {
    try {
      window.dispatchEvent(new CustomEvent('xxlink:subscription-resync'))
    } catch {
      /* ignore */
    }
  }
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
