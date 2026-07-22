import { invoke } from '@tauri-apps/api/core'

import { authStore } from '@/services/auth-store'

export interface UserView {
  id: string
  email: string
  role: 'USER' | 'ADMIN'
}

export interface PlanView {
  id: string
  name: string
  description: string | null
  price: number
  duration: number
  billingPeriod?: string | null
  billingCycle?: string | null
  interval?: string | null
  period?: string | null
  cycle?: string | null
  trafficLimit: number
  speedLimit: number | null
  maxDevices: number
}

export interface SubscriptionView {
  id: string
  planId: string
  trafficUsed: number
  startAt: string
  expireAt: string
  status: 'ACTIVE' | 'EXPIRED' | 'CANCELLED'
  plan: PlanView
}

export interface NodeView {
  id: string
  name: string
  protocol: string
  region: string
  isActive: boolean
}

export interface UsageView {
  trafficUsed: string | number
  trafficLimit: string | number
  baseTrafficLimit?: string | number
  bonusTrafficLimit?: string | number
  trafficRemaining: string | number
  percentUsed: number
  plan: { id: string; name: string; duration: number } | null
  entitlement?: {
    speedLimitMbps?: number | null
    maxDevices?: number | null
    accessTier?: string | null
    nodeTier?: string | null
  }
  status: string
  expireAt: string
  startAt: string
}

export interface PublicBenefitView {
  visible: boolean
  isTrial: boolean
  hasPaidPlan: boolean
  canClaim: boolean
  emailVerified: boolean
  claimBytes: string | number
  activeBonusBytes: string | number
  cooldownHours?: number
  validHours?: number
  cooldownDays?: number
  validDays?: number
  lastClaimedAt?: string | null
  nextClaimAt?: string | null
  activeBonusExpiresAt?: string | null
  subscriptionCreated?: boolean
  bonusGranted?: boolean
}

export interface PromoRedeemView {
  code: string
  type?: 'TRAFFIC' | 'PLAN_TRIAL' | string
  trafficGb?: number
  bonusBytes?: string | number
  validDays?: number
  expiresAt?: string
  planName?: string
  message?: string
  subscriptionCreated?: boolean
}

export interface TrafficReportInput {
  nodeId: string
  bytesUp: number
  bytesDown: number
  timestamp: number
}

export interface TrafficReportView {
  trafficUsed: string | number
  trafficLimit: string | number
  remaining: string | number
}

export type BackendControllerErrorKind =
  | 'auth'
  | 'service_blocked'
  | 'network'
  | 'invalid_response'
  | 'traffic_exceeded'
  | 'unknown'

export class BackendControllerError extends Error {
  constructor(public readonly kind: BackendControllerErrorKind) {
    super('Backend operation failed')
    this.name = 'BackendControllerError'
  }
}

const errorKinds = new Set<BackendControllerErrorKind>([
  'auth',
  'service_blocked',
  'network',
  'invalid_response',
  'traffic_exceeded',
  'unknown',
])

interface SubjectBoundReply<T> {
  subjectId: string
  data: T
}

interface SubjectBoundErrorReply {
  subjectId?: string | null
  kind: BackendControllerErrorKind
}

export function captureBackendSubject(): string | null {
  return authStore.getState().user?.id ?? null
}

export function isBackendSubjectCurrent(subjectId: string | null): boolean {
  return subjectId !== null && captureBackendSubject() === subjectId
}

function parseControllerError(error: unknown): SubjectBoundErrorReply {
  if (error && typeof error === 'object') {
    const candidate = error as Partial<SubjectBoundErrorReply>
    if (
      typeof candidate.kind === 'string' &&
      errorKinds.has(candidate.kind as BackendControllerErrorKind) &&
      (candidate.subjectId === undefined ||
        candidate.subjectId === null ||
        typeof candidate.subjectId === 'string')
    ) {
      return {
        kind: candidate.kind as BackendControllerErrorKind,
        subjectId: candidate.subjectId,
      }
    }
  }
  const kind =
    typeof error === 'string' &&
    errorKinds.has(error as BackendControllerErrorKind)
      ? (error as BackendControllerErrorKind)
      : 'unknown'
  return { kind }
}

function toControllerError(
  error: unknown,
  expectedSubject: string | null,
): BackendControllerError {
  const { kind, subjectId } = parseControllerError(error)
  const belongsToCurrentSubject =
    isBackendSubjectCurrent(expectedSubject) &&
    (subjectId === undefined ||
      subjectId === null ||
      subjectId === expectedSubject)
  if (belongsToCurrentSubject && kind === 'service_blocked') {
    authStore.setSessionStatus('service_blocked')
  } else if (belongsToCurrentSubject && kind === 'auth') {
    authStore.preserveCachedShell()
  }
  return new BackendControllerError(kind)
}

async function call<T>(command: string, args?: Record<string, unknown>) {
  const expectedSubject = captureBackendSubject()
  try {
    const reply = await invoke<SubjectBoundReply<T>>(command, args)
    if (
      !reply ||
      reply.subjectId !== expectedSubject ||
      !isBackendSubjectCurrent(expectedSubject)
    ) {
      throw new BackendControllerError('unknown')
    }
    return reply.data
  } catch (error) {
    if (error instanceof BackendControllerError) throw error
    throw toControllerError(error, expectedSubject)
  }
}

export const backendController = {
  plans: () => call<PlanView[]>('backend_get_plans'),
  subscription: () => call<SubscriptionView | null>('backend_get_subscription'),
  usage: () => call<UsageView>('backend_get_usage'),
  publicBenefit: () => call<PublicBenefitView>('backend_get_public_benefit'),
  claimPublicBenefit: () =>
    call<PublicBenefitView>('backend_claim_public_benefit'),
  nodes: () => call<NodeView[]>('backend_get_nodes'),
  userProfile: () => call<UserView>('backend_get_user_profile'),
  redeemPromo: (code: string) =>
    call<PromoRedeemView>('backend_redeem_promo', { code }),
  reportTraffic: (input: TrafficReportInput) =>
    call<TrafficReportView>('backend_report_traffic', { ...input }),
  syncManagedSubscription: (force: boolean) =>
    call<void>('managed_subscription_sync', { force }),
}

export function isTrafficExceededError(error: unknown): boolean {
  return (
    error instanceof BackendControllerError && error.kind === 'traffic_exceeded'
  )
}

export function isSubscriptionActiveNow(
  subscription:
    | Pick<SubscriptionView, 'status' | 'expireAt'>
    | null
    | undefined,
): subscription is Pick<SubscriptionView, 'status' | 'expireAt'> & {
  status: 'ACTIVE'
} {
  if (!subscription || subscription.status !== 'ACTIVE') return false
  const expireAtMs = Date.parse(subscription.expireAt)
  return Number.isFinite(expireAtMs) && expireAtMs > Date.now()
}
