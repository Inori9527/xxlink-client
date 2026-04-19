/**
 * Subscription sync service.
 *
 * After login (or on app startup when already authenticated), this module
 * fetches the user's active subscription from the backend and ensures the
 * corresponding Clash remote profile is imported and set as current.
 */

import { api, getSubUrl } from '@/services/api'
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
  // 1. Fetch current subscription
  const sub = await api.subscription.current()

  if (!sub || sub.status !== 'ACTIVE') {
    // Nothing to sync — user has no active subscription
    return
  }

  // 2. Build the Clash-format subscription URL
  const clashUrl = getSubUrl(sub.subUrl, 'clash')

  // 3. Check existing profiles for a match
  //    Match by domain (e.g. api.xxlink.net/api/v1/subscription) so that
  //    token rotation doesn't create duplicate profiles.
  const profilesConfig = await getProfiles()

  // Match remote profiles that point to the same subscription service.
  // We check: (a) exact token match, or (b) same host + /subscription/ path.
  // We do NOT require item.type === 'remote' because it may be absent in the TS response.
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

  // Force mode: wipe every matching profile and fall through to fresh import
  if (force && remoteProfiles.length > 0) {
    console.log(
      '[subscription-sync] Force mode — deleting',
      remoteProfiles.length,
      'existing profile(s)',
    )
    for (const stale of remoteProfiles) {
      try {
        await deleteProfile(stale.uid)
      } catch (err) {
        console.warn('[subscription-sync] force delete failed', err)
      }
    }
    remoteProfiles.length = 0

    // Cached proxy-group selections may reference group names that no
    // longer exist in the freshly imported profile. Clear them so the
    // CurrentProxyCard re-initializes with the new groups.
    try {
      localStorage.removeItem('clash-verge-selected-proxy-group')
      localStorage.removeItem('clash-verge-selected-proxy')
      localStorage.removeItem('clash-verge-proxy-sort-type')
    } catch {
      // localStorage unavailable — ignore
    }
  }

  // Find exact match (same token) or pick the first matching origin profile
  const exactMatch = remoteProfiles.find(
    (item) => item.url && item.url.includes(sub.subUrl),
  )
  const existingItem = exactMatch ?? remoteProfiles[0]

  let targetUid: string

  if (existingItem) {
    // 4a. Profile already imported
    targetUid = existingItem.uid

    // If the URL changed (token rotation / plan change), update it
    if (existingItem.url !== clashUrl) {
      await patchProfile(targetUid, {
        url: clashUrl,
        name: 'subscription.yaml',
      })
    }

    // Fix escaped-quote name if present
    if (existingItem.name && existingItem.name.includes('\\"')) {
      await patchProfile(targetUid, { name: 'subscription.yaml' })
    }

    await updateProfile(targetUid)
  } else {
    // 4b. New import
    await importProfile(clashUrl, { with_proxy: false })

    // After import, re-fetch to get the newly created profile's uid
    const updated = await getProfiles()
    const newItem = updated.items?.find(
      (item) =>
        item.type === 'remote' &&
        item.url &&
        isSameSubscriptionOrigin(item.url, sub.subUrl),
    )

    if (!newItem) {
      console.warn(
        '[subscription-sync] Imported profile not found in list after import',
      )
      return
    }

    targetUid = newItem.uid
  }

  // 5. Remove stale duplicate profiles (old tokens / old plans)
  const staleProfiles = remoteProfiles.filter((p) => p.uid !== targetUid)
  for (const stale of staleProfiles) {
    try {
      await deleteProfile(stale.uid)
    } catch {
      // Ignore — might already be removed
    }
  }

  // 6. Activate the profile
  await patchProfilesConfig({ current: targetUid })

  // 7. Tell AppDataProvider to refetch clash config + proxy list so the
  //    Connect page picks up the new nodes immediately (without requiring
  //    the user to click the manual refresh button).
  try {
    window.dispatchEvent(new Event('verge://refresh-clash-config'))
    window.dispatchEvent(new Event('verge://refresh-proxy-config'))
  } catch {
    /* ignore */
  }

  // 8. Clear any stale startup-sync-error flag so login/register/main all
  //    benefit from a genuine success.
  try {
    localStorage.removeItem('xxlink:last-sync-error')
    window.dispatchEvent(new CustomEvent('xxlink:last-sync-error-changed'))
  } catch {
    /* ignore */
  }

  // 8. If we force-rebuilt, notify subscribers (e.g. CurrentProxyCard) so
  //    they can reset cached group/proxy selection state.
  if (force) {
    try {
      window.dispatchEvent(new CustomEvent('xxlink:subscription-resync'))
    } catch {
      /* ignore */
    }
  }
}

/** Check if two subscription URLs point to the same service */
function isSameSubscriptionOrigin(urlA: string, urlB: string): boolean {
  try {
    const a = new URL(urlA)
    const b = new URL(urlB)
    // Same host is enough — both are already filtered by /subscription/ path
    return a.host === b.host
  } catch {
    // Fallback: simple string comparison for host portion
    return urlA.includes('api.xxlink.net') && urlB.includes('api.xxlink.net')
  }
}
