import {
  isAccountAccessDecision,
  isRecognizedNodesSnapshot,
  isRecognizedPlansSnapshot,
  isRecognizedPublicBenefitSnapshot,
  isRecognizedSubscriptionSnapshot,
  isRecognizedUsageSnapshot,
} from '@/services/account-state-validation'
import type { AccountAccessDecision } from '@/services/account-state-validation'
import type {
  NodeView,
  PlanView,
  PublicBenefitView,
  SubscriptionView,
  UsageView,
} from '@/services/backend-controller'

const ACCOUNT_LKG_CACHE_PREFIX = 'xxlink:lkg:account:'
const ACCOUNT_LKG_CACHE_VERSION = 1
const ACCOUNT_LKG_CACHE_MAX_AGE_MS = 14 * 24 * 60 * 60 * 1000
const ACCOUNT_LKG_CACHE_MAX_FUTURE_SKEW_MS = 5 * 60 * 1000
export const ACCOUNT_LKG_CHANGED_EVENT = 'xxlink:account-lkg-changed'

const accountAccessDecisionMemory = new Map<string, AccountAccessDecision>()

export type SafeSubscriptionSnapshot = Pick<
  SubscriptionView,
  'id' | 'planId' | 'trafficUsed' | 'startAt' | 'expireAt' | 'status' | 'plan'
>

export type SafeNodeSummary = Pick<
  NodeView,
  'id' | 'name' | 'protocol' | 'region' | 'isActive'
>

export interface AccountLkgCache {
  version: number
  userKey: string
  updatedAt: number
  plans: PlanView[]
  subscription: SafeSubscriptionSnapshot | null
  usage: UsageView | null
  publicBenefit: PublicBenefitView | null
  nodes: SafeNodeSummary[]
  accessDecision: AccountAccessDecision
}

export interface AccountLkgInput {
  plans?: PlanView[]
  subscription?: SubscriptionView | SafeSubscriptionSnapshot | null
  usage?: UsageView | null
  publicBenefit?: PublicBenefitView | null
  nodes?: NodeView[] | SafeNodeSummary[]
  accessDecision?: AccountAccessDecision
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

export function readInMemoryAccountAccessDecision(
  userId: string | null | undefined,
): AccountAccessDecision | null {
  return userId ? (accountAccessDecisionMemory.get(userId) ?? null) : null
}

function sanitizeSubscription(
  subscription: SubscriptionView | SafeSubscriptionSnapshot | null | undefined,
): SafeSubscriptionSnapshot | null | undefined {
  if (subscription === undefined) return undefined
  if (subscription === null) return null
  if (!isRecognizedSubscriptionSnapshot(subscription)) return undefined
  return {
    id: subscription.id,
    planId: subscription.planId,
    trafficUsed: subscription.trafficUsed,
    startAt: subscription.startAt,
    expireAt: subscription.expireAt,
    status: subscription.status,
    plan: projectPlan(subscription.plan),
  }
}

function projectPlan(plan: PlanView): PlanView {
  return {
    id: plan.id,
    name: plan.name,
    description: plan.description,
    price: plan.price,
    duration: plan.duration,
    billingPeriod: plan.billingPeriod,
    billingCycle: plan.billingCycle,
    interval: plan.interval,
    period: plan.period,
    cycle: plan.cycle,
    trafficLimit: plan.trafficLimit,
    speedLimit: plan.speedLimit,
    maxDevices: plan.maxDevices,
  }
}

function sanitizePlans(plans: PlanView[] | undefined): PlanView[] | undefined {
  if (plans === undefined) return undefined
  return isRecognizedPlansSnapshot(plans) ? plans.map(projectPlan) : undefined
}

function sanitizeUsage(
  usage: UsageView | null | undefined,
): UsageView | null | undefined {
  if (usage === undefined || usage === null) return usage
  if (!isRecognizedUsageSnapshot(usage)) return undefined
  return {
    trafficUsed: usage.trafficUsed,
    trafficLimit: usage.trafficLimit,
    baseTrafficLimit: usage.baseTrafficLimit,
    bonusTrafficLimit: usage.bonusTrafficLimit,
    trafficRemaining: usage.trafficRemaining,
    percentUsed: usage.percentUsed,
    plan: usage.plan
      ? {
          id: usage.plan.id,
          name: usage.plan.name,
          duration: usage.plan.duration,
        }
      : null,
    entitlement:
      usage.entitlement === undefined
        ? undefined
        : usage.entitlement === null
          ? null
          : {
              speedLimitMbps: usage.entitlement.speedLimitMbps,
              maxDevices: usage.entitlement.maxDevices,
              accessTier: usage.entitlement.accessTier,
              nodeTier: usage.entitlement.nodeTier,
            },
    status: usage.status,
    expireAt: usage.expireAt,
    startAt: usage.startAt,
  }
}

function sanitizePublicBenefit(
  benefit: PublicBenefitView | null | undefined,
): PublicBenefitView | null | undefined {
  if (benefit === undefined || benefit === null) return benefit
  if (!isRecognizedPublicBenefitSnapshot(benefit)) return undefined
  return {
    visible: benefit.visible,
    isTrial: benefit.isTrial,
    hasPaidPlan: benefit.hasPaidPlan,
    canClaim: benefit.canClaim,
    emailVerified: benefit.emailVerified,
    claimBytes: benefit.claimBytes,
    activeBonusBytes: benefit.activeBonusBytes,
    cooldownHours: benefit.cooldownHours,
    validHours: benefit.validHours,
    cooldownDays: benefit.cooldownDays,
    validDays: benefit.validDays,
    lastClaimedAt: benefit.lastClaimedAt,
    nextClaimAt: benefit.nextClaimAt,
    activeBonusExpiresAt: benefit.activeBonusExpiresAt,
    subscriptionCreated: benefit.subscriptionCreated,
    bonusGranted: benefit.bonusGranted,
  }
}

export function toSafeNodeSummaries(
  nodes: Array<NodeView | SafeNodeSummary> | undefined,
): SafeNodeSummary[] | undefined {
  if (!nodes) return undefined
  if (!isRecognizedNodesSnapshot(nodes)) return undefined
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
    accessDecision: 'unknown',
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
      !Number.isSafeInteger(parsed.updatedAt) ||
      parsed.updatedAt <= 0 ||
      parsed.updatedAt > now + ACCOUNT_LKG_CACHE_MAX_FUTURE_SKEW_MS ||
      now - parsed.updatedAt > ACCOUNT_LKG_CACHE_MAX_AGE_MS
    ) {
      storage.removeItem(getAccountLkgStorageKey(userId))
      return null
    }

    const plans = sanitizePlans(parsed.plans)
    const subscription = sanitizeSubscription(parsed.subscription)
    const usage = sanitizeUsage(parsed.usage)
    const publicBenefit = sanitizePublicBenefit(parsed.publicBenefit)
    const nodes = toSafeNodeSummaries(parsed.nodes)
    const accessDecision =
      parsed.accessDecision === undefined
        ? 'unknown'
        : isAccountAccessDecision(parsed.accessDecision)
          ? parsed.accessDecision
          : undefined
    if (
      plans === undefined ||
      subscription === undefined ||
      usage === undefined ||
      publicBenefit === undefined ||
      nodes === undefined ||
      accessDecision === undefined
    ) {
      storage.removeItem(getAccountLkgStorageKey(userId))
      return null
    }

    const safeCache: AccountLkgCache = {
      version: ACCOUNT_LKG_CACHE_VERSION,
      userKey,
      updatedAt: parsed.updatedAt,
      plans,
      subscription,
      usage,
      publicBenefit,
      nodes,
      accessDecision,
    }
    const canonical = JSON.stringify(safeCache)
    if (raw !== canonical) {
      try {
        storage.setItem(getAccountLkgStorageKey(userId), canonical)
      } catch {
        try {
          storage.removeItem(getAccountLkgStorageKey(userId))
        } catch {
          /* ignore */
        }
        return null
      }
    }
    return safeCache
  } catch {
    try {
      storage.removeItem(getAccountLkgStorageKey(userId))
    } catch {
      /* ignore */
    }
    return null
  }
}

export function readLatestAccountAccessDecision(
  userId: string | null | undefined,
): AccountAccessDecision {
  return (
    readInMemoryAccountAccessDecision(userId) ??
    readAccountLkgCache(userId)?.accessDecision ??
    'unknown'
  )
}

export function writeAccountLkgCache(
  userId: string | null | undefined,
  input: AccountLkgInput,
): AccountLkgCache | null {
  if (!userId) return null

  const plans = sanitizePlans(input.plans)
  const subscription = sanitizeSubscription(input.subscription)
  const usage = sanitizeUsage(input.usage)
  const publicBenefit = sanitizePublicBenefit(input.publicBenefit)
  const nodes = toSafeNodeSummaries(input.nodes)
  const accessDecision =
    input.accessDecision === undefined
      ? undefined
      : isAccountAccessDecision(input.accessDecision)
        ? input.accessDecision
        : undefined
  if (accessDecision !== undefined) {
    accountAccessDecisionMemory.set(userId, accessDecision)
  }
  const hasUpdate =
    plans !== undefined ||
    subscription !== undefined ||
    usage !== undefined ||
    publicBenefit !== undefined ||
    nodes !== undefined ||
    accessDecision !== undefined
  if (!hasUpdate) return readAccountLkgCache(userId)

  const storage = getStorage()
  if (!storage) {
    if (accessDecision !== undefined) dispatchAccountLkgChanged()
    return null
  }

  const userKey = hashCacheSubject(userId)
  const existing = readAccountLkgCache(userId) ?? emptyCache(userKey)
  const next: AccountLkgCache = {
    ...existing,
    updatedAt: Date.now(),
    plans: plans ?? existing.plans,
    subscription:
      subscription === undefined ? existing.subscription : subscription,
    usage: usage === undefined ? existing.usage : usage,
    publicBenefit:
      publicBenefit === undefined ? existing.publicBenefit : publicBenefit,
    nodes: nodes ?? existing.nodes,
    accessDecision: accessDecision ?? existing.accessDecision,
  }

  try {
    storage.setItem(getAccountLkgStorageKey(userId), JSON.stringify(next))
    dispatchAccountLkgChanged()
    return next
  } catch {
    if (accessDecision !== undefined) dispatchAccountLkgChanged()
    return null
  }
}

export function clearAccountLkgCache(userId?: string | null): void {
  const hadMemoryDecision = userId
    ? accountAccessDecisionMemory.delete(userId)
    : accountAccessDecisionMemory.size > 0
  if (!userId) accountAccessDecisionMemory.clear()

  const storage = getStorage()
  if (!storage) {
    if (hadMemoryDecision) dispatchAccountLkgChanged()
    return
  }

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
    if (keysToRemove.length > 0 || hadMemoryDecision) {
      dispatchAccountLkgChanged()
    }
  } catch {
    if (hadMemoryDecision) dispatchAccountLkgChanged()
    /* ignore */
  }
}
