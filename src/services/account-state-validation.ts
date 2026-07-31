import type {
  NodeView,
  PlanView,
  PublicBenefitView,
  SubscriptionView,
  UsageView,
} from '@/services/backend-controller'

const ACCOUNT_STATUSES = new Set(['ACTIVE', 'EXPIRED', 'CANCELLED'])
const CANONICAL_UNSIGNED_DECIMAL = /^(0|[1-9]\d*)$/
const ISO_TIMESTAMP_PREFIX = /^\d{4}-\d{2}-\d{2}T/
const MAX_ACCOUNT_LIST_ITEMS = 1_000

export type AccountAccessDecision =
  | 'allowed'
  | 'unknown'
  | 'quota_exhausted'
  | 'entitlement_unavailable'

const ACCOUNT_ACCESS_DECISIONS = new Set<AccountAccessDecision>([
  'allowed',
  'unknown',
  'quota_exhausted',
  'entitlement_unavailable',
])

export function isAccountAccessDecision(
  value: unknown,
): value is AccountAccessDecision {
  return (
    typeof value === 'string' &&
    ACCOUNT_ACCESS_DECISIONS.has(value as AccountAccessDecision)
  )
}

export function parseAuthoritativeBytes(value: unknown): number | null {
  if (typeof value !== 'string' && typeof value !== 'number') return null
  if (typeof value === 'string' && !CANONICAL_UNSIGNED_DECIMAL.test(value)) {
    return null
  }
  const parsed = typeof value === 'number' ? value : Number(value)
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : null
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0
}

function isValidTimestamp(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    ISO_TIMESTAMP_PREFIX.test(value) &&
    Number.isFinite(Date.parse(value))
  )
}

function isOptionalNonNegativeInteger(value: unknown): boolean {
  return (
    value === undefined ||
    (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0)
  )
}

function isOptionalTimestamp(value: unknown): boolean {
  return value === undefined || value === null || isValidTimestamp(value)
}

function isOptionalBoolean(value: unknown): boolean {
  return value === undefined || typeof value === 'boolean'
}

function isOptionalString(value: unknown): boolean {
  return value === undefined || value === null || typeof value === 'string'
}

export function isRecognizedPlanSnapshot(plan: unknown): boolean {
  if (!isRecord(plan)) return false
  return (
    isNonEmptyString(plan.id) &&
    isNonEmptyString(plan.name) &&
    (plan.description === null || typeof plan.description === 'string') &&
    typeof plan.price === 'number' &&
    Number.isFinite(plan.price) &&
    plan.price >= 0 &&
    typeof plan.duration === 'number' &&
    Number.isSafeInteger(plan.duration) &&
    plan.duration >= 0 &&
    typeof plan.trafficLimit === 'number' &&
    Number.isSafeInteger(plan.trafficLimit) &&
    plan.trafficLimit >= 0 &&
    (plan.speedLimit === null ||
      (typeof plan.speedLimit === 'number' &&
        Number.isFinite(plan.speedLimit) &&
        plan.speedLimit >= 0)) &&
    typeof plan.maxDevices === 'number' &&
    Number.isSafeInteger(plan.maxDevices) &&
    plan.maxDevices >= 0 &&
    isOptionalString(plan.billingPeriod) &&
    isOptionalString(plan.billingCycle) &&
    isOptionalString(plan.interval) &&
    isOptionalString(plan.period) &&
    isOptionalString(plan.cycle)
  )
}

export function isRecognizedPlansSnapshot(plans: unknown): plans is PlanView[] {
  return (
    Array.isArray(plans) &&
    plans.length <= MAX_ACCOUNT_LIST_ITEMS &&
    plans.every(isRecognizedPlanSnapshot)
  )
}

function isRecognizedUsagePlan(plan: unknown): boolean {
  if (plan === null) return true
  if (!isRecord(plan)) return false
  return (
    isNonEmptyString(plan.id) &&
    isNonEmptyString(plan.name) &&
    typeof plan.duration === 'number' &&
    Number.isSafeInteger(plan.duration) &&
    plan.duration >= 0
  )
}

function isRecognizedEntitlement(entitlement: unknown): boolean {
  if (entitlement === undefined || entitlement === null) return true
  if (!isRecord(entitlement)) return false
  return (
    (entitlement.speedLimitMbps === undefined ||
      entitlement.speedLimitMbps === null ||
      parseAuthoritativeBytes(entitlement.speedLimitMbps) !== null) &&
    (entitlement.maxDevices === undefined ||
      entitlement.maxDevices === null ||
      (typeof entitlement.maxDevices === 'number' &&
        Number.isSafeInteger(entitlement.maxDevices) &&
        entitlement.maxDevices >= 0)) &&
    isOptionalString(entitlement.accessTier) &&
    isOptionalString(entitlement.nodeTier)
  )
}

export function isRecognizedSubscriptionSnapshot(
  subscription: unknown,
): subscription is SubscriptionView | null {
  if (subscription === null) return true
  if (!isRecord(subscription)) return false
  return (
    typeof subscription.status === 'string' &&
    ACCOUNT_STATUSES.has(subscription.status) &&
    isValidTimestamp(subscription.startAt) &&
    isValidTimestamp(subscription.expireAt) &&
    isNonEmptyString(subscription.id) &&
    isNonEmptyString(subscription.planId) &&
    parseAuthoritativeBytes(subscription.trafficUsed) !== null &&
    isRecognizedPlanSnapshot(subscription.plan)
  )
}

export function isRecognizedUsageSnapshot(usage: unknown): usage is UsageView {
  if (!isRecord(usage)) return false
  return (
    typeof usage.status === 'string' &&
    ACCOUNT_STATUSES.has(usage.status) &&
    isValidTimestamp(usage.startAt) &&
    isValidTimestamp(usage.expireAt) &&
    parseAuthoritativeBytes(usage.trafficUsed) !== null &&
    parseAuthoritativeBytes(usage.trafficLimit) !== null &&
    (usage.baseTrafficLimit === undefined ||
      parseAuthoritativeBytes(usage.baseTrafficLimit) !== null) &&
    (usage.bonusTrafficLimit === undefined ||
      parseAuthoritativeBytes(usage.bonusTrafficLimit) !== null) &&
    parseAuthoritativeBytes(usage.trafficRemaining) !== null &&
    typeof usage.percentUsed === 'number' &&
    Number.isFinite(usage.percentUsed) &&
    usage.percentUsed >= 0 &&
    usage.percentUsed <= 100 &&
    isRecognizedUsagePlan(usage.plan) &&
    isRecognizedEntitlement(usage.entitlement)
  )
}

export function isRecognizedPublicBenefitSnapshot(
  benefit: unknown,
): benefit is PublicBenefitView {
  if (!isRecord(benefit)) return false
  return (
    typeof benefit.visible === 'boolean' &&
    typeof benefit.isTrial === 'boolean' &&
    typeof benefit.hasPaidPlan === 'boolean' &&
    typeof benefit.canClaim === 'boolean' &&
    typeof benefit.emailVerified === 'boolean' &&
    parseAuthoritativeBytes(benefit.claimBytes) !== null &&
    parseAuthoritativeBytes(benefit.activeBonusBytes) !== null &&
    isOptionalNonNegativeInteger(benefit.cooldownHours) &&
    isOptionalNonNegativeInteger(benefit.validHours) &&
    isOptionalNonNegativeInteger(benefit.cooldownDays) &&
    isOptionalNonNegativeInteger(benefit.validDays) &&
    isOptionalTimestamp(benefit.lastClaimedAt) &&
    isOptionalTimestamp(benefit.nextClaimAt) &&
    isOptionalTimestamp(benefit.activeBonusExpiresAt) &&
    isOptionalBoolean(benefit.subscriptionCreated) &&
    isOptionalBoolean(benefit.bonusGranted)
  )
}

export function isRecognizedNodeSnapshot(node: unknown): boolean {
  if (!isRecord(node)) return false
  return (
    isNonEmptyString(node.id) &&
    isNonEmptyString(node.name) &&
    isNonEmptyString(node.protocol) &&
    typeof node.region === 'string' &&
    typeof node.isActive === 'boolean'
  )
}

export function isRecognizedNodesSnapshot(nodes: unknown): nodes is NodeView[] {
  return (
    Array.isArray(nodes) &&
    nodes.length <= MAX_ACCOUNT_LIST_ITEMS &&
    nodes.every(isRecognizedNodeSnapshot)
  )
}

export function resolveAccountAccessDecision(input: {
  previousDecision?: AccountAccessDecision
  subscriptionKnown: boolean
  subscriptionActive: boolean
  publicBenefitKnown: boolean
  activeBenefitBytes: number
  usageKnown: boolean
  usageAuthorizationKnown: boolean
  usageAuthorized: boolean
  trafficRemaining: number
}): AccountAccessDecision {
  // The effective entitlement object is stronger evidence than the base
  // subscription status: Trial and Promo may legitimately keep service
  // authorized after the base subscription expires.
  if (input.usageKnown && input.usageAuthorizationKnown) {
    if (!input.usageAuthorized) return 'entitlement_unavailable'
    return input.trafficRemaining <= 0 ? 'quota_exhausted' : 'allowed'
  }
  if (
    input.subscriptionKnown &&
    input.publicBenefitKnown &&
    !input.subscriptionActive &&
    input.activeBenefitBytes <= 0
  ) {
    return 'entitlement_unavailable'
  }
  if (
    input.previousDecision !== undefined &&
    isAccountAccessDenied(input.previousDecision)
  ) {
    return input.previousDecision
  }
  if (
    (input.subscriptionKnown && input.subscriptionActive) ||
    (input.publicBenefitKnown && input.activeBenefitBytes > 0)
  ) {
    return 'allowed'
  }
  return 'unknown'
}

export function getUsageAuthorizationEvidence(usage: UsageView): {
  known: boolean
  authorized: boolean
} {
  const known = Object.prototype.hasOwnProperty.call(usage, 'entitlement')
  return { known, authorized: known && usage.entitlement != null }
}

export function isAccountAccessDenied(
  decision: AccountAccessDecision,
): decision is Extract<
  AccountAccessDecision,
  'quota_exhausted' | 'entitlement_unavailable'
> {
  return (
    decision === 'quota_exhausted' || decision === 'entitlement_unavailable'
  )
}
