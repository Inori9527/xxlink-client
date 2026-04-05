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
  patchProfilesConfig,
} from '@/services/cmds'

/**
 * Fetch the current subscription from the backend, import (or refresh) the
 * Clash profile, then activate it.
 *
 * Designed to be called fire-and-forget:
 *   syncSubscription().catch(console.error)
 */
export async function syncSubscription(): Promise<void> {
  // 1. Fetch current subscription
  const sub = await api.subscription.current()

  if (!sub || sub.status !== 'ACTIVE') {
    // Nothing to sync — user has no active subscription
    return
  }

  // 2. Build the Clash-format subscription URL
  const clashUrl = getSubUrl(sub.subUrl, 'clash')

  // 3. Check existing profiles for a match
  const profilesConfig = await getProfiles()
  const existingItem = profilesConfig.items?.find(
    (item) => item.url && sub.subUrl && item.url.includes(sub.subUrl),
  )

  let targetUid: string

  if (existingItem) {
    // 4a. Profile already imported — refresh it
    targetUid = existingItem.uid
    await updateProfile(targetUid)
  } else {
    // 4b. New import
    await importProfile(clashUrl, { with_proxy: false })

    // After import, re-fetch to get the newly created profile's uid
    const updated = await getProfiles()
    const newItem = updated.items?.find(
      (item) => item.url && sub.subUrl && item.url.includes(sub.subUrl),
    )

    if (!newItem) {
      // Import succeeded but we cannot identify the profile — bail gracefully
      console.warn(
        '[subscription-sync] Imported profile not found in list after import',
      )
      return
    }

    targetUid = newItem.uid
  }

  // 5. Activate the profile
  await patchProfilesConfig({ current: targetUid })
}
