import { writeText } from '@tauri-apps/plugin-clipboard-manager'

import { readAccountLkgCache } from '@/services/account-lkg-cache'
import { authStore } from '@/services/auth-store'
import {
  getAppUptime,
  getClashLogs,
  getRunningMode,
  getRuntimeLogs,
  getSystemInfo,
} from '@/services/cmds'
import { version as appVersion } from '@root/package.json'

const DIAGNOSTICS_SCHEMA_VERSION = 1
const DEFAULT_MAX_LOG_ITEMS = 50

type Presence = 'present' | 'missing' | 'unknown'
type AuthStatus = 'authenticated' | 'anonymous' | 'unknown'
type DiagnosticStatus =
  | 'fresh'
  | 'stale'
  | 'present'
  | 'missing'
  | 'selected'
  | 'not-selected'
  | 'ok-or-not-recorded'
  | 'error'
  | 'observed'
  | 'not-tested'
  | 'unknown'

type ErrorFamily =
  | 'auth-session'
  | 'network'
  | 'profile-sync'
  | 'timeout'
  | 'storage'
  | 'other'
  | 'none'
  | 'unknown'

interface DiagnosticsAuthInput {
  isAuthenticated?: boolean
  hasAccessToken?: boolean
  hasRefreshToken?: boolean
  userRole?: string | null
}

interface DiagnosticsAccountInput {
  present?: boolean
  updatedAt?: number | null
  subscriptionStatus?: string | null
  nodeCount?: number | null
  entitlementClass?: string | null
}

interface DiagnosticsLogInput {
  runtime?: Record<string, Array<[unknown, unknown]>>
  clash?: unknown[]
}

export interface DiagnosticsBundleInput {
  appVersion?: string
  systemInfo?: string | null
  appUptimeMs?: number | null
  runningMode?: string | null
  authState?: DiagnosticsAuthInput
  accountLkg?: DiagnosticsAccountInput | null
  selectedNodeRaw?: string | null
  profileGenerationRaw?: string | null
  lastSyncErrorRaw?: string | null
  lastUpdateCheckRaw?: string | null
  logs?: DiagnosticsLogInput
}

export interface DiagnosticsBuildOptions {
  now?: () => Date
  maxLogItems?: number
}

export interface DiagnosticsBundle {
  schemaVersion: 1
  exportedAt: string
  app: {
    version: string
  }
  system: {
    info: string
    uptimeMs: number | null
  }
  authSession: {
    status: AuthStatus
    accessToken: Presence
    refreshToken: Presence
    userRole: 'USER' | 'ADMIN' | 'unknown'
  }
  account: {
    lkgCache: DiagnosticStatus
    ageBucket: string
    subscriptionStatus: string
    entitlementClass: string
    nodeCount: number | null
  }
  nodeSync: {
    status: DiagnosticStatus
    lastErrorFamily: ErrorFamily
    lastErrorClass: string
  }
  selectedNode: {
    status: DiagnosticStatus
  }
  profileGeneration: {
    status: DiagnosticStatus
  }
  runtimeCore: {
    status: DiagnosticStatus
    runningMode: string
  }
  dataPlane: {
    status: 'not-tested'
    note: string
  }
  updater: {
    currentVersionClass: string
    lastCheckStatus: DiagnosticStatus
    lastCheckAgeBucket: string
  }
  logs: {
    runtime: Record<string, Array<[string, string]>>
    clash: Array<Record<string, string>>
  }
  redaction: {
    policy: string
    forbiddenFields: string[]
  }
}

const REDACTION_MARKER = '[REDACTED]'

const FORBIDDEN_FIELDS = [
  'access token',
  'refresh token',
  'cookies',
  'auth headers',
  'subscription URL',
  'raw profile URL',
  'UUID/shortId/private key material',
  'server credentials',
  'env values',
  'signing material',
  'email/payment PII',
]

const SENSITIVE_KEY_PATTERN =
  /(^|[_-])(access|refresh)?token$|authorization|cookie|set-cookie|sub(url|scription)|private.?key|short.?id|uuid|password|secret|credential|email|payment|raw/i

const UUID_PATTERN =
  /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi

const EMAIL_PATTERN = /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi

const PROFILE_URL_PATTERN =
  /\b(?:vless|vmess|trojan|ssr?|hysteria2?|tuic):\/\/[^\s"'<>]+/gi

const SUBSCRIPTION_URL_PATTERN =
  /https?:\/\/[^\s"'<>]+\/subscription\/[^\s"'<>]+/gi

const HTTP_CREDENTIAL_URL_PATTERN = /(https?:\/\/)[^/\s:@"'<>]+:[^@/\s"'<>]+@/gi

const QUERY_CREDENTIAL_PATTERN =
  /([?&](?:access_?token|refresh_?token|token|auth|authorization|api_?key|password|passwd|secret|credential|session|sid)=)[^&#\s"'<>]+/gi

const FORBIDDEN_QUERY_CREDENTIAL_PATTERN =
  /[?&](?:access_?token|refresh_?token|token|auth|authorization|api_?key|password|passwd|secret|credential|session|sid)=(?!\[REDACTED\])[^&#\s"'<>]+/i

const PROFILE_BLOCK_PATTERN =
  /(?:^|\n)\s*(?:proxies|proxy-groups|proxy-providers|rule-providers|inbounds|outbounds|wireguard|mixed-port|socks-port|redir-port|tproxy-port|allow-lan|external-controller|external-ui|dns|tun|rules)\s*:|["'](?:proxies|proxy-groups|proxy-providers|rule-providers|inbounds|outbounds|wireguard|mixed-port|socks-port|redir-port|tproxy-port|allow-lan|external-controller|external-ui|dns|tun|rules)["']\s*:/i

const KEY_VALUE_SECRET_PATTERN =
  /\b(accessToken|refreshToken|token|authorization|cookie|privateKey|shortId|uuid|password|secret|credential|server|sni)\s*[:=]\s*["']?[^"',\s;}]+/gi

const QUOTED_KEY_VALUE_SECRET_PATTERN =
  /(["'](?:accessToken|refreshToken|token|authorization|cookie|privateKey|shortId|uuid|password|secret|credential|server|sni)["']\s*:\s*)["'][^"']*["']/gi

const AUTH_HEADER_PATTERN = /\bAuthorization\s*:\s*Bearer\s+[^\s"',;}]+/gi
const BEARER_PATTERN = /\bBearer\s+[A-Za-z0-9._~+/=-]+/gi
const COOKIE_HEADER_PATTERN = /\b(Set-)?Cookie\s*:\s*[^\n\r]+/gi

const FORBIDDEN_OUTPUT_PATTERNS = [
  AUTH_HEADER_PATTERN,
  BEARER_PATTERN,
  COOKIE_HEADER_PATTERN,
  HTTP_CREDENTIAL_URL_PATTERN,
  FORBIDDEN_QUERY_CREDENTIAL_PATTERN,
  PROFILE_BLOCK_PATTERN,
  SUBSCRIPTION_URL_PATTERN,
  PROFILE_URL_PATTERN,
  UUID_PATTERN,
  EMAIL_PATTERN,
  /\b(privateKey|shortId|password|secret)\s*[:=]\s*(?!\[REDACTED\])[^"',\s;}]+/i,
  /["'](?:accessToken|refreshToken)["']\s*:\s*["'](?!(?:present|missing|unknown|\[REDACTED\])["'])[^"']+/i,
  /["'](?:token|authorization|cookie|privateKey|shortId|uuid|password|secret|credential|server|sni)["']\s*:\s*["'](?!\[REDACTED\])[^"']+/i,
]

export function redactText(value: string): string {
  PROFILE_BLOCK_PATTERN.lastIndex = 0
  if (PROFILE_BLOCK_PATTERN.test(value)) {
    return '[REDACTED_PROFILE_BLOCK]'
  }

  return value
    .replace(HTTP_CREDENTIAL_URL_PATTERN, '$1[REDACTED_CREDENTIALS]@')
    .replace(QUERY_CREDENTIAL_PATTERN, '$1[REDACTED]')
    .replace(SUBSCRIPTION_URL_PATTERN, '[REDACTED_SUBSCRIPTION_URL]')
    .replace(PROFILE_URL_PATTERN, '[REDACTED_PROFILE_URL]')
    .replace(AUTH_HEADER_PATTERN, `Authorization: Bearer ${REDACTION_MARKER}`)
    .replace(COOKIE_HEADER_PATTERN, (match) => {
      const header = match.toLowerCase().startsWith('set-cookie')
        ? 'Set-Cookie'
        : 'Cookie'
      return `${header}: ${REDACTION_MARKER}`
    })
    .replace(BEARER_PATTERN, `Bearer ${REDACTION_MARKER}`)
    .replace(KEY_VALUE_SECRET_PATTERN, (_match, key: string) => {
      return `${key}=${REDACTION_MARKER}`
    })
    .replace(QUOTED_KEY_VALUE_SECRET_PATTERN, `$1"${REDACTION_MARKER}"`)
    .replace(UUID_PATTERN, '[REDACTED_UUID]')
    .replace(EMAIL_PATTERN, '[REDACTED_EMAIL]')
}

export function redactDiagnosticsValue(
  value: unknown,
  seen = new WeakSet<object>(),
): unknown {
  if (typeof value === 'string') return redactText(value)
  if (typeof value !== 'object' || value === null) return value

  if (seen.has(value)) return '[Circular]'
  seen.add(value)

  if (Array.isArray(value)) {
    return value.map((item) => redactDiagnosticsValue(item, seen))
  }

  const output: Record<string, unknown> = {}
  for (const [key, item] of Object.entries(value)) {
    if (SENSITIVE_KEY_PATTERN.test(key)) {
      output[key] = REDACTION_MARKER
    } else {
      output[key] = redactDiagnosticsValue(item, seen)
    }
  }
  return output
}

export function diagnosticsJsonHasForbiddenMaterial(json: string): boolean {
  return FORBIDDEN_OUTPUT_PATTERNS.some((pattern) => {
    pattern.lastIndex = 0
    return pattern.test(json)
  })
}

function toPresence(value: boolean | undefined): Presence {
  if (value === true) return 'present'
  if (value === false) return 'missing'
  return 'unknown'
}

function normalizeRole(
  role: string | null | undefined,
): 'USER' | 'ADMIN' | 'unknown' {
  return role === 'USER' || role === 'ADMIN' ? role : 'unknown'
}

function normalizeClass(value: string | null | undefined): string {
  if (!value) return 'unknown'
  return redactText(value).slice(0, 80)
}

function parseMaybeJson(value: string | null | undefined): unknown {
  if (!value) return null
  try {
    return JSON.parse(value)
  } catch {
    return value
  }
}

function ageBucket(
  timestamp: number | null | undefined,
  nowMs: number,
): string {
  if (!timestamp || !Number.isFinite(timestamp)) return 'unknown'
  const ageMs = nowMs - timestamp
  if (ageMs < 0) return 'future'
  const minute = 60 * 1000
  const hour = 60 * minute
  const day = 24 * hour
  if (ageMs < 15 * minute) return '<15m'
  if (ageMs < hour) return '<1h'
  if (ageMs < day) return '<24h'
  if (ageMs < 14 * day) return '<14d'
  return 'stale'
}

function classifyErrorFamily(value: unknown): ErrorFamily {
  if (!value) return 'none'
  const text = JSON.stringify(redactDiagnosticsValue(value)).toLowerCase()
  if (text.includes('timeout') || text.includes('timed out')) return 'timeout'
  if (
    text.includes('auth') ||
    text.includes('session') ||
    text.includes('csrf') ||
    text.includes('token')
  ) {
    return 'auth-session'
  }
  if (
    text.includes('network') ||
    text.includes('offline') ||
    text.includes('fetch') ||
    text.includes('connection')
  ) {
    return 'network'
  }
  if (
    text.includes('profile') ||
    text.includes('subscription') ||
    text.includes('sync')
  ) {
    return 'profile-sync'
  }
  if (text.includes('storage') || text.includes('localstorage'))
    return 'storage'
  return 'other'
}

function classifyLastSyncError(raw: string | null | undefined): {
  status: DiagnosticStatus
  family: ErrorFamily
  errorClass: string
} {
  if (!raw) {
    return {
      status: 'ok-or-not-recorded',
      family: 'none',
      errorClass: 'none',
    }
  }

  const parsed = parseMaybeJson(raw)
  const family = classifyErrorFamily(parsed)
  let errorClass: string = family

  if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
    const record = parsed as Record<string, unknown>
    if (typeof record.code === 'string') {
      errorClass = normalizeClass(record.code)
    } else if (typeof record.name === 'string') {
      errorClass = normalizeClass(record.name)
    }
  }

  return { status: 'error', family, errorClass }
}

function tailArray<T>(items: T[] | undefined, maxItems: number): T[] {
  if (!items?.length) return []
  return items.slice(Math.max(0, items.length - maxItems))
}

function sanitizeRuntimeLogs(
  logs: Record<string, Array<[unknown, unknown]>> | undefined,
  maxItems: number,
): Record<string, Array<[string, string]>> {
  const output: Record<string, Array<[string, string]>> = {}
  for (const [scope, entries] of Object.entries(logs ?? {})) {
    output[redactText(scope)] = tailArray(entries, maxItems).map(
      ([level, message]) => [
        redactText(String(level ?? 'unknown')),
        redactText(String(message ?? '')),
      ],
    )
  }
  return output
}

function sanitizeClashLogs(
  logs: unknown[] | undefined,
  maxItems: number,
): Array<Record<string, string>> {
  return tailArray(logs ?? [], maxItems).map((entry) => {
    if (entry && typeof entry === 'object' && !Array.isArray(entry)) {
      const record = entry as Record<string, unknown>
      return {
        time: redactText(String(record.time ?? '')),
        type: redactText(String(record.type ?? 'unknown')),
        payload: redactText(String(record.payload ?? '')),
      }
    }
    return {
      time: '',
      type: 'unknown',
      payload: redactText(String(entry ?? '')),
    }
  })
}

function readStorageItem(key: string): string | null {
  try {
    return globalThis.localStorage?.getItem(key) ?? null
  } catch {
    return null
  }
}

function buildAuthStateInput(): DiagnosticsAuthInput {
  try {
    const state = authStore.getState()
    return {
      isAuthenticated: state.isAuthenticated,
      hasAccessToken: Boolean(state.accessToken),
      hasRefreshToken: Boolean(state.refreshToken),
      userRole: state.user?.role ?? null,
    }
  } catch {
    return {}
  }
}

function buildAccountLkgInput(): DiagnosticsAccountInput | null {
  try {
    const state = authStore.getState()
    const cache = readAccountLkgCache(state.user?.id)
    if (!cache) return { present: false }

    const entitlement = cache.usage?.entitlement
    return {
      present: true,
      updatedAt: cache.updatedAt,
      subscriptionStatus:
        cache.subscription?.status ?? cache.usage?.status ?? null,
      nodeCount: cache.nodes.length,
      entitlementClass:
        entitlement?.accessTier ??
        entitlement?.nodeTier ??
        (entitlement?.speedLimitMbps ? 'speed-limited' : null),
    }
  } catch {
    return null
  }
}

async function collectWithFallback<T>(
  task: () => Promise<T>,
  fallback: T,
): Promise<T> {
  try {
    return await task()
  } catch {
    return fallback
  }
}

export function buildDiagnosticsBundle(
  input: DiagnosticsBundleInput = {},
  options: DiagnosticsBuildOptions = {},
): DiagnosticsBundle {
  const now = options.now?.() ?? new Date()
  const nowMs = now.getTime()
  const maxLogItems = options.maxLogItems ?? DEFAULT_MAX_LOG_ITEMS
  const auth = input.authState ?? {}
  const account = input.accountLkg
  const lastSync = classifyLastSyncError(input.lastSyncErrorRaw)
  const hasSelectedNode = Boolean(input.selectedNodeRaw)
  const hasProfileGeneration = Boolean(input.profileGenerationRaw)
  const lastUpdateRaw = input.lastUpdateCheckRaw
  const lastUpdateTimestamp =
    lastUpdateRaw && /^\d+$/.test(lastUpdateRaw) ? Number(lastUpdateRaw) : null

  return {
    schemaVersion: DIAGNOSTICS_SCHEMA_VERSION,
    exportedAt: now.toISOString(),
    app: {
      version: normalizeClass(input.appVersion ?? appVersion),
    },
    system: {
      info: redactText(input.systemInfo ?? 'unavailable'),
      uptimeMs:
        typeof input.appUptimeMs === 'number' &&
        Number.isFinite(input.appUptimeMs)
          ? input.appUptimeMs
          : null,
    },
    authSession: {
      status:
        auth.isAuthenticated === true
          ? 'authenticated'
          : auth.isAuthenticated === false
            ? 'anonymous'
            : 'unknown',
      accessToken: toPresence(auth.hasAccessToken),
      refreshToken: toPresence(auth.hasRefreshToken),
      userRole: normalizeRole(auth.userRole),
    },
    account: {
      lkgCache:
        account?.present === true
          ? 'present'
          : account?.present === false
            ? 'missing'
            : 'unknown',
      ageBucket: ageBucket(account?.updatedAt, nowMs),
      subscriptionStatus: normalizeClass(account?.subscriptionStatus),
      entitlementClass: normalizeClass(account?.entitlementClass),
      nodeCount:
        typeof account?.nodeCount === 'number' &&
        Number.isFinite(account.nodeCount)
          ? account.nodeCount
          : null,
    },
    nodeSync: {
      status: lastSync.status,
      lastErrorFamily: lastSync.family,
      lastErrorClass: lastSync.errorClass,
    },
    selectedNode: {
      status: hasSelectedNode ? 'selected' : 'not-selected',
    },
    profileGeneration: {
      status: hasProfileGeneration ? 'present' : 'missing',
    },
    runtimeCore: {
      status: input.runningMode ? 'observed' : 'unknown',
      runningMode: normalizeClass(input.runningMode),
    },
    dataPlane: {
      status: 'not-tested',
      note: 'Diagnostics MVP does not run network probes or change connection state.',
    },
    updater: {
      currentVersionClass: normalizeClass(input.appVersion ?? appVersion),
      lastCheckStatus: lastUpdateTimestamp ? 'present' : 'unknown',
      lastCheckAgeBucket: ageBucket(lastUpdateTimestamp, nowMs),
    },
    logs: {
      runtime: sanitizeRuntimeLogs(input.logs?.runtime, maxLogItems),
      clash: sanitizeClashLogs(input.logs?.clash, maxLogItems),
    },
    redaction: {
      policy:
        'Collect class/status and tail log samples only; raw credentials, profiles, tokens, and PII are redacted.',
      forbiddenFields: FORBIDDEN_FIELDS,
    },
  }
}

export async function collectDiagnosticsBundle(
  options: DiagnosticsBuildOptions = {},
): Promise<DiagnosticsBundle> {
  const [systemInfo, appUptimeMs, runningMode, runtimeLogs, clashLogs] =
    await Promise.all([
      collectWithFallback(getSystemInfo, 'unavailable'),
      collectWithFallback(getAppUptime, null),
      collectWithFallback(getRunningMode, null),
      collectWithFallback(getRuntimeLogs, {}),
      collectWithFallback(getClashLogs, []),
    ])

  return buildDiagnosticsBundle(
    {
      appVersion,
      systemInfo,
      appUptimeMs,
      runningMode,
      authState: buildAuthStateInput(),
      accountLkg: buildAccountLkgInput(),
      selectedNodeRaw: readStorageItem('clash-verge-selected-proxy'),
      profileGenerationRaw: readStorageItem(
        'xxlink:subscription-profile-generation',
      ),
      lastSyncErrorRaw: readStorageItem('xxlink:last-sync-error'),
      lastUpdateCheckRaw: readStorageItem('last_check_update'),
      logs: {
        runtime: runtimeLogs,
        clash: clashLogs,
      },
    },
    options,
  )
}

export async function copyDiagnosticsBundleToClipboard(
  options: DiagnosticsBuildOptions = {},
): Promise<DiagnosticsBundle> {
  const bundle = await collectDiagnosticsBundle(options)
  const json = JSON.stringify(bundle, null, 2)

  if (diagnosticsJsonHasForbiddenMaterial(json)) {
    throw new Error('Diagnostics bundle failed redaction validation')
  }

  await writeText(json)
  return bundle
}
