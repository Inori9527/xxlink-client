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
const MAX_LOG_ITEMS = 200
const MAX_CLASSIFIABLE_TEXT_LENGTH = 1024
const MAX_DIAGNOSTIC_COUNT = 1_000_000

type Presence = 'present' | 'missing' | 'unknown'
type AuthStatus = 'authenticated' | 'anonymous' | 'unknown'
type AgeBucket =
  | 'future'
  | '<15m'
  | '<1h'
  | '<24h'
  | '<14d'
  | 'stale'
  | 'unknown'
type Platform = 'windows' | 'macos' | 'linux' | 'android' | 'ios' | 'unknown'
type ErrorFamily =
  | 'auth-session'
  | 'network'
  | 'profile-sync'
  | 'timeout'
  | 'storage'
  | 'other'
  | 'none'
  | 'unknown'
type RunningMode = 'rule' | 'global' | 'direct' | 'script' | 'unknown'
type SubscriptionStatus =
  | 'ACTIVE'
  | 'EXPIRED'
  | 'CANCELLED'
  | 'PENDING'
  | 'TRIAL'
  | 'unknown'
type EntitlementClass =
  | 'FREE'
  | 'PAID'
  | 'TRIAL'
  | 'admin-unlimited'
  | 'speed-limited'
  | 'unknown'
type LogLevel = 'debug' | 'info' | 'warn' | 'error' | 'unknown'
type DiagnosticEventCategory =
  | 'auth-session'
  | 'network'
  | 'profile-sync'
  | 'timeout'
  | 'storage'
  | 'structured-or-sensitive'
  | 'oversized'
  | 'other'
  | 'unrecognized'

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

interface DiagnosticLogSummary {
  source: 'runtime' | 'clash'
  componentCount: number
  totalCount: number
  inspectedCount: number
  omittedCount: number
  levels: Record<LogLevel, number>
  categories: Record<DiagnosticEventCategory, number>
}

export interface DiagnosticsBundle {
  schemaVersion: 1
  exportedAt: string
  app: {
    version: string
  }
  system: {
    platform: Platform
    uptimeMs: number | null
  }
  authSession: {
    status: AuthStatus
    accessToken: Presence
    refreshToken: Presence
    userRole: 'USER' | 'ADMIN' | 'unknown'
  }
  account: {
    lkgCache: 'present' | 'missing' | 'unknown'
    ageBucket: AgeBucket
    subscriptionStatus: SubscriptionStatus
    entitlementClass: EntitlementClass
    nodeCount: number | null
  }
  nodeSync: {
    status: 'ok-or-not-recorded' | 'error'
    lastErrorFamily: ErrorFamily
  }
  selectedNode: {
    status: 'selected' | 'not-selected'
  }
  profileGeneration: {
    status: 'present' | 'missing'
  }
  runtimeCore: {
    status: 'observed' | 'unknown'
    runningMode: RunningMode
  }
  dataPlane: {
    status: 'not-tested'
  }
  updater: {
    currentVersionClass: string
    lastCheckStatus: 'present' | 'unknown'
    lastCheckAgeBucket: AgeBucket
  }
  logs: {
    runtime: DiagnosticLogSummary
    clash: DiagnosticLogSummary
  }
  safety: {
    policy: 'metadata-only'
    rawTextIncluded: false
  }
}

const PRESENCE_VALUES = new Set(['present', 'missing', 'unknown'])
const AUTH_STATUS_VALUES = new Set(['authenticated', 'anonymous', 'unknown'])
const AGE_BUCKET_VALUES = new Set([
  'future',
  '<15m',
  '<1h',
  '<24h',
  '<14d',
  'stale',
  'unknown',
])
const PLATFORM_VALUES = new Set([
  'windows',
  'macos',
  'linux',
  'android',
  'ios',
  'unknown',
])
const ROLE_VALUES = new Set(['USER', 'ADMIN', 'unknown'])
const SUBSCRIPTION_STATUS_VALUES = new Set([
  'ACTIVE',
  'EXPIRED',
  'CANCELLED',
  'PENDING',
  'TRIAL',
  'unknown',
])
const ENTITLEMENT_CLASS_VALUES = new Set([
  'FREE',
  'PAID',
  'TRIAL',
  'admin-unlimited',
  'speed-limited',
  'unknown',
])
const ERROR_FAMILY_VALUES = new Set([
  'auth-session',
  'network',
  'profile-sync',
  'timeout',
  'storage',
  'other',
  'none',
  'unknown',
])
const RUNNING_MODE_VALUES = new Set([
  'rule',
  'global',
  'direct',
  'script',
  'unknown',
])
const LOG_LEVELS: LogLevel[] = ['debug', 'info', 'warn', 'error', 'unknown']
const EVENT_CATEGORIES: DiagnosticEventCategory[] = [
  'auth-session',
  'network',
  'profile-sync',
  'timeout',
  'storage',
  'structured-or-sensitive',
  'oversized',
  'other',
  'unrecognized',
]

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

function normalizeVersion(value: string | null | undefined): string {
  if (!value || value.length > 64) return 'unknown'
  return /^\d{1,4}(?:\.\d{1,4}){1,3}(?:[-+][0-9A-Za-z.-]{1,32})?$/.test(value)
    ? value
    : 'unknown'
}

function normalizePlatform(value: string | null | undefined): Platform {
  if (!value || value.length > MAX_CLASSIFIABLE_TEXT_LENGTH) return 'unknown'
  const normalized = value.toLowerCase()
  if (normalized.includes('windows')) return 'windows'
  if (normalized.includes('macos') || normalized.includes('darwin'))
    return 'macos'
  if (normalized.includes('android')) return 'android'
  if (normalized.includes('ios')) return 'ios'
  if (normalized.includes('linux')) return 'linux'
  return 'unknown'
}

function normalizeRunningMode(value: string | null | undefined): RunningMode {
  if (!value || value.length > 32) return 'unknown'
  const normalized = value.toLowerCase()
  return RUNNING_MODE_VALUES.has(normalized)
    ? (normalized as RunningMode)
    : 'unknown'
}

function normalizeSubscriptionStatus(
  value: string | null | undefined,
): SubscriptionStatus {
  if (!value || value.length > 32) return 'unknown'
  const normalized = value.toUpperCase()
  return SUBSCRIPTION_STATUS_VALUES.has(normalized)
    ? (normalized as SubscriptionStatus)
    : 'unknown'
}

function normalizeEntitlementClass(
  value: string | null | undefined,
): EntitlementClass {
  if (!value || value.length > 32) return 'unknown'
  if (value === 'admin-unlimited' || value === 'speed-limited') return value
  const normalized = value.toUpperCase()
  return ENTITLEMENT_CLASS_VALUES.has(normalized)
    ? (normalized as EntitlementClass)
    : 'unknown'
}

function boundedCount(value: number): number {
  if (!Number.isFinite(value) || value <= 0) return 0
  return Math.min(Math.floor(value), MAX_DIAGNOSTIC_COUNT)
}

function boundedOptionalCount(value: number | null | undefined): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    return null
  }
  return boundedCount(value)
}

function boundedUptime(value: number | null | undefined): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    return null
  }
  return Math.min(Math.floor(value), Number.MAX_SAFE_INTEGER)
}

function ageBucket(
  timestamp: number | null | undefined,
  nowMs: number,
): AgeBucket {
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

function parseTimestamp(value: string | null | undefined): number | null {
  if (!value || value.length > 16) return null
  for (const char of value) {
    if (char < '0' || char > '9') return null
  }
  const parsed = Number(value)
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null
}

function classifyDiagnosticText(value: unknown): DiagnosticEventCategory {
  if (typeof value !== 'string') return 'unrecognized'
  const trimmed = value.trim()
  if (!trimmed) return 'unrecognized'
  if (trimmed.length > MAX_CLASSIFIABLE_TEXT_LENGTH) return 'oversized'

  const text = trimmed.toLowerCase()
  if (
    text.includes('://') ||
    text.includes('authorization:') ||
    text.includes('cookie:') ||
    text.includes('password') ||
    text.includes('privatekey') ||
    text.includes('shortid') ||
    text.includes('uuid') ||
    text.includes('server:') ||
    text.startsWith('{') ||
    text.startsWith('[') ||
    text.startsWith('- ') ||
    text.includes('\n')
  ) {
    return 'structured-or-sensitive'
  }
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

function toErrorFamily(value: unknown): ErrorFamily {
  switch (classifyDiagnosticText(value)) {
    case 'auth-session':
    case 'network':
    case 'profile-sync':
    case 'timeout':
    case 'storage':
      return classifyDiagnosticText(value) as ErrorFamily
    case 'other':
    case 'structured-or-sensitive':
      return 'other'
    default:
      return 'unknown'
  }
}

function normalizeLogLevel(value: unknown): LogLevel {
  if (typeof value !== 'string' || value.length > 16) return 'unknown'
  const normalized = value.toLowerCase()
  if (normalized === 'warning') return 'warn'
  return LOG_LEVELS.includes(normalized as LogLevel)
    ? (normalized as LogLevel)
    : 'unknown'
}

function createLevelCounts(): Record<LogLevel, number> {
  return { debug: 0, info: 0, warn: 0, error: 0, unknown: 0 }
}

function createCategoryCounts(): Record<DiagnosticEventCategory, number> {
  return {
    'auth-session': 0,
    network: 0,
    'profile-sync': 0,
    timeout: 0,
    storage: 0,
    'structured-or-sensitive': 0,
    oversized: 0,
    other: 0,
    unrecognized: 0,
  }
}

function normalizeInspectionLimit(value: number | undefined): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return DEFAULT_MAX_LOG_ITEMS
  }
  return Math.min(Math.max(Math.floor(value), 0), MAX_LOG_ITEMS)
}

function summarizeEntries(
  source: 'runtime' | 'clash',
  componentCount: number,
  entries: Array<{ level: unknown; message: unknown }>,
  maxItems: number,
): DiagnosticLogSummary {
  const inspected = entries.slice(Math.max(0, entries.length - maxItems))
  const levels = createLevelCounts()
  const categories = createCategoryCounts()

  for (const entry of inspected) {
    levels[normalizeLogLevel(entry.level)]++
    categories[classifyDiagnosticText(entry.message)]++
  }

  return {
    source,
    componentCount: boundedCount(componentCount),
    totalCount: boundedCount(entries.length),
    inspectedCount: boundedCount(inspected.length),
    omittedCount: boundedCount(entries.length - inspected.length),
    levels,
    categories,
  }
}

function summarizeRuntimeLogs(
  logs: Record<string, Array<[unknown, unknown]>> | undefined,
  maxItems: number,
): DiagnosticLogSummary {
  const entries: Array<{ level: unknown; message: unknown }> = []
  let componentCount = 0

  for (const value of Object.values(logs ?? {})) {
    if (!Array.isArray(value)) continue
    componentCount++
    for (const entry of value) {
      if (Array.isArray(entry)) {
        entries.push({ level: entry[0], message: entry[1] })
      } else {
        entries.push({ level: 'unknown', message: entry })
      }
    }
  }

  return summarizeEntries('runtime', componentCount, entries, maxItems)
}

function summarizeClashLogs(
  logs: unknown[] | undefined,
  maxItems: number,
): DiagnosticLogSummary {
  const entries = (Array.isArray(logs) ? logs : []).map((entry) => {
    if (entry && typeof entry === 'object' && !Array.isArray(entry)) {
      const record = entry as Record<string, unknown>
      return { level: record.type, message: record.payload }
    }
    return { level: 'unknown', message: entry }
  })
  return summarizeEntries(
    'clash',
    entries.length > 0 ? 1 : 0,
    entries,
    maxItems,
  )
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
  const maxLogItems = normalizeInspectionLimit(options.maxLogItems)
  const auth = input.authState ?? {}
  const account = input.accountLkg
  const hasLastSyncError = Boolean(input.lastSyncErrorRaw)
  const lastUpdateTimestamp = parseTimestamp(input.lastUpdateCheckRaw)

  return {
    schemaVersion: DIAGNOSTICS_SCHEMA_VERSION,
    exportedAt: now.toISOString(),
    app: {
      version: normalizeVersion(input.appVersion ?? appVersion),
    },
    system: {
      platform: normalizePlatform(input.systemInfo),
      uptimeMs: boundedUptime(input.appUptimeMs),
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
      subscriptionStatus: normalizeSubscriptionStatus(
        account?.subscriptionStatus,
      ),
      entitlementClass: normalizeEntitlementClass(account?.entitlementClass),
      nodeCount: boundedOptionalCount(account?.nodeCount),
    },
    nodeSync: {
      status: hasLastSyncError ? 'error' : 'ok-or-not-recorded',
      lastErrorFamily: hasLastSyncError
        ? toErrorFamily(input.lastSyncErrorRaw)
        : 'none',
    },
    selectedNode: {
      status: input.selectedNodeRaw ? 'selected' : 'not-selected',
    },
    profileGeneration: {
      status: input.profileGenerationRaw ? 'present' : 'missing',
    },
    runtimeCore: {
      status: input.runningMode ? 'observed' : 'unknown',
      runningMode: normalizeRunningMode(input.runningMode),
    },
    dataPlane: {
      status: 'not-tested',
    },
    updater: {
      currentVersionClass: normalizeVersion(input.appVersion ?? appVersion),
      lastCheckStatus: lastUpdateTimestamp ? 'present' : 'unknown',
      lastCheckAgeBucket: ageBucket(lastUpdateTimestamp, nowMs),
    },
    logs: {
      runtime: summarizeRuntimeLogs(input.logs?.runtime, maxLogItems),
      clash: summarizeClashLogs(input.logs?.clash, maxLogItems),
    },
    safety: {
      policy: 'metadata-only',
      rawTextIncluded: false,
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function hasExactKeys(
  value: Record<string, unknown>,
  keys: readonly string[],
): boolean {
  const actual = Object.keys(value)
  return actual.length === keys.length && keys.every((key) => key in value)
}

function isSafeCount(value: unknown): value is number {
  return (
    typeof value === 'number' &&
    Number.isInteger(value) &&
    value >= 0 &&
    value <= MAX_DIAGNOSTIC_COUNT
  )
}

function isSafeOptionalNumber(value: unknown): boolean {
  return (
    value === null ||
    (typeof value === 'number' &&
      Number.isFinite(value) &&
      value >= 0 &&
      value <= Number.MAX_SAFE_INTEGER)
  )
}

function isSafeVersion(value: unknown): boolean {
  return typeof value === 'string' && normalizeVersion(value) === value
}

function isSafeIsoTimestamp(value: unknown): boolean {
  if (typeof value !== 'string') return false
  const parsed = Date.parse(value)
  return Number.isFinite(parsed) && new Date(parsed).toISOString() === value
}

function isSafeCountRecord(
  value: unknown,
  keys: readonly string[],
  expectedTotal: number,
): boolean {
  if (!isRecord(value) || !hasExactKeys(value, keys)) return false
  if (!keys.every((key) => isSafeCount(value[key]))) return false
  return (
    keys.reduce((total, key) => total + Number(value[key]), 0) === expectedTotal
  )
}

function isSafeLogSummary(
  value: unknown,
  expectedSource: 'runtime' | 'clash',
): boolean {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      'source',
      'componentCount',
      'totalCount',
      'inspectedCount',
      'omittedCount',
      'levels',
      'categories',
    ])
  ) {
    return false
  }
  if (
    value.source !== expectedSource ||
    !isSafeCount(value.componentCount) ||
    !isSafeCount(value.totalCount) ||
    !isSafeCount(value.inspectedCount) ||
    !isSafeCount(value.omittedCount) ||
    value.inspectedCount + value.omittedCount !== value.totalCount
  ) {
    return false
  }
  return (
    isSafeCountRecord(value.levels, LOG_LEVELS, value.inspectedCount) &&
    isSafeCountRecord(value.categories, EVENT_CATEGORIES, value.inspectedCount)
  )
}

function isSafeDiagnosticsBundle(value: unknown): value is DiagnosticsBundle {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      'schemaVersion',
      'exportedAt',
      'app',
      'system',
      'authSession',
      'account',
      'nodeSync',
      'selectedNode',
      'profileGeneration',
      'runtimeCore',
      'dataPlane',
      'updater',
      'logs',
      'safety',
    ]) ||
    value.schemaVersion !== 1 ||
    !isSafeIsoTimestamp(value.exportedAt)
  ) {
    return false
  }

  const app = value.app
  const system = value.system
  const auth = value.authSession
  const account = value.account
  const nodeSync = value.nodeSync
  const selectedNode = value.selectedNode
  const profileGeneration = value.profileGeneration
  const runtimeCore = value.runtimeCore
  const dataPlane = value.dataPlane
  const updater = value.updater
  const logs = value.logs
  const safety = value.safety

  return (
    isRecord(app) &&
    hasExactKeys(app, ['version']) &&
    isSafeVersion(app.version) &&
    isRecord(system) &&
    hasExactKeys(system, ['platform', 'uptimeMs']) &&
    PLATFORM_VALUES.has(String(system.platform)) &&
    isSafeOptionalNumber(system.uptimeMs) &&
    isRecord(auth) &&
    hasExactKeys(auth, ['status', 'accessToken', 'refreshToken', 'userRole']) &&
    AUTH_STATUS_VALUES.has(String(auth.status)) &&
    PRESENCE_VALUES.has(String(auth.accessToken)) &&
    PRESENCE_VALUES.has(String(auth.refreshToken)) &&
    ROLE_VALUES.has(String(auth.userRole)) &&
    isRecord(account) &&
    hasExactKeys(account, [
      'lkgCache',
      'ageBucket',
      'subscriptionStatus',
      'entitlementClass',
      'nodeCount',
    ]) &&
    PRESENCE_VALUES.has(String(account.lkgCache)) &&
    AGE_BUCKET_VALUES.has(String(account.ageBucket)) &&
    SUBSCRIPTION_STATUS_VALUES.has(String(account.subscriptionStatus)) &&
    ENTITLEMENT_CLASS_VALUES.has(String(account.entitlementClass)) &&
    (account.nodeCount === null || isSafeCount(account.nodeCount)) &&
    isRecord(nodeSync) &&
    hasExactKeys(nodeSync, ['status', 'lastErrorFamily']) &&
    (nodeSync.status === 'error' || nodeSync.status === 'ok-or-not-recorded') &&
    ERROR_FAMILY_VALUES.has(String(nodeSync.lastErrorFamily)) &&
    isRecord(selectedNode) &&
    hasExactKeys(selectedNode, ['status']) &&
    (selectedNode.status === 'selected' ||
      selectedNode.status === 'not-selected') &&
    isRecord(profileGeneration) &&
    hasExactKeys(profileGeneration, ['status']) &&
    (profileGeneration.status === 'present' ||
      profileGeneration.status === 'missing') &&
    isRecord(runtimeCore) &&
    hasExactKeys(runtimeCore, ['status', 'runningMode']) &&
    (runtimeCore.status === 'observed' || runtimeCore.status === 'unknown') &&
    RUNNING_MODE_VALUES.has(String(runtimeCore.runningMode)) &&
    isRecord(dataPlane) &&
    hasExactKeys(dataPlane, ['status']) &&
    dataPlane.status === 'not-tested' &&
    isRecord(updater) &&
    hasExactKeys(updater, [
      'currentVersionClass',
      'lastCheckStatus',
      'lastCheckAgeBucket',
    ]) &&
    isSafeVersion(updater.currentVersionClass) &&
    (updater.lastCheckStatus === 'present' ||
      updater.lastCheckStatus === 'unknown') &&
    AGE_BUCKET_VALUES.has(String(updater.lastCheckAgeBucket)) &&
    isRecord(logs) &&
    hasExactKeys(logs, ['runtime', 'clash']) &&
    isSafeLogSummary(logs.runtime, 'runtime') &&
    isSafeLogSummary(logs.clash, 'clash') &&
    isRecord(safety) &&
    hasExactKeys(safety, ['policy', 'rawTextIncluded']) &&
    safety.policy === 'metadata-only' &&
    safety.rawTextIncluded === false
  )
}

export function diagnosticsJsonHasForbiddenMaterial(json: string): boolean {
  try {
    return !isSafeDiagnosticsBundle(JSON.parse(json))
  } catch {
    return true
  }
}

export async function copyDiagnosticsBundleToClipboard(
  options: DiagnosticsBuildOptions = {},
): Promise<DiagnosticsBundle> {
  const bundle = await collectDiagnosticsBundle(options)
  const json = JSON.stringify(bundle, null, 2)

  await writeDiagnosticsJsonToClipboard(json, writeText)
  return bundle
}

export async function writeDiagnosticsJsonToClipboard(
  json: string,
  writer: (text: string) => Promise<void>,
): Promise<void> {
  let parsed: unknown
  try {
    parsed = JSON.parse(json)
  } catch {
    throw new Error('Diagnostics bundle contains forbidden material')
  }

  if (!isSafeDiagnosticsBundle(parsed)) {
    throw new Error('Diagnostics bundle contains forbidden material')
  }

  await writer(JSON.stringify(parsed, null, 2))
}
