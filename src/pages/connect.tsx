import {
  ChevronRightRounded,
  PowerSettingsNewRounded,
  RefreshRounded,
} from '@mui/icons-material'
import {
  Alert,
  Box,
  Button,
  ButtonBase,
  CircularProgress,
  IconButton,
  Paper,
  Stack,
  Tooltip,
  Typography,
  alpha,
  keyframes,
  useTheme,
} from '@mui/material'
import { open } from '@tauri-apps/plugin-shell'
import { useLockFn } from 'ahooks'
import {
  useCallback,
  useEffect,
  useMemo,
  useReducer,
  useRef,
  useState,
} from 'react'
import { useTranslation } from 'react-i18next'
import { useNavigate } from 'react-router'

import { BasePage } from '@/components/base'
import { RegionSheet } from '@/components/connect/region-sheet'
import { useConnectModeControl } from '@/hooks/use-connect-mode-control'
import {
  getNodeRouteLabel,
  getRegionFlag,
  getRegionName,
  useNodeCatalog,
} from '@/hooks/use-node-catalog'
import { useTrafficData } from '@/hooks/use-traffic-data'
import { useVerge } from '@/hooks/use-verge'
import { useVisibility } from '@/hooks/use-visibility'
import { designTokens, modeTokens } from '@/pages/_theme'
import { useAppData } from '@/providers/app-data-context'
import {
  formatUsagePairLabel,
  getAccountRefreshFailureState,
  shouldShowRefreshFailureNotice,
} from '@/services/account-display-state'
import {
  ACCOUNT_LKG_CHANGED_EVENT,
  readAccountLkgCache,
  readLatestAccountAccessDecision,
  writeAccountLkgCache,
} from '@/services/account-lkg-cache'
import { runAccountRefreshExclusive } from '@/services/account-refresh-coordinator'
import { ACCOUNT_RUNTIME_DISABLED_EVENT } from '@/services/account-runtime-enforcement'
import {
  type AccountAccessDecision,
  getUsageAuthorizationEvidence,
  isAccountAccessDenied,
  isRecognizedNodesSnapshot,
  isRecognizedPublicBenefitSnapshot,
  isRecognizedSubscriptionSnapshot,
  isRecognizedUsageSnapshot,
  parseAuthoritativeBytes,
  resolveAccountAccessDecision,
} from '@/services/account-state-validation'
import { authStore } from '@/services/auth-store'
import {
  backendController,
  captureBackendSubject,
  isBackendSubjectCurrent,
  isSubscriptionActiveNow,
  isTrafficExceededError,
  type NodeView,
  type PublicBenefitView,
  type UsageView,
} from '@/services/backend-controller'
import { showNotice } from '@/services/notice-service'
import { runResumeRecovery } from '@/services/resume-recovery'
import { runtimeActionController } from '@/services/runtime-action-controller'
import {
  classifyClientError,
  reportSafeClientFailure,
  toSafeClientErrorMessage,
} from '@/services/safe-client-error'
import {
  checkSelectedNodeReadiness,
  isSelectedNodeConnected,
  resolveSelectedNodeReadinessStatus,
  shouldDisplayReadinessFailure,
  shouldShowReadinessRetryAction,
  type SelectedNodeReadinessStatus,
} from '@/services/selected-node-readiness'
import { syncSubscription } from '@/services/subscription-sync'
import parseTraffic from '@/utils/parse-traffic'
import {
  getProxyDisplayName,
  getProxyDisplayKey,
  isHiddenProxyEntry,
} from '@/utils/proxy-display'

const STARTUP_SYNC_ERROR_KEY = 'xxlink:last-sync-error'
const STARTUP_SYNC_ERROR_TTL_MS = 5 * 60 * 1000
const DASHBOARD_URL = 'https://xxlink.net/dashboard'

const pulse = keyframes`
  0% { box-shadow: 0 0 0 0 rgba(255, 152, 0, 0.6); }
  70% { box-shadow: 0 0 0 22px rgba(255, 152, 0, 0); }
  100% { box-shadow: 0 0 0 0 rgba(255, 152, 0, 0); }
`

const spin = keyframes`
  from { transform: rotate(0deg); }
  to { transform: rotate(360deg); }
`

const breathe = keyframes`
  from { opacity: 0.7; }
  to { opacity: 1; }
`

type ProxyEntry = {
  name: string
  type?: string
  now?: string
  all?: Array<ProxyEntry | string> | string[]
  history?: { time: string; delay: number }[]
}

const resolveLeafProxyName = (
  records: Record<string, ProxyEntry> | undefined,
  name: string,
  depth = 0,
): string => {
  if (!records || !name || depth > 8) return name
  const next = records[name]?.now
  if (!next || next === name) return name
  return resolveLeafProxyName(records, next, depth + 1)
}

const formatDuration = (durationMs: number): string => {
  const totalSeconds = Math.max(0, Math.floor(durationMs / 1000))
  const hours = Math.floor(totalSeconds / 3600)
  const minutes = Math.floor((totalSeconds % 3600) / 60)
  const seconds = totalSeconds % 60

  if (hours > 0) {
    return `${hours}:${minutes.toString().padStart(2, '0')}:${seconds
      .toString()
      .padStart(2, '0')}`
  }

  return `${minutes}:${seconds.toString().padStart(2, '0')}`
}

const formatTrafficTotal = (bytes: number): string => {
  const [value, unit] = parseTraffic(Math.max(0, bytes))
  return `${value} ${unit}`
}

const getNumericBytes = (value: string | number | undefined): number => {
  if (typeof value === 'number') return Number.isFinite(value) ? value : 0
  if (typeof value === 'string') {
    const parsed = Number(value)
    return Number.isFinite(parsed) ? parsed : 0
  }
  return 0
}

type ConnectionSessionState = {
  connectedAt: number | null
  traffic: { up: number; down: number }
}

type PeriodUsageState = {
  used: number
  limit: number
  remaining: number
  percentUsed: number
}

type ConnectionSessionAction =
  | { type: 'start'; ts: number }
  | { type: 'stop' }
  | { type: 'addTraffic'; up: number; down: number }

const connectionSessionReducer = (
  state: ConnectionSessionState,
  action: ConnectionSessionAction,
): ConnectionSessionState => {
  switch (action.type) {
    case 'start':
      return { connectedAt: action.ts, traffic: { up: 0, down: 0 } }
    case 'stop':
      return { ...state, connectedAt: null }
    case 'addTraffic':
      return {
        ...state,
        traffic: {
          up: state.traffic.up + action.up,
          down: state.traffic.down + action.down,
        },
      }
    default:
      return state
  }
}

const toPeriodUsageState = (usage: UsageView): PeriodUsageState => {
  const used = getNumericBytes(usage.trafficUsed)
  const limit = getNumericBytes(usage.trafficLimit)
  const remainingFromServer = getNumericBytes(usage.trafficRemaining)
  const remaining =
    usage.trafficRemaining !== undefined
      ? remainingFromServer
      : Math.max(0, limit - used)
  const percentUsed =
    typeof usage.percentUsed === 'number' && Number.isFinite(usage.percentUsed)
      ? Math.min(Math.max(usage.percentUsed, 0), 100)
      : limit > 0
        ? Math.min((used / limit) * 100, 100)
        : 0
  return { used, limit, remaining, percentUsed }
}

const ConnectPage = () => {
  const { t } = useTranslation()
  const theme = useTheme()
  const tokens = modeTokens(theme.palette.mode)
  const navigate = useNavigate()
  const pageVisible = useVisibility()
  const { verge, preferencesReady, refreshVerge } = useVerge()
  const { proxies, refreshProxy } = useAppData()
  const currentUserId = authStore.getState().user?.id ?? null
  const initialAccountCache = useMemo(
    () => readAccountLkgCache(currentUserId),
    [currentUserId],
  )
  const [busy, setBusy] = useState(false)
  const [readinessStatus, setReadinessStatus] =
    useState<SelectedNodeReadinessStatus>('disconnected')
  const [errorFlash, setErrorFlash] = useState(false)
  const [refreshing, setRefreshing] = useState(false)
  const [hasSubscription, setHasSubscription] = useState<boolean | null>(() =>
    initialAccountCache?.subscription
      ? isSubscriptionActiveNow(initialAccountCache.subscription)
      : null,
  )
  const [accountRefreshFailed, setAccountRefreshFailed] = useState(false)
  const [nodeRefreshFailed, setNodeRefreshFailed] = useState(false)
  const [publicBenefit, setPublicBenefit] = useState<PublicBenefitView | null>(
    () => initialAccountCache?.publicBenefit ?? null,
  )
  const [periodUsage, setPeriodUsage] = useState<PeriodUsageState | null>(() =>
    initialAccountCache?.usage
      ? toPeriodUsageState(initialAccountCache.usage)
      : null,
  )
  const [accountNodes, setAccountNodes] = useState<NodeView[]>(
    () => initialAccountCache?.nodes ?? [],
  )
  const [regionSheetOpen, setRegionSheetOpen] = useState(false)
  const [durationNow, setDurationNow] = useState(() => Date.now())
  const [connectionSession, updateConnectionSession] = useReducer(
    connectionSessionReducer,
    { connectedAt: null, traffic: { up: 0, down: 0 } },
  )
  const [startupSyncError, setStartupSyncError] = useState<boolean>(() => {
    try {
      const raw = localStorage.getItem(STARTUP_SYNC_ERROR_KEY)
      if (!raw) return false
      const parsed = JSON.parse(raw) as { ts?: number }
      if (typeof parsed?.ts !== 'number') return false
      return Date.now() - parsed.ts < STARTUP_SYNC_ERROR_TTL_MS
    } catch {
      return false
    }
  })
  const errorTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const readinessAttemptRef = useRef(0)
  const lastReadinessNodeRef = useRef<string | null>(null)
  const wasConnectedRef = useRef(false)
  const currentTrafficRateRef = useRef({ up: 0, down: 0 })
  const heartbeatTrafficRef = useRef({ up: 0, down: 0 })
  const accountAccessDecisionRef = useRef<{
    subjectId: string | null
    decision: AccountAccessDecision
  }>({
    subjectId: currentUserId,
    decision: initialAccountCache?.accessDecision ?? 'unknown',
  })
  const accountRefreshGenerationRef = useRef(0)
  const heartbeatInFlightRef = useRef(false)
  const lastTrafficSampleRef = useRef<{
    ts: number
    up: number
    down: number
  } | null>(null)

  const triggerErrorFlash = useCallback(() => {
    setErrorFlash(true)
    if (errorTimerRef.current) clearTimeout(errorTimerRef.current)
    errorTimerRef.current = setTimeout(() => setErrorFlash(false), 2000)
  }, [])

  const {
    mode,
    modeChanging,
    serviceInstallMode,
    serviceInstalling,
    systemStateReady,
    isTunModeAvailable,
    setPendingMode,
    handleInstallService,
  } = useConnectModeControl({
    onRefreshProxy: refreshProxy,
    onError: triggerErrorFlash,
  })
  const nodeCatalog = useNodeCatalog({
    selectionScope: 'connect-proxy-selection',
    onSelectionSuccess: refreshProxy,
    onSelectionError: (error) =>
      reportSafeClientFailure('connect-proxy-selection', error),
  })

  const commitAccountAccessDecision = useCallback(
    (subjectId: string, decision: AccountAccessDecision) => {
      const current = accountAccessDecisionRef.current
      if (decision === 'unknown') {
        return current.subjectId === subjectId ? current.decision : 'unknown'
      }
      accountAccessDecisionRef.current = { subjectId, decision }
      return decision
    },
    [],
  )

  const refreshAccountState =
    useCallback(async (): Promise<AccountAccessDecision> => {
      const subjectId = captureBackendSubject()
      if (!subjectId) return 'unknown'
      if (accountAccessDecisionRef.current.subjectId !== subjectId) {
        accountAccessDecisionRef.current = { subjectId, decision: 'unknown' }
      }
      const generation = ++accountRefreshGenerationRef.current
      return runAccountRefreshExclusive(async () => {
        if (
          !isBackendSubjectCurrent(subjectId) ||
          generation !== accountRefreshGenerationRef.current
        ) {
          return accountAccessDecisionRef.current.subjectId === subjectId
            ? accountAccessDecisionRef.current.decision
            : 'unknown'
        }
        const [subscriptionResult, benefitResult, usageResult, nodesResult] =
          await Promise.allSettled([
            backendController.subscription(),
            backendController.publicBenefit(),
            backendController.usage(),
            backendController.nodes(),
          ])
        if (
          !isBackendSubjectCurrent(subjectId) ||
          generation !== accountRefreshGenerationRef.current
        ) {
          return accountAccessDecisionRef.current.subjectId === subjectId
            ? accountAccessDecisionRef.current.decision
            : 'unknown'
        }

        const subscriptionKnown =
          subscriptionResult.status === 'fulfilled' &&
          isRecognizedSubscriptionSnapshot(subscriptionResult.value)
        const publicBenefitKnown =
          benefitResult.status === 'fulfilled' &&
          isRecognizedPublicBenefitSnapshot(benefitResult.value)
        const usageKnown =
          usageResult.status === 'fulfilled' &&
          isRecognizedUsageSnapshot(usageResult.value)
        const nodesKnown =
          nodesResult.status === 'fulfilled' &&
          isRecognizedNodesSnapshot(nodesResult.value)
        const usageAuthorization = usageKnown
          ? getUsageAuthorizationEvidence(usageResult.value)
          : { known: false, authorized: false }

        const refreshFailureState = getAccountRefreshFailureState({
          subscriptionFailed: !subscriptionKnown,
          benefitFailed: !publicBenefitKnown,
          usageFailed: !usageKnown,
          nodesFailed: !nodesKnown,
        })

        setAccountRefreshFailed(refreshFailureState.accountDataRefreshFailed)
        setNodeRefreshFailed(refreshFailureState.nodeListRefreshFailed)

        if (subscriptionKnown) {
          setHasSubscription(isSubscriptionActiveNow(subscriptionResult.value))
        }
        if (publicBenefitKnown) {
          setPublicBenefit(benefitResult.value)
        }
        if (usageKnown) {
          setPeriodUsage(toPeriodUsageState(usageResult.value))
        }
        if (nodesKnown) {
          setAccountNodes(nodesResult.value)
        }

        const decision = resolveAccountAccessDecision({
          previousDecision: readLatestAccountAccessDecision(subjectId),
          subscriptionKnown,
          subscriptionActive:
            subscriptionKnown &&
            isSubscriptionActiveNow(subscriptionResult.value),
          publicBenefitKnown,
          activeBenefitBytes: publicBenefitKnown
            ? (parseAuthoritativeBytes(benefitResult.value.activeBonusBytes) ??
              0)
            : 0,
          usageKnown,
          usageAuthorizationKnown: usageAuthorization.known,
          usageAuthorized: usageAuthorization.authorized,
          trafficRemaining: usageKnown
            ? (parseAuthoritativeBytes(usageResult.value.trafficRemaining) ?? 0)
            : 0,
        })
        const committedDecision = commitAccountAccessDecision(
          subjectId,
          decision,
        )

        if (
          isBackendSubjectCurrent(subjectId) &&
          generation === accountRefreshGenerationRef.current
        ) {
          writeAccountLkgCache(subjectId, {
            subscription: subscriptionKnown
              ? subscriptionResult.value
              : undefined,
            publicBenefit: publicBenefitKnown ? benefitResult.value : undefined,
            usage: usageKnown ? usageResult.value : undefined,
            nodes: nodesKnown ? nodesResult.value : undefined,
            accessDecision:
              decision === 'unknown' ? undefined : committedDecision,
          })
        }
        return committedDecision
      })
    }, [commitAccountAccessDecision])

  // Refresh the managed profile before reading account state on visibility.
  // A transient failure preserves the existing LKG and schedules recovery.
  useEffect(() => {
    if (!pageVisible) return
    let cancelled = false
    void runResumeRecovery('connect-visible')
      .then(() => (cancelled ? undefined : refreshAccountState()))
      .catch(() => {
        if (!cancelled) {
          setAccountRefreshFailed(true)
          setNodeRefreshFailed(true)
        }
      })
    return () => {
      cancelled = true
    }
  }, [pageVisible, refreshAccountState])

  useEffect(() => {
    const applyCache = () => {
      const cache = readAccountLkgCache(authStore.getState().user?.id)
      if (!cache) return
      setHasSubscription(
        cache.subscription ? isSubscriptionActiveNow(cache.subscription) : null,
      )
      setPublicBenefit(cache.publicBenefit)
      setPeriodUsage(cache.usage ? toPeriodUsageState(cache.usage) : null)
      setAccountNodes(cache.nodes)
      const subjectId = authStore.getState().user?.id
      if (subjectId) {
        commitAccountAccessDecision(subjectId, cache.accessDecision)
      }
    }
    window.addEventListener(ACCOUNT_LKG_CHANGED_EVENT, applyCache)
    return () =>
      window.removeEventListener(ACCOUNT_LKG_CHANGED_EVENT, applyCache)
  }, [commitAccountAccessDecision])

  // Listen for startup-sync-error changes (written async by main.tsx or
  // cleared by subscription-sync success). Keeps the Alert in sync with
  // localStorage across async writes and cross-tab updates.
  useEffect(() => {
    const readStartupSyncError = () => {
      try {
        const raw = localStorage.getItem(STARTUP_SYNC_ERROR_KEY)
        if (!raw) return false
        const parsed = JSON.parse(raw) as { ts?: number }
        if (typeof parsed?.ts !== 'number') return false
        return Date.now() - parsed.ts < STARTUP_SYNC_ERROR_TTL_MS
      } catch {
        return false
      }
    }
    const handler = () => setStartupSyncError(readStartupSyncError())
    window.addEventListener('xxlink:last-sync-error-changed', handler)
    window.addEventListener('storage', handler)
    return () => {
      window.removeEventListener('xxlink:last-sync-error-changed', handler)
      window.removeEventListener('storage', handler)
    }
  }, [])

  const lastKnownTunEnabled = verge?.enable_tun_mode === true
  const lastKnownSystemProxyEnabled = verge?.enable_system_proxy === true
  const tunEnabled = preferencesReady && lastKnownTunEnabled
  const sysEnabled = preferencesReady && lastKnownSystemProxyEnabled

  // Runtime state per selected mode. User-facing "connected" still waits for
  // the selected-node data-plane readiness check below.
  const runtimeConnected = useMemo(() => {
    switch (mode) {
      case 'system':
        return sysEnabled
      case 'both':
      case 'smart':
        return tunEnabled && sysEnabled
      default:
        return false
    }
  }, [mode, tunEnabled, sysEnabled])

  // Failed preference reads are never presented as authoritative connection
  // state. Last-known flags are used only to keep a safe disable action
  // reachable when part of the runtime may still be active.
  const runtimeMayRequireDisable = useMemo(() => {
    switch (mode) {
      case 'system':
        return lastKnownSystemProxyEnabled
      case 'both':
      case 'smart':
        return lastKnownTunEnabled || lastKnownSystemProxyEnabled
      default:
        return false
    }
  }, [lastKnownSystemProxyEnabled, lastKnownTunEnabled, mode])

  const connected = isSelectedNodeConnected(runtimeConnected, readinessStatus)

  const {
    response: { data: traffic },
  } = useTrafficData({ enabled: connected })

  const [upVal, upUnit] = parseTraffic(traffic?.up || 0)
  const [downVal, downUnit] = parseTraffic(traffic?.down || 0)

  useEffect(() => {
    currentTrafficRateRef.current = {
      up: traffic?.up || 0,
      down: traffic?.down || 0,
    }
  }, [traffic?.down, traffic?.up])

  useEffect(() => {
    if (connected && !wasConnectedRef.current) {
      const now = Date.now()
      updateConnectionSession({ type: 'start', ts: now })
      heartbeatTrafficRef.current = { up: 0, down: 0 }
      lastTrafficSampleRef.current = {
        ts: now,
        up: currentTrafficRateRef.current.up,
        down: currentTrafficRateRef.current.down,
      }
      void refreshAccountState()
    }

    if (!connected && wasConnectedRef.current) {
      updateConnectionSession({ type: 'stop' })
      heartbeatTrafficRef.current = { up: 0, down: 0 }
      lastTrafficSampleRef.current = null
      void refreshAccountState()
    }

    wasConnectedRef.current = connected
  }, [connected, refreshAccountState])

  useEffect(() => {
    if (!connected) return
    const timer = window.setInterval(() => {
      const now = Date.now()
      const last = lastTrafficSampleRef.current
      const rate = currentTrafficRateRef.current
      setDurationNow(now)
      if (!last) {
        lastTrafficSampleRef.current = { ts: now, ...rate }
        return
      }
      const deltaSeconds = Math.min(Math.max(now - last.ts, 0), 5000) / 1000
      updateConnectionSession({
        type: 'addTraffic',
        up: Math.max(0, last.up) * deltaSeconds,
        down: Math.max(0, last.down) * deltaSeconds,
      })
      heartbeatTrafficRef.current = {
        up:
          heartbeatTrafficRef.current.up + Math.max(0, last.up) * deltaSeconds,
        down:
          heartbeatTrafficRef.current.down +
          Math.max(0, last.down) * deltaSeconds,
      }
      lastTrafficSampleRef.current = { ts: now, ...rate }
    }, 1000)
    return () => window.clearInterval(timer)
  }, [connected])

  const proxyRecords = proxies?.records as
    | Record<string, ProxyEntry>
    | undefined

  const currentNode = nodeCatalog.currentNode
  const currentRuntimeNode = useMemo(
    () => resolveLeafProxyName(proxyRecords, currentNode),
    [currentNode, proxyRecords],
  )
  const currentNodeDisplay = nodeCatalog.currentNodeDisplay

  const currentNodeId = useMemo(() => {
    if (!currentRuntimeNode && !currentNode && !currentNodeDisplay) return null
    const visibleCurrentName = isHiddenProxyEntry(
      currentNode,
      proxyRecords?.[currentNode],
    )
      ? ''
      : currentNode
    const visibleRuntimeName = isHiddenProxyEntry(
      currentRuntimeNode,
      proxyRecords?.[currentRuntimeNode],
    )
      ? ''
      : currentRuntimeNode
    const currentKey = visibleCurrentName
      ? getProxyDisplayKey(visibleCurrentName)
      : ''
    const runtimeKey = visibleRuntimeName
      ? getProxyDisplayKey(currentRuntimeNode)
      : ''
    const displayKey = currentNodeDisplay
      ? getProxyDisplayKey(currentNodeDisplay)
      : ''
    const match = accountNodes.find((node) => {
      const nodeDisplay = getProxyDisplayName(node.name)
      const nodeKey = getProxyDisplayKey(node.name)
      return (
        node.name === visibleRuntimeName ||
        node.name === visibleCurrentName ||
        nodeDisplay === currentNodeDisplay ||
        (runtimeKey && nodeKey === runtimeKey) ||
        (currentKey && nodeKey === currentKey) ||
        (displayKey && getProxyDisplayKey(nodeDisplay) === displayKey)
      )
    })
    return match?.id ?? null
  }, [
    accountNodes,
    currentNode,
    currentNodeDisplay,
    currentRuntimeNode,
    proxyRecords,
  ])

  const isEmpty = nodeCatalog.nodes.length === 0

  const stopFailedReadinessConnection = useCallback(
    async (attempt: number) => {
      try {
        await runtimeActionController.setConnectionEnabled(mode, false)
        if (readinessAttemptRef.current === attempt) {
          lastReadinessNodeRef.current = null
          setReadinessStatus('disconnected')
          updateConnectionSession({ type: 'stop' })
          heartbeatTrafficRef.current = { up: 0, down: 0 }
          lastTrafficSampleRef.current = null
        }
        await refreshProxy()
      } catch (error) {
        reportSafeClientFailure('connect-readiness-auto-disconnect', error)
        showNotice.error(
          toSafeClientErrorMessage(classifyClientError(error).kind, t),
        )
      }
    },
    [mode, refreshProxy, t],
  )

  const validateSelectedNodeReadiness = useCallback(async () => {
    const selectedNode = currentRuntimeNode || currentNode
    const attempt = readinessAttemptRef.current + 1
    readinessAttemptRef.current = attempt
    lastReadinessNodeRef.current = selectedNode || null
    setReadinessStatus('validating')

    if (!selectedNode) {
      if (readinessAttemptRef.current === attempt) {
        setReadinessStatus('failed')
        triggerErrorFlash()
        showNotice.error(
          'layout.components.connect.feedback.selectedNodeFailed',
        )
        await stopFailedReadinessConnection(attempt)
      }
      return false
    }

    const result = await checkSelectedNodeReadiness({
      proxyName: selectedNode,
    })

    if (readinessAttemptRef.current !== attempt) {
      return result.ok
    }

    const nextStatus = resolveSelectedNodeReadinessStatus(result)
    setReadinessStatus(nextStatus)
    if (nextStatus === 'ready') {
      return true
    }

    triggerErrorFlash()
    return false
  }, [
    currentNode,
    currentRuntimeNode,
    stopFailedReadinessConnection,
    triggerErrorFlash,
  ])

  useEffect(() => {
    if (!runtimeConnected) {
      readinessAttemptRef.current += 1
      lastReadinessNodeRef.current = null
      Promise.resolve().then(() => setReadinessStatus('disconnected'))
      return
    }

    const selectedNode = currentRuntimeNode || currentNode
    if (!selectedNode) {
      Promise.resolve().then(() => setReadinessStatus('failed'))
      return
    }

    if (lastReadinessNodeRef.current === selectedNode) return
    void validateSelectedNodeReadiness()
  }, [
    currentNode,
    currentRuntimeNode,
    runtimeConnected,
    validateSelectedNodeReadiness,
  ])

  const handleToggle = useLockFn(async () => {
    if (
      (!preferencesReady && !runtimeMayRequireDisable) ||
      busy ||
      modeChanging ||
      readinessStatus === 'connecting' ||
      readinessStatus === 'validating'
    )
      return
    const next = !runtimeMayRequireDisable
    if (next && mode !== 'system') {
      if (!systemStateReady) return
      if (isTunModeAvailable !== true) {
        setPendingMode(mode)
        return
      }
    }
    setBusy(true)
    try {
      if (next) {
        setReadinessStatus('connecting')
        const decision = await refreshAccountState()
        if (isAccountAccessDenied(decision)) {
          setReadinessStatus('disconnected')
          showNotice.error(
            decision === 'quota_exhausted'
              ? 'layout.components.connect.feedback.trafficExceeded'
              : 'layout.components.connect.empty.noSubscription',
          )
          return
        }
      } else {
        readinessAttemptRef.current += 1
        lastReadinessNodeRef.current = null
        setReadinessStatus('disconnected')
      }
      await runtimeActionController.setConnectionEnabled(mode, next)
      if (next) {
        await refreshProxy()
        await validateSelectedNodeReadiness()
      }
      await refreshAccountState()
    } catch (error) {
      reportSafeClientFailure('connect-toggle', error)
      showNotice.error(
        toSafeClientErrorMessage(classifyClientError(error).kind, t),
      )
      setReadinessStatus(runtimeConnected ? 'failed' : 'disconnected')
      triggerErrorFlash()
    } finally {
      setBusy(false)
    }
  })

  const handleRefresh = useLockFn(async () => {
    if (refreshing) return
    setRefreshing(true)
    try {
      await syncSubscription({ force: true })
      await refreshProxy()
      await refreshAccountState()
      try {
        localStorage.removeItem(STARTUP_SYNC_ERROR_KEY)
      } catch {
        /* ignore */
      }
      setStartupSyncError(false)
      showNotice.success('layout.components.connect.feedback.refreshed')
    } catch (error) {
      reportSafeClientFailure('connect-refresh', error)
      showNotice.error(
        toSafeClientErrorMessage(classifyClientError(error).kind, t),
      )
    } finally {
      setRefreshing(false)
    }
  })

  const handleDismissStartupSyncError = useCallback(() => {
    try {
      localStorage.removeItem(STARTUP_SYNC_ERROR_KEY)
    } catch {
      /* ignore */
    }
    setStartupSyncError(false)
  }, [])

  const handleRetryStartupSync = useCallback(() => {
    handleDismissStartupSyncError()
    void handleRefresh()
  }, [handleDismissStartupSyncError, handleRefresh])

  const handleOpenDashboard = useCallback(() => {
    void open(DASHBOARD_URL)
  }, [])

  useEffect(() => {
    const handleRuntimeDisabled = () => {
      const subjectId = captureBackendSubject()
      if (!subjectId) return
      const currentDecision = readLatestAccountAccessDecision(subjectId)
      if (!isAccountAccessDenied(currentDecision)) return
      commitAccountAccessDecision(subjectId, currentDecision)
      readinessAttemptRef.current += 1
      lastReadinessNodeRef.current = null
      setReadinessStatus('disconnected')
      updateConnectionSession({ type: 'stop' })
      heartbeatTrafficRef.current = { up: 0, down: 0 }
      lastTrafficSampleRef.current = null
      showNotice.error(
        currentDecision === 'quota_exhausted'
          ? 'layout.components.connect.feedback.trafficExceeded'
          : 'layout.components.connect.empty.noSubscription',
      )
      void Promise.allSettled([refreshVerge(), refreshProxy()]).then(
        (refreshResults) => {
          const failedRefresh = refreshResults.find(
            (result) => result.status === 'rejected',
          )
          if (failedRefresh?.status === 'rejected') {
            reportSafeClientFailure(
              'connect-traffic-exceeded-disconnect',
              failedRefresh.reason,
            )
          }
        },
      )
    }

    window.addEventListener(
      ACCOUNT_RUNTIME_DISABLED_EVENT,
      handleRuntimeDisabled,
    )
    return () =>
      window.removeEventListener(
        ACCOUNT_RUNTIME_DISABLED_EVENT,
        handleRuntimeDisabled,
      )
  }, [commitAccountAccessDecision, refreshProxy, refreshVerge])

  useEffect(() => {
    if (!connected || !currentNodeId) return
    const reportHeartbeat = async () => {
      if (heartbeatInFlightRef.current) return
      heartbeatInFlightRef.current = true
      const generation = ++accountRefreshGenerationRef.current
      const subjectId = captureBackendSubject()
      try {
        const bytes = heartbeatTrafficRef.current
        const bytesUp = Math.floor(bytes.up)
        const bytesDown = Math.floor(bytes.down)
        heartbeatTrafficRef.current = {
          up: Math.max(0, bytes.up - bytesUp),
          down: Math.max(0, bytes.down - bytesDown),
        }
        try {
          await backendController.reportTraffic({
            nodeId: currentNodeId,
            bytesUp,
            bytesDown,
            timestamp: Date.now(),
          })
        } catch (error) {
          if (isTrafficExceededError(error)) {
            if (subjectId && isBackendSubjectCurrent(subjectId)) {
              if (generation === accountRefreshGenerationRef.current) {
                await runAccountRefreshExclusive(async () => {
                  if (
                    !isBackendSubjectCurrent(subjectId) ||
                    generation !== accountRefreshGenerationRef.current
                  ) {
                    return
                  }
                  commitAccountAccessDecision(subjectId, 'quota_exhausted')
                  writeAccountLkgCache(subjectId, {
                    accessDecision: 'quota_exhausted',
                  })
                })
              } else {
                void refreshAccountState()
              }
            }
            return
          }
          heartbeatTrafficRef.current = {
            up: heartbeatTrafficRef.current.up + bytesUp,
            down: heartbeatTrafficRef.current.down + bytesDown,
          }
          reportSafeClientFailure('connect-traffic-heartbeat', error)
          return
        }

        if (!subjectId) return
        await runAccountRefreshExclusive(async () => {
          if (
            !isBackendSubjectCurrent(subjectId) ||
            generation !== accountRefreshGenerationRef.current
          ) {
            return
          }
          const usage = await backendController.usage()
          if (
            !isBackendSubjectCurrent(subjectId) ||
            generation !== accountRefreshGenerationRef.current
          ) {
            return
          }
          if (!isRecognizedUsageSnapshot(usage)) {
            throw new Error('invalid_usage_snapshot')
          }
          const authorization = getUsageAuthorizationEvidence(usage)
          const decision = resolveAccountAccessDecision({
            subscriptionKnown: false,
            subscriptionActive: false,
            publicBenefitKnown: false,
            activeBenefitBytes: 0,
            usageKnown: true,
            usageAuthorizationKnown: authorization.known,
            usageAuthorized: authorization.authorized,
            trafficRemaining:
              parseAuthoritativeBytes(usage.trafficRemaining) ?? 0,
          })
          setPeriodUsage(toPeriodUsageState(usage))
          setAccountRefreshFailed(false)
          const committedDecision = commitAccountAccessDecision(
            subjectId,
            decision,
          )
          writeAccountLkgCache(subjectId, {
            usage,
            accessDecision:
              decision === 'unknown' ? undefined : committedDecision,
          })
        })
      } catch (error) {
        if (
          subjectId &&
          isBackendSubjectCurrent(subjectId) &&
          generation === accountRefreshGenerationRef.current
        ) {
          setAccountRefreshFailed(true)
          reportSafeClientFailure('connect-traffic-heartbeat', error)
        }
      } finally {
        heartbeatInFlightRef.current = false
      }
    }

    void reportHeartbeat()
    const timer = window.setInterval(() => {
      void reportHeartbeat()
    }, 30_000)
    return () => {
      window.clearInterval(timer)
      void reportHeartbeat()
    }
  }, [
    commitAccountAccessDecision,
    connected,
    currentNodeId,
    refreshAccountState,
  ])

  const connectionBusy =
    (!preferencesReady && !runtimeMayRequireDisable) ||
    busy ||
    modeChanging ||
    readinessStatus === 'connecting' ||
    readinessStatus === 'validating'
  const showReadinessFailure = shouldDisplayReadinessFailure(
    readinessStatus,
    errorFlash,
  )
  const showReadinessRetryAction = shouldShowReadinessRetryAction(
    runtimeConnected,
    readinessStatus,
  )

  const connectionStatusLabel = useMemo(() => {
    if (isEmpty) return t('layout.components.connect.labels.disconnected')
    switch (readinessStatus) {
      case 'connecting':
        return t('layout.components.connect.labels.connecting')
      case 'validating':
        return t('layout.components.connect.labels.validating')
      case 'degraded':
        return t('layout.components.connect.labels.connectionUnverified')
      case 'failed':
        return t('layout.components.connect.labels.connectionFailed')
      case 'ready':
        return t('layout.components.connect.labels.connected')
      default:
        if (showReadinessFailure) {
          return t('layout.components.connect.labels.connectionFailed')
        }
        return t('layout.components.connect.labels.disconnected')
    }
  }, [isEmpty, readinessStatus, showReadinessFailure, t])

  const connectionStatusHint = useMemo(() => {
    if (isEmpty) return t('layout.components.connect.empty.subtitle')
    if (
      readinessStatus === 'disconnected' &&
      nodeCatalog.selectionSource === 'auto'
    ) {
      return t('layout.components.connect.location.lockedHint')
    }
    switch (readinessStatus) {
      case 'connecting':
        return t('layout.components.connect.labels.connecting')
      case 'validating':
        return t('layout.components.connect.labels.validating')
      case 'degraded':
        return t('layout.components.connect.labels.connectionUnverifiedHint')
      case 'failed':
        return t('layout.components.connect.feedback.selectedNodeFailed')
      case 'ready':
        return t('layout.components.connect.labels.connected')
      default:
        if (showReadinessFailure) {
          return t('layout.components.connect.feedback.selectedNodeFailed')
        }
        return t('layout.components.connect.actions.clickToConnect')
    }
  }, [
    isEmpty,
    nodeCatalog.selectionSource,
    readinessStatus,
    showReadinessFailure,
    t,
  ])

  // Button colors
  const getButtonColor = () => {
    if (showReadinessFailure) return theme.palette.error.main
    if (connectionBusy) return theme.palette.warning.main
    if (readinessStatus === 'degraded') return theme.palette.warning.main
    if (connected) return theme.palette.success.main
    return theme.palette.primary.main
  }

  const buttonColor = getButtonColor()
  const powerIsConnected =
    connected && !showReadinessFailure && readinessStatus !== 'degraded'
  const powerRingBackground = showReadinessFailure
    ? `conic-gradient(from 210deg, ${theme.palette.error.main}, ${tokens.glowError}, ${theme.palette.error.main})`
    : readinessStatus === 'degraded'
      ? `conic-gradient(from 210deg, ${theme.palette.warning.main}, ${theme.palette.secondary.main}, ${theme.palette.warning.main})`
      : connectionBusy
        ? `conic-gradient(from 210deg, ${theme.palette.warning.main}, ${theme.palette.secondary.main}, ${theme.palette.warning.main})`
        : powerIsConnected
          ? `conic-gradient(from 210deg, ${theme.palette.success.main}, ${theme.palette.secondary.main}, ${theme.palette.success.main})`
          : `conic-gradient(from 210deg, ${theme.palette.primary.main}, ${theme.palette.secondary.main}, ${theme.palette.primary.main})`
  const powerRingGlow = showReadinessFailure
    ? `0 0 64px 0 ${tokens.glowError}`
    : readinessStatus === 'degraded'
      ? `0 0 64px 0 ${alpha(theme.palette.warning.main, 0.4)}`
      : connectionBusy
        ? `0 0 56px 0 ${alpha(theme.palette.warning.main, 0.32)}`
        : powerIsConnected
          ? `0 0 74px 8px ${tokens.glowSuccess}`
          : `0 0 64px 0 ${tokens.glowPrimary}`
  const powerButtonBackground = showReadinessFailure
    ? alpha(theme.palette.error.main, 0.06)
    : readinessStatus === 'degraded' || connectionBusy
      ? alpha(theme.palette.warning.main, 0.06)
      : tokens.surfaceRaised
  const powerButtonForeground = powerIsConnected
    ? theme.palette.success.main
    : buttonColor
  const trialNeedsClaim =
    publicBenefit?.visible === true &&
    publicBenefit.isTrial &&
    publicBenefit.canClaim &&
    (periodUsage?.limit ?? 0) <= 0
  const trialOutOfTraffic =
    publicBenefit?.visible === true &&
    publicBenefit.isTrial &&
    (periodUsage?.limit ?? 0) > 0 &&
    (periodUsage?.remaining ?? 0) <= 0
  const hasAccountFallbackData =
    hasSubscription !== null || publicBenefit !== null || periodUsage !== null
  const hasNodeFallbackData =
    accountNodes.length > 0 || nodeCatalog.nodes.length > 0
  const showAccountRefreshNotice = shouldShowRefreshFailureNotice({
    refreshFailed: accountRefreshFailed,
    hasLastKnownGood: hasAccountFallbackData,
  })
  const showNodeRefreshNotice = shouldShowRefreshFailureNotice({
    refreshFailed: nodeRefreshFailed,
    hasLastKnownGood: hasNodeFallbackData,
  })

  const connectedDurationLabel = connectionSession.connectedAt
    ? formatDuration(durationNow - connectionSession.connectedAt)
    : '0:00'
  const periodTrafficLimit = periodUsage?.limit ?? 0
  const periodTrafficPct = periodUsage?.percentUsed ?? 0
  const periodTrafficLabel = formatUsagePairLabel({
    usageKnown: periodUsage !== null,
    usedLabel: formatTrafficTotal(periodUsage?.used ?? 0),
    limitLabel:
      periodTrafficLimit > 0 ? formatTrafficTotal(periodTrafficLimit) : null,
    unknownLabel: t('layout.components.connect.session.usageUnavailable'),
  })
  const selectedNode = nodeCatalog.selectedNode
  const selectedDelay = selectedNode
    ? nodeCatalog.getNodeDelay(selectedNode)
    : -1
  const selectedCity = selectedNode
    ? getRegionName(selectedNode.displayName)
    : ''
  const locationTitle = selectedNode
    ? selectedCity
    : t('layout.components.connect.labels.selectNode')
  const locationSubtitle = !selectedNode
    ? t('layout.components.connect.location.chooseHint')
    : nodeCatalog.selectionSource === 'auto'
      ? t('layout.components.connect.location.auto', { city: selectedCity })
      : t('layout.components.connect.location.route', {
          city: selectedCity,
          route: getNodeRouteLabel(selectedNode.displayName),
        })
  const connectedLocationSubtitle = selectedNode
    ? t('layout.components.connect.location.connected', {
        latency: selectedDelay > 0 ? selectedDelay : '--',
        upload: `${upVal} ${upUnit}/s`,
        download: `${downVal} ${downUnit}/s`,
      })
    : locationSubtitle

  const refreshControl = hasSubscription === true && (
    <Tooltip title={t('layout.components.connect.empty.rebuild')}>
      <span>
        <IconButton
          aria-label={t('layout.components.connect.empty.rebuild')}
          onClick={handleRefresh}
          disabled={refreshing}
          size="small"
          sx={{
            width: 34,
            height: 34,
            border: `1px solid ${alpha(theme.palette.divider, 0.7)}`,
            bgcolor: alpha(theme.palette.primary.main, 0.08),
            color: 'primary.main',
            '&:hover': {
              bgcolor: alpha(theme.palette.primary.main, 0.16),
            },
          }}
        >
          {refreshing ? <CircularProgress size={18} /> : <RefreshRounded />}
        </IconButton>
      </span>
    </Tooltip>
  )

  return (
    <BasePage
      title={t('layout.components.connect.title')}
      header={refreshControl}
      contentStyle={{ height: '100%' }}
    >
      <Stack
        spacing={1.5}
        sx={{
          maxWidth: 420,
          mx: 'auto',
          py: { xs: 1, sm: 1.5 },
          height: '100%',
          boxSizing: 'border-box',
          alignItems: 'center',
          overflow: 'auto',
        }}
      >
        {(trialNeedsClaim ||
          trialOutOfTraffic ||
          startupSyncError ||
          showAccountRefreshNotice ||
          showNodeRefreshNotice) && (
          <Stack spacing={1}>
            {trialNeedsClaim && (
              <Alert
                severity="info"
                action={
                  <Button
                    color="inherit"
                    size="small"
                    onClick={handleOpenDashboard}
                  >
                    {t('layout.components.connect.trial.openDashboard')}
                  </Button>
                }
              >
                {t('layout.components.connect.trial.claimPrompt')}
              </Alert>
            )}
            {trialOutOfTraffic && (
              <Alert severity="warning">
                {t('layout.components.connect.trial.trafficExceeded')}
              </Alert>
            )}
            {hasSubscription === true && startupSyncError && (
              <Alert
                severity="error"
                onClose={handleDismissStartupSyncError}
                sx={{ cursor: 'pointer' }}
                onClick={handleRetryStartupSync}
                action={
                  <Button
                    size="small"
                    color="inherit"
                    onClick={(event) => {
                      event.stopPropagation()
                      handleRetryStartupSync()
                    }}
                  >
                    {t('shared.actions.retry')}
                  </Button>
                }
              >
                {t('layout.components.connect.startupSyncFailed')}
              </Alert>
            )}
            {showAccountRefreshNotice && (
              <Alert severity="warning">
                {t('layout.components.connect.feedback.accountRefreshFailed')}
              </Alert>
            )}
            {showNodeRefreshNotice && (
              <Alert severity="warning">
                {t('layout.components.connect.feedback.nodeRefreshFailed')}
              </Alert>
            )}
          </Stack>
        )}

        {serviceInstallMode && (
          <Alert
            severity="warning"
            action={
              <Button
                color="inherit"
                size="small"
                onClick={handleInstallService}
                disabled={serviceInstalling || !preferencesReady}
                startIcon={
                  serviceInstalling ? (
                    <CircularProgress size={14} color="inherit" />
                  ) : undefined
                }
              >
                {serviceInstalling
                  ? t('settings.statuses.clashService.installing')
                  : t('settings.sections.proxyControl.actions.installService')}
              </Button>
            }
          >
            {t('settings.sections.proxyControl.tooltips.tunUnavailable')}
          </Alert>
        )}

        <Box
          sx={{
            width: '100%',
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
          }}
        >
          <Stack spacing={1.5} alignItems="center" sx={{ mb: 2 }}>
            <Box
              sx={{
                position: 'relative',
                width: 224,
                height: 224,
                borderRadius: '50%',
                boxShadow: powerRingGlow,
                '&::after': {
                  content: '""',
                  position: 'absolute',
                  inset: 0,
                  borderRadius: '50%',
                  boxShadow: powerIsConnected
                    ? `0 0 88px 8px ${tokens.glowSuccess}`
                    : 'none',
                  opacity: powerIsConnected ? 0.7 : 0,
                  animation: powerIsConnected
                    ? `${breathe} 4s ease-in-out infinite alternate`
                    : 'none',
                  pointerEvents: 'none',
                  zIndex: 0,
                },
              }}
            >
              <Box
                sx={{
                  position: 'absolute',
                  inset: 0,
                  borderRadius: '50%',
                  background: powerRingBackground,
                  animation: connectionBusy
                    ? `${spin} 2.4s linear infinite`
                    : 'none',
                  zIndex: 1,
                }}
              ></Box>
              <Box
                sx={{
                  position: 'absolute',
                  inset: 0,
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  zIndex: 2,
                }}
              >
                <Button
                  onClick={handleToggle}
                  disabled={connectionBusy || isEmpty}
                  aria-label={
                    connected
                      ? t('layout.components.connect.labels.connected')
                      : t('layout.components.connect.actions.connect')
                  }
                  sx={{
                    width: 184,
                    height: 184,
                    minWidth: 184,
                    borderRadius: '50%',
                    bgcolor: powerButtonBackground,
                    color: powerButtonForeground,
                    border: `1px solid ${alpha(theme.palette.primary.main, 0.08)}`,
                    transition:
                      'transform 0.28s ease-in-out, filter 0.28s ease-in-out',
                    animation: connectionBusy
                      ? `${pulse} 1.4s infinite`
                      : 'none',
                    '&:hover': {
                      bgcolor: powerButtonBackground,
                      filter: 'brightness(1.08)',
                      transform: 'scale(1.02)',
                    },
                    '&:active': { transform: 'scale(0.98)' },
                    '&.Mui-disabled': {
                      bgcolor: powerButtonBackground,
                      color: isEmpty
                        ? theme.palette.action.disabled
                        : powerButtonForeground,
                      opacity: connectionBusy ? 0.75 : 0.9,
                    },
                  }}
                >
                  {connectionBusy ? (
                    <CircularProgress
                      size={56}
                      thickness={4}
                      sx={{ color: 'inherit' }}
                    />
                  ) : (
                    <PowerSettingsNewRounded sx={{ fontSize: 64 }} />
                  )}
                </Button>
              </Box>
            </Box>

            <Box sx={{ minWidth: 0, width: '100%', textAlign: 'center' }}>
              <Typography
                component="div"
                fontSize={28}
                lineHeight={1.15}
                fontWeight={900}
                color={
                  errorFlash
                    ? 'error.main'
                    : readinessStatus === 'degraded'
                      ? 'warning.main'
                      : connected
                        ? 'success.main'
                        : readinessStatus === 'failed'
                          ? 'error.main'
                          : 'text.primary'
                }
              >
                {connectionStatusLabel}
              </Typography>
              <Typography
                variant="body2"
                color="text.secondary"
                sx={{
                  mt: 0.5,
                  mb: isEmpty || showReadinessFailure ? 1.5 : 0,
                }}
              >
                {powerIsConnected
                  ? t('layout.components.connect.labels.connectedSecureHint', {
                      duration: connectedDurationLabel,
                    })
                  : connectionStatusHint}
              </Typography>
              {isEmpty ? (
                <Button
                  variant="contained"
                  size="large"
                  onClick={() => navigate('/plans')}
                  sx={{ px: 4, fontWeight: 950 }}
                >
                  {t('layout.components.connect.empty.goToPlans')}
                </Button>
              ) : null}
              {showReadinessRetryAction ? (
                <Button
                  variant="outlined"
                  size="small"
                  onClick={validateSelectedNodeReadiness}
                  disabled={connectionBusy}
                  sx={{ fontWeight: 850 }}
                >
                  {t('layout.components.connect.actions.retry')}
                </Button>
              ) : null}
            </Box>
          </Stack>

          <ButtonBase
            component="button"
            type="button"
            onClick={() => setRegionSheetOpen(true)}
            disabled={busy || modeChanging || isEmpty}
            aria-label={t('layout.components.connect.actions.switchNode')}
            sx={{
              width: '100%',
              maxWidth: 356,
              borderRadius: designTokens.radius.lg,
              textAlign: 'left',
              '&:focus-visible': {
                outline: `2px solid ${alpha(theme.palette.primary.main, 0.6)}`,
                outlineOffset: 2,
              },
              '&.Mui-disabled': { opacity: 1 },
            }}
          >
            <Paper
              variant="surface"
              component="span"
              sx={{
                width: '100%',
                minHeight: 82,
                boxSizing: 'border-box',
                px: 2,
                py: 1.5,
                display: 'flex',
                alignItems: 'center',
                gap: 1.25,
                borderRadius: designTokens.radius.lg,
                transition: theme.transitions.create([
                  'border-color',
                  'box-shadow',
                ]),
                '&:hover': {
                  borderColor: alpha(theme.palette.primary.main, 0.32),
                  boxShadow: `0 8px 24px ${alpha(theme.palette.primary.main, 0.08)}`,
                },
              }}
            >
              <Typography component="span" sx={{ fontSize: 28, lineHeight: 1 }}>
                {selectedNode ? getRegionFlag(selectedCity) : '🌐'}
              </Typography>
              <Box component="span" sx={{ minWidth: 0, flex: 1 }}>
                <Typography
                  component="span"
                  display="block"
                  fontSize={16}
                  fontWeight={900}
                  noWrap
                >
                  {locationTitle}
                </Typography>
                <Typography
                  component="span"
                  display="block"
                  variant="caption"
                  color={powerIsConnected ? 'success.main' : 'text.secondary'}
                  noWrap
                  sx={{ mt: 0.25, fontVariantNumeric: 'tabular-nums' }}
                >
                  {powerIsConnected
                    ? connectedLocationSubtitle
                    : locationSubtitle}
                </Typography>
              </Box>
              <Box
                component="span"
                sx={{
                  width: 30,
                  height: 30,
                  flex: '0 0 auto',
                  display: 'grid',
                  placeItems: 'center',
                  borderRadius: '50%',
                  color: powerIsConnected ? 'success.main' : 'primary.main',
                  border: `1px solid ${alpha(
                    powerIsConnected
                      ? theme.palette.success.main
                      : theme.palette.primary.main,
                    0.22,
                  )}`,
                }}
              >
                <ChevronRightRounded sx={{ fontSize: 20 }} />
              </Box>
            </Paper>
          </ButtonBase>

          <Box sx={{ width: '100%', maxWidth: 356, mt: 0.5 }}>
            <Stack
              direction="row"
              justifyContent="space-between"
              alignItems="center"
            >
              <Typography
                variant="caption"
                color="text.secondary"
                fontWeight={750}
              >
                {t('layout.components.connect.usage.label')}
              </Typography>
              <Typography
                variant="caption"
                color="text.secondary"
                sx={{ fontVariantNumeric: 'tabular-nums' }}
              >
                {periodTrafficLabel}
              </Typography>
            </Stack>
            <Box
              role="progressbar"
              aria-label={t('layout.components.connect.usage.label')}
              aria-valuemin={0}
              aria-valuemax={100}
              aria-valuenow={periodUsage ? periodTrafficPct : 0}
              sx={{
                width: 320,
                maxWidth: '100%',
                height: 6,
                mt: 0.75,
                overflow: 'hidden',
                borderRadius: designTokens.radius.pill,
                bgcolor: alpha(theme.palette.success.main, 0.14),
              }}
            >
              <Box
                sx={{
                  width: `${periodUsage ? periodTrafficPct : 0}%`,
                  height: '100%',
                  borderRadius: designTokens.radius.pill,
                  bgcolor: 'success.main',
                  transition: theme.transitions.create('width'),
                }}
              />
            </Box>
          </Box>
        </Box>
      </Stack>
      <RegionSheet
        open={regionSheetOpen}
        onClose={() => setRegionSheetOpen(false)}
        catalog={nodeCatalog}
      />
    </BasePage>
  )
}

export default ConnectPage
