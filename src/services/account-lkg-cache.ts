import type {
  Node,
  Plan,
  PublicBenefitStatus,
  Subscription,
  UsageData,
} from '@/services/api'

const ACCOUNT_LKG_CACHE_PREFIX = 'xxlink:lkg:account:'
const ACCOUNT_LKG_CACHE_VERSION = 1
const ACCOUNT_LKG_CACHE_MAX_AGE_MS = 14 * 24 * 60 * 60 * 1000
export const ACCOUNT_LKG_CHANGED_EVENT = 'xxlink:account-lkg-changed'

export type SafeSubscriptionSnapshot = Pick<
  Subscription,
  'id' | 'planId' | 'trafficUsed' | 'startAt' | 'expireAt' | 'status' | 'plan'
>

export type SafeNodeSummary = Pick<
  Node,
  'id' | 'name' | 'protocol' | 'region' | 'isActive'
>

export interface AccountLkgCache {
  version: number
  userKey: string
  updatedAt: number
  plans: Plan[]
  subscription: SafeSubscriptionSnapshot | null
  usage: UsageData | null
  publicBenefit: PublicBenefitStatus | null
  nodes: SafeNodeSummary[]
}

export interface AccountLkgInput {
  plans?: Plan[]
  subscription?: Subscription | SafeSubscriptionSnapshot | null
  usage?: UsageData | null
  publicBenefit?: PublicBenefitStatus | null
  nodes?: Node[] | SafeNodeSummary[]
}

function hashCacheSubject(value: string): string {
  let hash = 2166136261
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index)
    hash = Math.imul(hash, 16777619)
  }
  return (hash >>> 0).toString(36)
}

function getStorage(): Storage | null {
  try {
    return globalThis.localStorage ?? null
  } catch {
    return null
  }
}

function dispatchAccountLkgChanged(): void {
  try {
    window.dispatchEvent(new CustomEvent(ACCOUNT_LKG_CHANGED_EVENT))
  } catch {
    /* ignore */
  }
}

export function getAccountLkgStorageKey(userId: string): string {
  return `${ACCOUNT_LKG_CACHE_PREFIX}${hashCacheSubject(userId)}`
}

function sanitizeSubscription(
  subscription: Subscription | SafeSubscriptionSnapshot | null | undefined,
): SafeSubscriptionSnapshot | null | undefined {
  if (subscription === undefined) return undefined
  if (subscription === null) return null
  return {
    id: subscription.id,
    planId: subscription.planId,
    trafficUsed: subscription.trafficUsed,
    startAt: subscription.startAt,
    expireAt: subscription.expireAt,
    status: subscription.status,
    plan: subscription.plan,
  }
}

export function toSafeNodeSummaries(
  nodes: Array<Node | SafeNodeSummary> | undefined,
): SafeNodeSummary[] | undefined {
  if (!nodes) return undefined
  return nodes.map((node) => ({
    id: node.id,
    name: node.name,
    protocol: node.protocol,
    region: node.region,
    isActive: node.isActive,
  }))
}

function emptyCache(userKey: string): AccountLkgCache {
  return {
    version: ACCOUNT_LKG_CACHE_VERSION,
    userKey,
    updatedAt: Date.now(),
    plans: [],
    subscription: null,
    usage: null,
    publicBenefit: null,
    nodes: [],
  }
}

export function readAccountLkgCache(
  userId: string | null | undefined,
  now = Date.now(),
): AccountLkgCache | null {
  if (!userId) return null
  const storage = getStorage()
  if (!storage) return null

  try {
    const userKey = hashCacheSubject(userId)
    const raw = storage.getItem(getAccountLkgStorageKey(userId))
    if (!raw) return null
    const parsed = JSON.parse(raw) as Partial<AccountLkgCache>
    if (
      parsed.version !== ACCOUNT_LKG_CACHE_VERSION ||
      parsed.userKey !== userKey ||
      typeof parsed.updatedAt !== 'number' ||
      now - parsed.updatedAt > ACCOUNT_LKG_CACHE_MAX_AGE_MS
    ) {
      storage.removeItem(getAccountLkgStorageKey(userId))
      return null
    }

    return {
      version: ACCOUNT_LKG_CACHE_VERSION,
      userKey,
      updatedAt: parsed.updatedAt,
      plans: Array.isArray(parsed.plans) ? parsed.plans : [],
      subscription: parsed.subscription ?? null,
      usage: parsed.usage ?? null,
      publicBenefit: parsed.publicBenefit ?? null,
      nodes: Array.isArray(parsed.nodes) ? parsed.nodes : [],
    }
  } catch {
    return null
  }
}

export function writeAccountLkgCache(
  userId: string | null | undefined,
  input: AccountLkgInput,
): AccountLkgCache | null {
  if (!userId) return null
  const storage = getStorage()
  if (!storage) return null

  const hasUpdate =
    input.plans !== undefined ||
    input.subscription !== undefined ||
    input.usage !== undefined ||
    input.publicBenefit !== undefined ||
    input.nodes !== undefined
  if (!hasUpdate) return readAccountLkgCache(userId)

  const userKey = hashCacheSubject(userId)
  const existing = readAccountLkgCache(userId) ?? emptyCache(userKey)
  const subscription = sanitizeSubscription(input.subscription)
  const nodes = toSafeNodeSummaries(input.nodes)

  const next: AccountLkgCache = {
    ...existing,
    updatedAt: Date.now(),
    plans: input.plans ?? existing.plans,
    subscription:
      subscription === undefined ? existing.subscription : subscription,
    usage: input.usage === undefined ? existing.usage : input.usage,
    publicBenefit:
      input.publicBenefit === undefined
        ? existing.publicBenefit
        : input.publicBenefit,
    nodes: nodes ?? existing.nodes,
  }

  try {
    storage.setItem(getAccountLkgStorageKey(userId), JSON.stringify(next))
    dispatchAccountLkgChanged()
    return next
  } catch {
    return null
  }
}

export function clearAccountLkgCache(userId?: string | null): void {
  const storage = getStorage()
  if (!storage) return

  try {
    if (userId) {
      storage.removeItem(getAccountLkgStorageKey(userId))
      dispatchAccountLkgChanged()
      return
    }

    const keysToRemove: string[] = []
    for (let index = 0; index < storage.length; index += 1) {
      const key = storage.key(index)
      if (key?.startsWith(ACCOUNT_LKG_CACHE_PREFIX)) keysToRemove.push(key)
    }
    keysToRemove.forEach((key) => storage.removeItem(key))
    if (keysToRemove.length > 0) dispatchAccountLkgChanged()
  } catch {
    /* ignore */
  }
}
