import { ApiError } from '@/services/api'

export type SafeClientErrorKind = 'network' | 'auth' | 'service' | 'unknown'

type SafeClientErrorClassification = {
  kind: SafeClientErrorKind
  retryable: boolean
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
  if (error instanceof ApiError) {
    if (error.status === 401 || error.status === 403) {
      return { kind: 'auth', retryable: false }
    }
    if (error.status === 429 || error.status >= 500) {
      return { kind: 'service', retryable: true }
    }
    if (error.status >= 400 && error.status < 500) {
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

export function reportSafeClientFailure(scope: string, error: unknown): void {
  const { kind, retryable } = classifyClientError(error)
  console.warn({ scope, kind, retryable })
}
