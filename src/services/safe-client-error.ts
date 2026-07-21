import { ApiError } from '@/services/api'

export type SafeClientErrorKind = 'network' | 'auth' | 'service' | 'unknown'

type SafeClientErrorClassification = {
  kind: SafeClientErrorKind
  retryable: boolean
}

export type SafeClientFailureRecord = SafeClientErrorClassification & {
  scope: string
}

type Translate = (key: string) => string

const TRANSPORT_CODES = new Set([
  'ECONNABORTED',
  'ECONNREFUSED',
  'ECONNRESET',
  'EHOSTUNREACH',
  'ENETUNREACH',
  'ETIMEDOUT',
  'ERR_CONNECTION_REFUSED',
  'ERR_CONNECTION_RESET',
  'ERR_INTERNET_DISCONNECTED',
  'ERR_NETWORK',
  'NETWORK_TIMEOUT',
])

const TRANSPORT_NAMES = new Set(['AbortError', 'NetworkError', 'TimeoutError'])

const TRANSPORT_MESSAGE_MARKERS = [
  'connection refused',
  'connection reset',
  'failed to fetch',
  'network error',
  'network request failed',
  'timed out',
  'timeout',
]

const SAFE_MESSAGE_KEYS: Record<SafeClientErrorKind, string> = {
  network: 'shared.feedback.errors.safeClient.network',
  auth: 'shared.feedback.errors.safeClient.auth',
  service: 'shared.feedback.errors.safeClient.service',
  unknown: 'shared.feedback.errors.safeClient.unknown',
}

function readStringProperty(error: unknown, key: string): string | undefined {
  if ((typeof error !== 'object' && typeof error !== 'function') || !error) {
    return undefined
  }

  try {
    const value = (error as Record<string, unknown>)[key]
    return typeof value === 'string' ? value : undefined
  } catch {
    return undefined
  }
}

function readNumberProperty(error: unknown, key: string): number | undefined {
  if ((typeof error !== 'object' && typeof error !== 'function') || !error) {
    return undefined
  }

  try {
    const value = (error as Record<string, unknown>)[key]
    return typeof value === 'number' && Number.isFinite(value)
      ? value
      : undefined
  } catch {
    return undefined
  }
}

function isTransportFailure(error: unknown): boolean {
  const name = readStringProperty(error, 'name')
  if (name && TRANSPORT_NAMES.has(name)) return true

  const code = readStringProperty(error, 'code')?.toUpperCase()
  if (code && TRANSPORT_CODES.has(code)) return true

  const message = readStringProperty(error, 'message')?.toLowerCase()
  return (
    !!message &&
    TRANSPORT_MESSAGE_MARKERS.some((marker) => message.includes(marker))
  )
}

export function classifyClientError(
  error: unknown,
): SafeClientErrorClassification {
  const status =
    error instanceof ApiError
      ? error.status
      : readNumberProperty(error, 'status')
  if (status !== undefined) {
    if (status === 401 || status === 403) {
      return { kind: 'auth', retryable: false }
    }
    if (status === 429 || status >= 500) {
      return { kind: 'service', retryable: true }
    }
    if (status >= 400 && status < 500) {
      return { kind: 'service', retryable: false }
    }
  }

  if (isTransportFailure(error)) {
    return { kind: 'network', retryable: true }
  }

  return { kind: 'unknown', retryable: false }
}

export function toSafeClientErrorMessage(
  kind: SafeClientErrorKind,
  t: Translate,
): string {
  return t(SAFE_MESSAGE_KEYS[kind])
}

export function toSafeClientFailureRecord(
  scope: string,
  error: unknown,
): SafeClientFailureRecord {
  const stableScope =
    scope.length <= 64 && /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/.test(scope)
      ? scope.slice(0, 64)
      : 'client-failure'
  return { scope: stableScope, ...classifyClientError(error) }
}

export function reportSafeClientFailure(scope: string, error: unknown): void {
  console.warn(toSafeClientFailureRecord(scope, error))
}
