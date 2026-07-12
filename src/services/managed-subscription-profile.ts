import {
  api,
  getSubUrl,
  isSubscriptionActiveNow,
  type Node,
  type Subscription,
} from '@/services/api'
import {
  deleteProfile,
  getProfiles,
  importProfile,
  patchProfile,
  patchProfilesConfig,
  updateProfile,
} from '@/services/cmds'
import delayManager from '@/services/delay'
import { reportSafeClientFailure } from '@/services/safe-client-error'

const APPLIED_GENERATION_KEY = 'xxlink:subscription-profile-generation'

export async function ensureManagedSubscriptionProfile(): Promise<void> {
  await reconcileManagedSubscriptionProfile(false)
}

export async function refreshManagedSubscriptionProfile(): Promise<void> {
  await reconcileManagedSubscriptionProfile(false)
}

export async function rebuildManagedSubscriptionProfile(): Promise<void> {
  await reconcileManagedSubscriptionProfile(true)
}

async function reconcileManagedSubscriptionProfile(
  forceRebuild: boolean,
): Promise<void> {
  const sub = await api.subscription.current()

  if (!sub || !isSubscriptionActiveNow(sub)) {
    return
  }

  let visibleNodes: Node[] | null = null
  try {
    visibleNodes = await api.nodes.list()
  } catch (error) {
    reportSafeClientFailure('subscription-sync-node-generation', error)
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

  const exactMatch = remoteProfiles.find(
    (item) => item.url && isSameSubscriptionUrl(item.url, clashUrl),
  )

  const shouldReimport =
    forceRebuild ||
    generationChanged ||
    (remoteProfiles.length > 0 && !exactMatch)

  if (shouldReimport && remoteProfiles.length > 0) {
    for (const stale of remoteProfiles) {
      try {
        await deleteProfile(stale.uid)
      } catch (error) {
        reportSafeClientFailure('subscription-sync-rebuild-delete', error)
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
      return
    }

    targetUid = newItem.uid
  }

  const staleProfiles = remoteProfiles.filter((item) => item.uid !== targetUid)
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
