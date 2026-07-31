import { ApiError } from '@/services/api'
import { BackendControllerError } from '@/services/backend-controller'

export type SafeClientErrorKind = 'network' | 'auth' | 'service' | 'unknown'

export const SAFE_CLIENT_FAILURE_SCOPES = [
  'admin-check',
  'app-bootstrap',
  'app-data-clash-refresh',
  'app-data-cleanup',
  'app-data-event-listeners',
  'app-data-immediate-cleanup',
  'app-data-proxy-refresh',
  'app-init-backend-notify',
  'app-init-timer-cleanup',
  'app-initialization',
  'auto-launch-read',
  'auto-proxy-read',
  'base-error-copy',
  'connect-mode-change',
  'connect-mode-rollback',
  'connect-proxy-control',
  'connect-proxy-selection',
  'connect-readiness-auto-disconnect',
  'connect-refresh',
  'connect-toggle',
  'connect-traffic-exceeded-disconnect',
  'connect-traffic-heartbeat',
  'data-validation-api',
  'delay-batch-check',
  'delay-group-listener',
  'delay-item-listener',
  'delay-test',
  'editor-document-load',
  'fallback-language-init',
  'global-window-error',
  'i18n-cache-language',
  'i18n-load-language',
  'i18n-read-language',
  'i18n-switch-language',
  'layout-event-cleanup',
  'layout-event-registration',
  'layout-notice-error',
  'layout-notice-handler',
  'layout-notice-unhandled',
  'listener-cleanup',
  'loading-overlay-remove',
  'login-submit',
  'login-subscription-sync',
  'mine-copy-diagnostics',
  'mine-manual-logout',
  'nodes-proxy-selection',
  'notice-copy',
  'plans-claim-public-benefit',
  'preload-config',
  'preload-language',
  'promo-redeem',
  'promo-sync',
  'proxy-selection-change',
  'proxy-selection-cleanup',
  'proxy-selection-fallback',
  'proxy-selection-persist',
  'proxy-selection-tray-sync',
  'register-submit',
  'resume-recovery',
  'service-availability-check',
  'service-install',
  'service-restart-after-install',
  'service-restart-after-uninstall',
  'service-stop-before-uninstall',
  'service-uninstall',
  'startup-timeout',
  'startup-timeout-copy',
  'subscription-auto-sync',
  'subscription-sync',
  'subscription-sync-node-generation',
  'subscription-sync-rebuild-delete',
  'sysproxy-hostname',
  'sysproxy-network-interfaces',
  'sysproxy-port-refresh',
  'sysproxy-save',
  'sysproxy-settings-refresh',
  'sysproxy-state-refresh',
  'system-tun-disable',
  'theme-create',
  'theme-window-set',
  'traffic-error-boundary',
  'traffic-diagnostics',
  'traffic-worker-initialize',
  'traffic-worker-runtime',
  'tun-profile-enhance',
  'tun-reset',
  'tun-save',
  'tun-settings-refresh',
  'unhandled-rejection',
  'update-install',
  'update-stale-close',
  'window-listener-cleanup',
] as const

export type SafeClientFailureScope = (typeof SAFE_CLIENT_FAILURE_SCOPES)[number]

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

const SAFE_SCOPE_SET = new Set<string>(SAFE_CLIENT_FAILURE_SCOPES)

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
  if (error instanceof BackendControllerError) {
    if (error.kind === 'network') return { kind: 'network', retryable: true }
    if (error.kind === 'auth') return { kind: 'auth', retryable: false }
    if (error.kind === 'service_blocked') {
      return { kind: 'service', retryable: false }
    }
    if (error.kind === 'invalid_response') {
      return { kind: 'service', retryable: false }
    }
    if (error.kind === 'traffic_exceeded') {
      return { kind: 'service', retryable: false }
    }
    return { kind: 'unknown', retryable: false }
  }

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
  const stableScope = SAFE_SCOPE_SET.has(scope) ? scope : 'client-failure'
  return { scope: stableScope, ...classifyClientError(error) }
}

export function reportSafeClientFailure(
  scope: SafeClientFailureScope,
  error: unknown,
): void {
  console.warn(toSafeClientFailureRecord(scope, error))
}

export async function writeSafeClientFailureToClipboard(
  scope: SafeClientFailureScope,
  error: unknown,
  writeText: (text: string) => Promise<void>,
): Promise<void> {
  await writeText(
    JSON.stringify(toSafeClientFailureRecord(scope, error), null, 2),
  )
}

export function handleGlobalErrorEvent(
  event: Pick<ErrorEvent, 'error' | 'preventDefault'>,
): void {
  event.preventDefault()
  reportSafeClientFailure('global-window-error', event.error)
}

export function handleGlobalPromiseRejection(
  event: Pick<PromiseRejectionEvent, 'reason' | 'preventDefault'>,
): void {
  event.preventDefault()
  reportSafeClientFailure('unhandled-rejection', event.reason)
}
