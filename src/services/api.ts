import { getName, getVersion } from '@tauri-apps/api/app'
import { asyncRetry } from 'foxts/async-retry'
import { once } from 'foxts/once'

import { apiRefreshToken, AuthError } from '@/services/auth'
import { authStore } from '@/services/auth-store'
import { BASE_URL } from '@/services/config'
import { fetchWithTimeout } from '@/services/http'
import { expireSession } from '@/services/session'
import { debugLog } from '@/utils/debug'

// ---------------------------------------------------------------------------
// Shared type definitions
// ---------------------------------------------------------------------------

export interface User {
  id: string
  email: string
  role: 'USER' | 'ADMIN'
}

export interface Plan {
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

export interface Subscription {
  id: string
  planId: string
  subUrl: string
  trafficUsed: number
  startAt: string
  expireAt: string
  status: 'ACTIVE' | 'EXPIRED' | 'CANCELLED'
  plan: Plan
}

type SubscriptionSnapshot = Pick<Subscription, 'status' | 'expireAt'>

export interface Node {
  id: string
  name: string
  protocol: string
  region: string
  isActive: boolean
  host?: string
  port?: number
}

export interface UsageData {
  trafficUsed: string | number
  trafficLimit: string | number
  baseTrafficLimit?: string | number
  bonusTrafficLimit?: string | number
  trafficRemaining: string | number
  percentUsed: number
  plan: { id: string; name: string; duration: number }
  entitlement?: {
    speedLimitMbps?: number | null
    maxDevices?: number | null
    accessTier?: string | null
    nodeTier?: string | null
    [key: string]: unknown
  }
  status: string
  expireAt: string
  startAt: string
}

export interface PublicBenefitStatus {
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

export interface PromoValidation {
  valid: boolean
  code: string
  discountType: 'PERCENT' | 'FIXED'
  discountValue: number
  discount: number
  originalPrice: number
  finalPrice: number
}

export interface PromoRedeemResult {
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

export type AnnouncementLevel = 'info' | 'success' | 'warning' | 'error'

export interface Announcement {
  id: string
  title: string
  body: string
  level?: AnnouncementLevel | string | null
  publishedAt?: string | null
  actionLabel?: string | null
  actionUrl?: string | null
}

export interface ApiKey {
  id: string
  name: string
  key: string
  createdAt: string
  lastUsedAt: string | null
  requestCount: number
}

export interface ApiKeyUsage {
  totalRequests: number
  totalTokens: number
  todayRequests: number
  todayCost: number
  models: Array<{ name: string; requests: number; tokens: number }>
}

export interface TrafficReportInput {
  nodeId: string
  bytes_up: number
  bytes_down: number
  timestamp: number
}

export interface TrafficReportResult {
  trafficUsed: string | number
  trafficLimit: string | number
  remaining: string | number
}

export interface ClientWebLoginTicketInput {
  attemptId: string
  state: string
  challenge: string
  pairingCode: string
  confirmed: true
  deviceName: string
}

export interface ClientWebLoginTicketResult {
  status: 'APPROVED' | string
}

export class ApiError extends Error {
  status: number
  code?: string

  constructor(message: string, status: number, code?: string) {
    super(message)
    this.name = 'ApiError'
    this.status = status
    this.code = code
  }
}

export function isTrafficExceededError(error: unknown): boolean {
  return error instanceof ApiError && error.code === 'TRAFFIC_EXCEEDED'
}

// Keep the announcement path centralized so deployments can override it if needed.
const ANNOUNCEMENT_LATEST_PATH =
  (import.meta.env['VITE_ANNOUNCEMENT_LATEST_PATH'] as string | undefined) ??
  '/announcements/latest'
const ANNOUNCEMENT_BROADCAST_LATEST_PATH =
  (import.meta.env['VITE_ANNOUNCEMENT_BROADCAST_LATEST_PATH'] as
    | string
    | undefined) ?? '/announcements/latest?channel=CLIENT&type=BROADCAST'
const ANNOUNCEMENT_UPDATE_LIST_PATH =
  (import.meta.env['VITE_ANNOUNCEMENT_UPDATE_LIST_PATH'] as
    | string
    | undefined) ?? '/announcements?channel=CLIENT&type=UPDATE'
const OFFICIAL_API_ORIGIN = 'https://api.xxlink.net'

function assertOfficialApiBaseUrl() {
  try {
    const url = new URL(BASE_URL)
    if (
      url.origin === OFFICIAL_API_ORIGIN &&
      url.pathname.replace(/\/+$/, '') === '/api/v1'
    ) {
      return
    }
  } catch {
    /* handled below */
  }

  throw new ApiError('网页登录只支持官方服务', 0, 'UNTRUSTED_API_HOST')
}

// ---------------------------------------------------------------------------
// Backend API response envelope
// ---------------------------------------------------------------------------

interface BackendResponse<T> {
  success: boolean
  data?: T
  error?: string | { message?: string; code?: string }
}

// ---------------------------------------------------------------------------
// Core request helper with auto-refresh
// ---------------------------------------------------------------------------

let isRefreshing = false
let refreshPromise: Promise<void> | null = null

const AUTH_FATAL_CODES = new Set([
  'ACCOUNT_DISABLED',
  'ACCOUNT_NOT_FOUND',
  'INVALID_REFRESH_TOKEN',
  'REFRESH_TOKEN_INVALID',
  'SESSION_REVOKED',
  'SESSION_EXPIRED',
  'ACCOUNT_BLOCKED',
  'USER_DELETED',
  'USER_DISABLED',
  'USER_NOT_FOUND',
])

const REFRESH_TERMINAL_CODES = new Set([
  'ACCOUNT_DISABLED',
  'ACCOUNT_NOT_FOUND',
  'ACCOUNT_BLOCKED',
  'INVALID_REFRESH_TOKEN',
  'REFRESH_TOKEN_INVALID',
  'SESSION_REVOKED',
  'SESSION_EXPIRED',
  'USER_DELETED',
  'USER_DISABLED',
  'USER_NOT_FOUND',
])

const getBackendError = <T>(json: BackendResponse<T> | null | undefined) => {
  const error = json?.error
  if (typeof error === 'string') {
    return { message: error, code: undefined }
  }
  return { message: error?.message, code: error?.code }
}

const isAuthFatalResponse = (
  status: number,
  code?: string,
  path?: string,
): boolean => {
  if (code && AUTH_FATAL_CODES.has(code)) return true

  const identityPath = path?.startsWith('/user/')

  return identityPath === true && (status === 403 || status === 404)
}

const isTerminalRefreshFailure = (status?: number, code?: string): boolean => {
  if (code && REFRESH_TERMINAL_CODES.has(code)) return true
  return false
}

export function isAuthFatalError(error: unknown): boolean {
  return (
    error instanceof ApiError && isAuthFatalResponse(error.status, error.code)
  )
}

function getAuthFatalMessage(code?: string): string {
  if (
    code === 'USER_NOT_FOUND' ||
    code === 'USER_DELETED' ||
    code === 'ACCOUNT_NOT_FOUND'
  ) {
    return '账号不存在或已失效，请重新登录'
  }
  if (code === 'USER_DISABLED' || code === 'ACCOUNT_DISABLED') {
    return '账号状态不可用，请联系客服'
  }
  return '登录状态已失效，请重新登录'
}

function handleAuthFatal(
  status: number,
  code?: string,
  message?: string,
): never {
  const friendlyMessage =
    getAuthFatalMessage(code) || message || '登录状态已失效，请重新登录'
  expireSession({ message: friendlyMessage, code, status })
  throw new ApiError(friendlyMessage, status, code || 'SESSION_EXPIRED')
}

async function request<T>(
  path: string,
  options: {
    method?: string
    body?: unknown
  } = {},
): Promise<T> {
  const doRequest = async (): Promise<Response> => {
    const state = authStore.getState()
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
    }
    if (state.accessToken) {
      headers['Authorization'] = `Bearer ${state.accessToken}`
    }

    return fetchWithTimeout(`${BASE_URL}${path}`, {
      method: options.method ?? 'GET',
      headers,
      body:
        options.body !== undefined ? JSON.stringify(options.body) : undefined,
    })
  }

  let res = await doRequest()

  // 401 → attempt token refresh once
  if (res.status === 401) {
    const state = authStore.getState()
    if (state.refreshToken) {
      if (!isRefreshing) {
        isRefreshing = true
        refreshPromise = apiRefreshToken(state.refreshToken)
          .then((tokens) => {
            // Update the singleton with new tokens; user stays the same
            if (state.user) {
              authStore.setAuth(
                state.user,
                tokens.accessToken,
                tokens.refreshToken,
              )
            }
          })
          .catch((error) => {
            if (
              error instanceof AuthError &&
              isTerminalRefreshFailure(error.status, error.code)
            ) {
              handleAuthFatal(
                error.status ?? 401,
                error.code || 'REFRESH_TOKEN_INVALID',
              )
            }
            throw error
          })
          .finally(() => {
            isRefreshing = false
            refreshPromise = null
          })
      }
      await refreshPromise
      if (!authStore.getState().accessToken) {
        handleAuthFatal(401, 'SESSION_EXPIRED')
      }
      // Retry the original request with the refreshed token
      res = await doRequest()
    } else {
      handleAuthFatal(401, 'AUTH_REQUIRED')
    }
  }

  let json: BackendResponse<T>
  try {
    json = (await res.json()) as BackendResponse<T>
  } catch {
    throw new Error(`Server returned non-JSON response (${res.status})`)
  }

  const { message, code } = getBackendError(json)

  if (!res.ok || !json.success) {
    if (isAuthFatalResponse(res.status, code, path)) {
      handleAuthFatal(res.status, code, message)
    }
    throw new ApiError(
      message ?? `Request failed (${res.status})`,
      res.status,
      code,
    )
  }

  if (!('data' in json)) {
    throw new ApiError(
      'Server response missing data',
      res.status,
      'MALFORMED_RESPONSE',
    )
  }

  return json.data as T
}

async function publicRequest<T>(path: string): Promise<T> {
  const res = await fetchWithTimeout(`${BASE_URL}${path}`, {
    method: 'GET',
    headers: {
      'Content-Type': 'application/json',
    },
  })

  let json: BackendResponse<T>
  try {
    json = (await res.json()) as BackendResponse<T>
  } catch {
    throw new Error(`Server returned non-JSON response (${res.status})`)
  }

  const { message, code } = getBackendError(json)

  if (!res.ok || !json.success) {
    throw new ApiError(
      message ?? `Request failed (${res.status})`,
      res.status,
      code,
    )
  }

  if (!('data' in json)) {
    throw new ApiError(
      'Server response missing data',
      res.status,
      'MALFORMED_RESPONSE',
    )
  }

  return json.data as T
}

// ---------------------------------------------------------------------------
// getSubUrl helper
// ---------------------------------------------------------------------------

export function getSubUrl(
  subUrl: string,
  format: 'clash' | 'singbox' | 'v2ray' = 'clash',
): string {
  try {
    const url = new URL(subUrl)
    url.searchParams.set('format', format)
    return url.toString()
  } catch {
    return `${BASE_URL}/subscription/${subUrl}?format=${format}`
  }
}

export function isSubscriptionActiveNow(
  sub: SubscriptionSnapshot | null | undefined,
): sub is SubscriptionSnapshot & { status: 'ACTIVE' } {
  if (!sub || sub.status !== 'ACTIVE') return false
  const expireAtMs = Date.parse(sub.expireAt)
  return Number.isFinite(expireAtMs) && expireAtMs > Date.now()
}

// ---------------------------------------------------------------------------
// API surface
// ---------------------------------------------------------------------------

export const api = {
  subscription: {
    current: () => request<Subscription | null>('/subscription/'),
    plans: () => request<Plan[]>('/subscription/plans'),
    purchase: (planId: string) =>
      request<Subscription>('/subscription/purchase', {
        method: 'POST',
        body: { planId },
      }),
  },

  user: {
    profile: () => request<User>('/user/profile'),
    usage: () => request<UsageData>('/user/usage'),
    publicBenefit: () => request<PublicBenefitStatus>('/user/public-benefit'),
    claimPublicBenefit: () =>
      request<PublicBenefitStatus>('/user/public-benefit/claim', {
        method: 'POST',
        body: {},
      }),
  },

  payment: {
    createCheckout: (planId: string, promoCode?: string) =>
      request<{ sessionUrl: string; sessionId: string }>('/payment/checkout', {
        method: 'POST',
        body: { planId, ...(promoCode ? { promoCode } : {}) },
      }),
  },

  promo: {
    validate: (code: string, planId: string) =>
      request<PromoValidation>('/promo/validate', {
        method: 'POST',
        body: { code, planId },
      }),
    redeemCode: (code: string) =>
      request<PromoRedeemResult>('/promo/redeem-traffic', {
        method: 'POST',
        body: { code },
      }),
  },

  nodes: {
    list: () => request<Node[]>('/nodes'),
  },

  traffic: {
    report: (body: TrafficReportInput) =>
      request<TrafficReportResult>('/traffic/report', {
        method: 'POST',
        body,
      }),
  },

  announcements: {
    latest: () => publicRequest<Announcement | null>(ANNOUNCEMENT_LATEST_PATH),
    latestBroadcast: () =>
      publicRequest<Announcement | null>(ANNOUNCEMENT_BROADCAST_LATEST_PATH),
    listUpdates: (limit = 20) => {
      const safeLimit = Math.max(1, Math.min(Math.floor(limit), 50))
      const separator = ANNOUNCEMENT_UPDATE_LIST_PATH.includes('?') ? '&' : '?'
      return publicRequest<Announcement[]>(
        `${ANNOUNCEMENT_UPDATE_LIST_PATH}${separator}limit=${safeLimit}`,
      )
    },
  },

  clientWebLogin: {
    approveTicket: (body: ClientWebLoginTicketInput) => {
      assertOfficialApiBaseUrl()
      return request<ClientWebLoginTicketResult>(
        '/auth/client-web-login/tickets',
        {
          method: 'POST',
          body,
        },
      )
    },
  },

  apiKeys: {
    list: () => request<ApiKey[]>('/api-keys'),
    create: (name: string) =>
      request<ApiKey>('/api-keys', { method: 'POST', body: { name } }),
    delete: (id: string) =>
      request<{ message: string }>(`/api-keys/${id}`, { method: 'DELETE' }),
    usage: () => request<ApiKeyUsage>('/api-keys/usage'),
  },
}

const getUserAgentPromise = once(async () => {
  try {
    const [name, version] = await Promise.all([getName(), getVersion()])
    return `${name}/${version}`
  } catch (error) {
    console.debug('Failed to build User-Agent, fallback to default', error)
    return 'xxlink-client'
  }
})
// Get current IP and geolocation information
interface IpInfo {
  ip: string
  country_code: string
  country: string
  region: string
  city: string
  organization: string
  asn: number
  asn_organization: string
  longitude: number
  latitude: number
  timezone: string
}

const IP_CHECK_URL = 'https://api.ip.sb/geoip'
const IP_CHECK_TIMEOUT = 5000

// 获取当前IP和地理位置信息
export const getIpInfo = async (): Promise<
  IpInfo & { lastFetchTs: number }
> => {
  const userAgent = await getUserAgentPromise()
  console.debug('User-Agent for IP detection:', userAgent)

  return asyncRetry(
    async (bail) => {
      debugLog(`尝试IP检测服务: ${IP_CHECK_URL}`)

      const timeoutController = new AbortController()
      const timeoutId = setTimeout(
        () => timeoutController.abort(),
        IP_CHECK_TIMEOUT,
      )

      try {
        const response = await fetchWithTimeout(
          IP_CHECK_URL,
          {
            method: 'GET',
            signal: timeoutController.signal,
            connectTimeout: IP_CHECK_TIMEOUT,
            headers: { 'User-Agent': userAgent },
          },
          IP_CHECK_TIMEOUT,
        )

        if (!response.ok) {
          return bail(new Error(`IP 检测服务出错，状态码: ${response.status}`))
        }

        let data: any
        try {
          data = await response.json()
        } catch {
          return bail(new Error('无法解析 JSON 响应'))
        }

        if (data && data.ip) {
          debugLog('IP检测成功')
          return {
            ip: data.ip || '',
            country_code: data.country_code || '',
            country: data.country || '',
            region: data.region || '',
            city: data.city || '',
            organization: data.organization || data.isp || '',
            asn: data.asn || 0,
            asn_organization: data.asn_organization || '',
            longitude: data.longitude || 0,
            latitude: data.latitude || 0,
            timezone: data.timezone || '',
            lastFetchTs: Date.now(),
          }
        } else {
          return bail(new Error('无效的响应格式'))
        }
      } finally {
        clearTimeout(timeoutId)
      }
    },
    {
      retries: 2,
      minTimeout: 1000,
      maxTimeout: 4000,
      randomize: true,
    },
  )
}
