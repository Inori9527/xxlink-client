import {
  AccessTimeRounded,
  DataUsageRounded,
  KeyboardArrowDownRounded,
  PowerSettingsNewRounded,
  RefreshRounded,
} from '@mui/icons-material'
import {
  Alert,
  Box,
  Button,
  ButtonGroup,
  Chip,
  CircularProgress,
  IconButton,
  LinearProgress,
  ListItemText,
  Menu,
  MenuItem,
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
  type MouseEvent,
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
import ProxyControlSwitches from '@/components/shared/proxy-control-switches'
import { useClash } from '@/hooks/use-clash'
import {
  getConnectModePayload,
  loadConnectMode,
  persistConnectMode,
  type ConnectMode,
} from '@/hooks/use-connect-mode'
import { useProxySelection } from '@/hooks/use-proxy-selection'
import { useTrafficData } from '@/hooks/use-traffic-data'
import { useVerge } from '@/hooks/use-verge'
import { useVisibility } from '@/hooks/use-visibility'
import { useAppData } from '@/providers/app-data-context'
import {
  formatUsagePairLabel,
  getAccountRefreshFailureState,
  shouldShowRefreshFailureNotice,
} from '@/services/account-display-state'
import {
  ACCOUNT_LKG_CHANGED_EVENT,
  readAccountLkgCache,
  writeAccountLkgCache,
} from '@/services/account-lkg-cache'
import {
  api,
  isTrafficExceededError,
  isSubscriptionActiveNow,
  type Node,
  type PublicBenefitStatus,
  type UsageData,
} from '@/services/api'
import { authStore } from '@/services/auth-store'
import {
  formatNodeLatencyLabel,
  getNodeLatencyChipColor,
} from '@/services/node-latency-display'
import { showNotice } from '@/services/notice-service'
import { runResumeRecovery } from '@/services/resume-recovery'
import {
  classifyClientError,
  reportSafeClientFailure,
  toSafeClientErrorMessage,
} from '@/services/safe-client-error'
import {
  checkSelectedNodeReadiness,
  getReadinessFailureDisconnectPayload,
  isSelectedNodeConnected,
  shouldAutoSelectNode,
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

type ProxyEntry = {
  name: string
  type?: string
  now?: string
  all?: Array<ProxyEntry | string> | string[]
  history?: { time: string; delay: number }[]
}

type DisplayProxyEntry = ProxyEntry & {
  displayName: string
}

const getLatency = (entry: ProxyEntry | undefined): number | undefined => {
  const history = entry?.history
  if (!history || history.length === 0) return undefined
  const last = history[history.length - 1]
  if (!last || typeof last.delay !== 'number' || last.delay < 0)
    return undefined
  return last.delay
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

const resolveVisibleProxyName = (
  records: Record<string, ProxyEntry> | undefined,
  name: string,
): string => {
  const leaf = resolveLeafProxyName(records, name)
  if (!isHiddenProxyEntry(leaf, records?.[leaf])) return leaf
  return ''
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

const toPeriodUsageState = (usage: UsageData): PeriodUsageState => {
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
  const navigate = useNavigate()
  const pageVisible = useVisibility()
  const { verge, patchVerge } = useVerge()
  const { patchClash } = useClash()
  const { proxies, refreshProxy } = useAppData()
  const currentUserId = authStore.getState().user?.id ?? null
  const initialAccountCache = useMemo(
    () => readAccountLkgCache(currentUserId),
    [currentUserId],
  )
  const { changeProxy } = useProxySelection({
    onSuccess: () => refreshProxy(),
    onError: (error) =>
      reportSafeClientFailure('connect-proxy-selection', error),
    forceConnectionCleanup: true,
  })
  const handleProxyControlError = useCallback(
    (error: unknown) => {
      reportSafeClientFailure('connect-proxy-control', error)
      showNotice.error(
        toSafeClientErrorMessage(classifyClientError(error).kind, t),
      )
    },
    [t],
  )

  const [mode, setMode] = useState<ConnectMode>(() => loadConnectMode())
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
  const [publicBenefit, setPublicBenefit] =
    useState<PublicBenefitStatus | null>(
      () => initialAccountCache?.publicBenefit ?? null,
    )
  const [periodUsage, setPeriodUsage] = useState<PeriodUsageState | null>(() =>
    initialAccountCache?.usage
      ? toPeriodUsageState(initialAccountCache.usage)
      : null,
  )
  const [accountNodes, setAccountNodes] = useState<Node[]>(
    () => initialAccountCache?.nodes ?? [],
  )
  const [nodeMenuAnchor, setNodeMenuAnchor] = useState<HTMLElement | null>(null)
  const [modeChanging, setModeChanging] = useState(false)
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
  const lastTrafficSampleRef = useRef<{
    ts: number
    up: number
    down: number
  } | null>(null)

  const refreshAccountState = useCallback(async () => {
    const [subscriptionResult, benefitResult, usageResult, nodesResult] =
      await Promise.allSettled([
        api.subscription.current(),
        api.user.publicBenefit(),
        api.user.usage(),
        api.nodes.list(),
      ])

    const refreshFailureState = getAccountRefreshFailureState({
      subscriptionFailed: subscriptionResult.status === 'rejected',
      benefitFailed: benefitResult.status === 'rejected',
      usageFailed: usageResult.status === 'rejected',
      nodesFailed: nodesResult.status === 'rejected',
    })

    setAccountRefreshFailed(refreshFailureState.accountDataRefreshFailed)
    setNodeRefreshFailed(refreshFailureState.nodeListRefreshFailed)

    if (subscriptionResult.status === 'fulfilled') {
      setHasSubscription(isSubscriptionActiveNow(subscriptionResult.value))
    }
    if (benefitResult.status === 'fulfilled') {
      setPublicBenefit(benefitResult.value)
    }
    if (usageResult.status === 'fulfilled') {
      setPeriodUsage(toPeriodUsageState(usageResult.value))
    }
    if (nodesResult.status === 'fulfilled') {
      setAccountNodes(nodesResult.value)
    }
    const userId = authStore.getState().user?.id
    if (userId) {
      writeAccountLkgCache(userId, {
        subscription:
          subscriptionResult.status === 'fulfilled'
            ? subscriptionResult.value
            : undefined,
        publicBenefit:
          benefitResult.status === 'fulfilled'
            ? benefitResult.value
            : undefined,
        usage:
          usageResult.status === 'fulfilled' ? usageResult.value : undefined,
        nodes:
          nodesResult.status === 'fulfilled' ? nodesResult.value : undefined,
      })
    }
  }, [])

  // Probe current subscription status every time the page becomes visible.
  // This ensures users who buy a plan on /plans and return to Connect see
  // the refresh button appear. Failure => treat as "no subscription"
  // (safer default — hide the refresh button).
  useEffect(() => {
    if (!pageVisible) return
    let cancelled = false
    void runResumeRecovery('connect-visible')
    refreshAccountState()
      .then(() => {
        if (cancelled) return
      })
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
    }
    window.addEventListener(ACCOUNT_LKG_CHANGED_EVENT, applyCache)
    return () =>
      window.removeEventListener(ACCOUNT_LKG_CHANGED_EVENT, applyCache)
  }, [])

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

  const tunEnabled = verge?.enable_tun_mode ?? false
  const sysEnabled = verge?.enable_system_proxy ?? false

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

  // GLOBAL group for simple one-click node selection
  const globalGroup = proxies?.global as
    | {
        name?: string
        now?: string
        all?: Array<ProxyEntry | string>
      }
    | undefined
  const proxyRecords = proxies?.records as
    | Record<string, ProxyEntry>
    | undefined

  const currentNode = globalGroup?.now || ''
  const currentRuntimeNode = useMemo(
    () => resolveLeafProxyName(proxyRecords, currentNode),
    [currentNode, proxyRecords],
  )

  const nodeEntries = useMemo<DisplayProxyEntry[]>(() => {
    const all = globalGroup?.all || []
    const byKey = new Map<string, DisplayProxyEntry>()

    for (const item of all) {
      const entry =
        typeof item === 'string'
          ? ({ name: item } as ProxyEntry)
          : (item as ProxyEntry)
      if (
        !entry ||
        typeof entry.name !== 'string' ||
        isHiddenProxyEntry(entry.name, proxyRecords?.[entry.name] ?? entry)
      ) {
        continue
      }

      const displayName = getProxyDisplayName(entry.name)
      const key = getProxyDisplayKey(entry.name)
      if (!displayName) continue

      const existing = byKey.get(key)
      if (!existing || entry.name === currentNode) {
        byKey.set(key, { ...entry, displayName })
      }
    }

    return Array.from(byKey.values())
  }, [currentNode, globalGroup?.all, proxyRecords])

  const nodeOptions = useMemo(
    () => nodeEntries.map((entry) => entry.displayName),
    [nodeEntries],
  )

  const currentNodeDisplay = useMemo(() => {
    const match = nodeEntries.find((entry) => entry.name === currentNode)
    if (match?.displayName) return match.displayName

    const visibleLeaf = resolveVisibleProxyName(proxyRecords, currentNode)
    return visibleLeaf ? getProxyDisplayName(visibleLeaf) : ''
  }, [currentNode, nodeEntries, proxyRecords])

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

  const latencyMap = useMemo(() => {
    const map = new Map<string, number>()
    for (const entry of nodeEntries) {
      const delay = getLatency(entry)
      if (delay !== undefined) map.set(entry.displayName, delay)
    }
    return map
  }, [nodeEntries])
  const latencyTimeoutMs = verge?.default_latency_timeout || 10000

  const isEmpty = nodeOptions.length === 0

  // Auto-select "auto" (url-test) when the current GLOBAL selection is empty
  // or has been filtered out of the visible list (e.g. raw "proxy" group).
  // Self-healing: re-fires whenever the selection becomes invalid (e.g. after
  // a force-rebuild) but is idempotent when the current selection is valid.
  useEffect(() => {
    const groupName = globalGroup?.name
    if (!groupName) return
    const currentSelectionValid = Boolean(
      currentNode && nodeEntries.some((entry) => entry.name === currentNode),
    )
    if (
      !shouldAutoSelectNode({
        runtimeConnected,
        groupName,
        nodeCount: nodeEntries.length,
        currentSelectionValid,
      })
    )
      return
    const target =
      nodeEntries.find((entry) => entry.displayName.toLowerCase() === 'auto') ??
      nodeEntries[0]
    if (target && target.name !== currentNode) {
      changeProxy(groupName, target.name, currentNode, true)
    }
  }, [
    runtimeConnected,
    globalGroup?.name,
    nodeEntries,
    currentNode,
    changeProxy,
  ])

  const triggerErrorFlash = useCallback(() => {
    setErrorFlash(true)
    if (errorTimerRef.current) clearTimeout(errorTimerRef.current)
    errorTimerRef.current = setTimeout(() => setErrorFlash(false), 2000)
  }, [])

  const handleModeChange = useCallback(
    (next: ConnectMode) => {
      if (next === mode || modeChanging) return

      const previousMode = mode
      setMode(next)
      persistConnectMode(next)

      const payload = runtimeConnected
        ? getConnectModePayload(next, true)
        : ({ connect_mode: next } as Partial<IVergeConfig>)
      const rollbackPayload = runtimeConnected
        ? getConnectModePayload(previousMode, true)
        : ({ connect_mode: previousMode } as Partial<IVergeConfig>)

      void (async () => {
        try {
          setModeChanging(true)
          if (runtimeConnected) {
            await patchClash({ mode: next === 'smart' ? 'rule' : 'global' })
          }
          await patchVerge(payload)
          await refreshProxy()
        } catch (error) {
          setMode(previousMode)
          persistConnectMode(previousMode)

          try {
            if (runtimeConnected) {
              await patchClash({
                mode: previousMode === 'smart' ? 'rule' : 'global',
              })
            }
            await patchVerge(rollbackPayload)
            await refreshProxy()
          } catch (rollbackError) {
            reportSafeClientFailure('connect-mode-rollback', rollbackError)
          }

          reportSafeClientFailure('connect-mode-change', error)
          showNotice.error(
            toSafeClientErrorMessage(classifyClientError(error).kind, t),
          )
          triggerErrorFlash()
        } finally {
          setModeChanging(false)
        }
      })()
    },
    [
      mode,
      modeChanging,
      patchClash,
      patchVerge,
      refreshProxy,
      runtimeConnected,
      t,
      triggerErrorFlash,
    ],
  )

  const handleNodeMenuOpen = useCallback(
    (event: MouseEvent<HTMLElement>) => {
      if (busy || modeChanging) return
      setNodeMenuAnchor(event.currentTarget)
    },
    [busy, modeChanging],
  )

  const handleNodeMenuClose = useCallback(() => {
    setNodeMenuAnchor(null)
  }, [])

  const handleNodeSelect = useCallback(
    (entry: DisplayProxyEntry) => {
      handleNodeMenuClose()
      if (busy || modeChanging) return
      if (!globalGroup?.name || entry.name === currentNode) return
      changeProxy(
        globalGroup.name,
        entry.name,
        currentRuntimeNode || currentNode,
      )
    },
    [
      changeProxy,
      currentNode,
      currentRuntimeNode,
      busy,
      globalGroup?.name,
      handleNodeMenuClose,
      modeChanging,
    ],
  )

  const stopFailedReadinessConnection = useCallback(
    async (attempt: number) => {
      try {
        await patchVerge({
          ...getReadinessFailureDisconnectPayload(),
          connect_mode: mode,
        })
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
    [mode, patchVerge, refreshProxy, t],
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

    if (result.ok) {
      setReadinessStatus('ready')
      return true
    }

    setReadinessStatus('ready')
    return true
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
      busy ||
      modeChanging ||
      readinessStatus === 'connecting' ||
      readinessStatus === 'validating'
    )
      return
    setBusy(true)
    try {
      const next = !runtimeConnected
      const payload: Partial<IVergeConfig> = {}
      if (mode === 'system') {
        payload.enable_tun_mode = false
        payload.enable_system_proxy = next
      } else {
        // Full VPN and Smart Split both need TUN so desktop apps are covered.
        payload.enable_tun_mode = next
        payload.enable_system_proxy = next
      }
      if (next) {
        setReadinessStatus('connecting')
        await refreshAccountState()
        await patchClash({ mode: mode === 'smart' ? 'rule' : 'global' })
      } else {
        readinessAttemptRef.current += 1
        lastReadinessNodeRef.current = null
        setReadinessStatus('disconnected')
      }
      await patchVerge({ ...payload, connect_mode: mode })
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

  const disconnectForTrafficExceeded = useCallback(async () => {
    setBusy(true)
    try {
      await patchVerge({
        enable_tun_mode: false,
        enable_system_proxy: false,
      })
      readinessAttemptRef.current += 1
      lastReadinessNodeRef.current = null
      setReadinessStatus('disconnected')
      updateConnectionSession({ type: 'stop' })
      heartbeatTrafficRef.current = { up: 0, down: 0 }
      lastTrafficSampleRef.current = null
      await refreshProxy()
      await refreshAccountState()
      showNotice.error('layout.components.connect.feedback.trafficExceeded')
    } catch (error) {
      reportSafeClientFailure('connect-traffic-exceeded-disconnect', error)
      showNotice.error('layout.components.connect.feedback.trafficExceeded')
    } finally {
      setBusy(false)
    }
  }, [patchVerge, refreshAccountState, refreshProxy])

  useEffect(() => {
    if (!connected || !currentNodeId) return
    const reportHeartbeat = async () => {
      const bytes = heartbeatTrafficRef.current
      const bytesUp = Math.floor(bytes.up)
      const bytesDown = Math.floor(bytes.down)
      heartbeatTrafficRef.current = {
        up: Math.max(0, bytes.up - bytesUp),
        down: Math.max(0, bytes.down - bytesDown),
      }
      try {
        await api.traffic.report({
          nodeId: currentNodeId,
          bytes_up: bytesUp,
          bytes_down: bytesDown,
          timestamp: Date.now(),
        })
        const usage = await api.user.usage().catch(() => null)
        if (usage) setPeriodUsage(toPeriodUsageState(usage))
      } catch (error) {
        if (isTrafficExceededError(error)) {
          await disconnectForTrafficExceeded()
          return
        }
        heartbeatTrafficRef.current = {
          up: heartbeatTrafficRef.current.up + bytesUp,
          down: heartbeatTrafficRef.current.down + bytesDown,
        }
        reportSafeClientFailure('connect-traffic-heartbeat', error)
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
  }, [connected, currentNodeId, disconnectForTrafficExceeded])

  const connectionBusy =
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
    switch (readinessStatus) {
      case 'connecting':
        return t('layout.components.connect.labels.connecting')
      case 'validating':
        return t('layout.components.connect.labels.validating')
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
  }, [isEmpty, readinessStatus, showReadinessFailure, t])

  // Button colors
  const getButtonColor = () => {
    if (showReadinessFailure) return theme.palette.error.main
    if (connectionBusy) return theme.palette.warning.main
    if (connected) return theme.palette.success.main
    return theme.palette.primary.main
  }

  const buttonColor = getButtonColor()
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
  const hasNodeFallbackData = accountNodes.length > 0 || nodeOptions.length > 0
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
  const sessionTrafficLabel = formatTrafficTotal(
    connectionSession.traffic.up + connectionSession.traffic.down,
  )
  const periodTrafficLimit = periodUsage?.limit ?? 0
  const periodTrafficPct = periodUsage?.percentUsed ?? 0
  const periodTrafficLabel = formatUsagePairLabel({
    usageKnown: periodUsage !== null,
    usedLabel: formatTrafficTotal(periodUsage?.used ?? 0),
    limitLabel:
      periodTrafficLimit > 0 ? formatTrafficTotal(periodTrafficLimit) : null,
    unknownLabel: t('layout.components.connect.session.usageUnavailable'),
  })

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
          maxWidth: 860,
          mx: 'auto',
          py: 0.5,
          height: '100%',
          boxSizing: 'border-box',
          justifyContent: 'center',
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
                sx={{ borderRadius: 3 }}
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
              <Alert severity="warning" sx={{ borderRadius: 3 }}>
                {t('layout.components.connect.trial.trafficExceeded')}
              </Alert>
            )}
            {hasSubscription === true && startupSyncError && (
              <Alert
                severity="error"
                onClose={handleDismissStartupSyncError}
                sx={{ cursor: 'pointer', borderRadius: 3 }}
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
              <Alert severity="warning" sx={{ borderRadius: 3 }}>
                {t('layout.components.connect.feedback.accountRefreshFailed')}
              </Alert>
            )}
            {showNodeRefreshNotice && (
              <Alert severity="warning" sx={{ borderRadius: 3 }}>
                {t('layout.components.connect.feedback.nodeRefreshFailed')}
              </Alert>
            )}
          </Stack>
        )}

        <Paper
          elevation={0}
          sx={{
            position: 'relative',
            p: { xs: 1.5, md: 2.25 },
            borderRadius: 5,
            overflow: 'visible',
            border: `1px solid ${alpha(theme.palette.common.white, 0.08)}`,
            background:
              theme.palette.mode === 'dark'
                ? 'radial-gradient(circle at 88% 2%, rgba(15,237,210,0.16), transparent 32%), radial-gradient(circle at 4% 100%, rgba(47,128,237,0.14), transparent 28%), rgba(7,16,24,0.97)'
                : 'linear-gradient(135deg,#ffffff,#f2fbff)',
          }}
        >
          <Stack
            direction={{ xs: 'column', md: 'row' }}
            spacing={2}
            justifyContent="space-between"
            alignItems={{ xs: 'stretch', md: 'flex-start' }}
            sx={{ mb: 1.5 }}
          >
            <Box>
              <Typography
                variant="overline"
                sx={{ color: 'primary.light', fontWeight: 900 }}
              >
                XXLink
              </Typography>
              <Typography variant="h5" fontWeight={950}>
                {t('layout.components.connect.labels.heroTitle')}
              </Typography>
              <Typography
                variant="body2"
                color="text.secondary"
                sx={{ mt: 0.25 }}
              >
                {t('layout.components.connect.labels.heroSubtitle')}
              </Typography>
            </Box>
            <ButtonGroup
              size="small"
              sx={{
                alignSelf: { xs: 'flex-start', md: 'center' },
                p: 0.5,
                borderRadius: 999,
                bgcolor: alpha(theme.palette.primary.main, 0.09),
                '& .MuiButton-root': {
                  border: '0 !important',
                  borderRadius: '999px !important',
                  px: 2,
                  fontWeight: 900,
                },
              }}
            >
              <Button
                variant={mode === 'system' ? 'contained' : 'text'}
                onClick={() => handleModeChange('system')}
                disabled={modeChanging}
              >
                {t('layout.components.connect.mode.system')}
              </Button>
              <Button
                variant={mode === 'both' ? 'contained' : 'text'}
                onClick={() => handleModeChange('both')}
                disabled={modeChanging}
              >
                {t('layout.components.connect.mode.both')}
              </Button>
              <Button
                variant={mode === 'smart' ? 'contained' : 'text'}
                onClick={() => handleModeChange('smart')}
                disabled={modeChanging}
              >
                {t('layout.components.connect.mode.smart')}
              </Button>
            </ButtonGroup>
          </Stack>

          <Paper
            elevation={0}
            sx={{
              p: { xs: 1.75, md: 2.25 },
              mb: 1.25,
              borderRadius: 4,
              border: 'none',
              background: 'transparent',
            }}
          >
            <Stack direction="column" spacing={1.25} alignItems="center">
              <Button
                onClick={handleToggle}
                disabled={connectionBusy || isEmpty}
                sx={{
                  width: 104,
                  height: 104,
                  minWidth: 104,
                  borderRadius: '50%',
                  bgcolor: buttonColor,
                  color: theme.palette.getContrastText(buttonColor),
                  border: `10px solid ${alpha(theme.palette.common.white, theme.palette.mode === 'dark' ? 0.08 : 0.72)}`,
                  transition: 'all 0.28s ease-in-out',
                  boxShadow: connected
                    ? `0 0 0 18px ${alpha(theme.palette.success.main, 0.12)}`
                    : `0 0 0 18px ${alpha(theme.palette.primary.main, 0.08)}`,
                  animation: connectionBusy ? `${pulse} 1.4s infinite` : 'none',
                  '&:hover': {
                    bgcolor: buttonColor,
                    filter: 'brightness(1.08)',
                  },
                  '&.Mui-disabled': {
                    bgcolor: isEmpty
                      ? theme.palette.action.disabledBackground
                      : buttonColor,
                    color: isEmpty
                      ? theme.palette.action.disabled
                      : theme.palette.getContrastText(buttonColor),
                    opacity: connectionBusy ? 0.75 : 0.9,
                  },
                }}
              >
                {connectionBusy ? (
                  <CircularProgress
                    size={38}
                    thickness={4}
                    sx={{ color: 'inherit' }}
                  />
                ) : (
                  <PowerSettingsNewRounded sx={{ fontSize: 46 }} />
                )}
              </Button>

              <Box sx={{ minWidth: 0, flex: 1, textAlign: 'center' }}>
                <Typography
                  variant="h4"
                  fontWeight={950}
                  color={
                    errorFlash
                      ? 'error.main'
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
                  color="text.secondary"
                  sx={{
                    mt: 0.5,
                    mb: isEmpty || showReadinessFailure ? 1.5 : 0,
                  }}
                >
                  {connectionStatusHint}
                </Typography>
                {isEmpty ? (
                  <Button
                    variant="contained"
                    size="large"
                    onClick={() => navigate('/plans')}
                    sx={{ borderRadius: 2.5, px: 4, fontWeight: 950 }}
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
                    sx={{ borderRadius: 2.5, fontWeight: 850 }}
                  >
                    {t('layout.components.connect.actions.retry')}
                  </Button>
                ) : null}
              </Box>

              <Box
                sx={{
                  display: 'grid',
                  gridTemplateColumns: {
                    xs: '1fr',
                    sm: 'repeat(2, minmax(0, 1fr))',
                  },
                  gap: 0.5,
                  width: '100%',
                  maxWidth: 560,
                  mt: 0.25,
                }}
              >
                <ProxyControlSwitches
                  kind="systemProxy"
                  onError={handleProxyControlError}
                />
                <ProxyControlSwitches
                  kind="tun"
                  onError={handleProxyControlError}
                />
              </Box>
            </Stack>
          </Paper>

          <Box
            sx={{
              display: 'grid',
              gridTemplateColumns: {
                xs: '1fr',
                md: 'repeat(3, minmax(0, 1fr))',
              },
              gap: 1.5,
              mb: 1.25,
            }}
          >
            {[
              {
                icon: <AccessTimeRounded color="primary" />,
                label: t('layout.components.connect.session.duration'),
                value: connected ? connectedDurationLabel : '0:00',
                color: 'text.primary',
              },
              {
                icon: <DataUsageRounded sx={{ color: 'primary.light' }} />,
                label: t('layout.components.connect.session.localTraffic'),
                value: connected ? sessionTrafficLabel : formatTrafficTotal(0),
                color: 'primary.light',
              },
              {
                icon: <DataUsageRounded color="success" />,
                label: t('layout.components.connect.session.packageTraffic'),
                value: periodTrafficLabel,
                color: 'success.main',
              },
            ].map((metric) => (
              <Paper
                key={metric.label}
                elevation={0}
                sx={{
                  p: 2,
                  borderRadius: 3,
                  border: `1px solid ${alpha(theme.palette.common.white, 0.08)}`,
                  bgcolor:
                    theme.palette.mode === 'dark'
                      ? 'rgba(24,27,36,0.96)'
                      : '#fff',
                }}
              >
                <Stack direction="row" spacing={1.2} alignItems="center">
                  {metric.icon}
                  <Box sx={{ minWidth: 0 }}>
                    <Typography variant="caption" color="text.secondary">
                      {metric.label}
                    </Typography>
                    <Typography
                      variant="h6"
                      fontWeight={950}
                      color={metric.color}
                      noWrap
                    >
                      {metric.value}
                    </Typography>
                  </Box>
                </Stack>
                {metric.label ===
                  t('layout.components.connect.session.packageTraffic') &&
                  periodTrafficLimit > 0 && (
                    <LinearProgress
                      variant="determinate"
                      value={periodTrafficPct}
                      sx={{
                        mt: 1.2,
                        height: 5,
                        borderRadius: 999,
                        bgcolor: alpha(theme.palette.success.main, 0.16),
                        '& .MuiLinearProgress-bar': { borderRadius: 999 },
                      }}
                    />
                  )}
              </Paper>
            ))}
          </Box>

          <Paper
            elevation={0}
            sx={{
              px: 2,
              py: 1.4,
              borderRadius: 3,
              border: `1px solid ${alpha(theme.palette.common.white, 0.08)}`,
              bgcolor:
                theme.palette.mode === 'dark' ? 'rgba(24,27,36,0.96)' : '#fff',
            }}
          >
            <Stack
              direction={{ xs: 'column', sm: 'row' }}
              spacing={1}
              justifyContent="space-between"
              alignItems={{ xs: 'stretch', sm: 'center' }}
            >
              <Stack direction="row" spacing={1} alignItems="center">
                <Typography variant="body2" color="text.secondary">
                  {t('layout.components.connect.labels.node')}
                </Typography>
                <Typography variant="body1" fontWeight={950} noWrap>
                  {currentNodeDisplay ||
                    t('layout.components.connect.labels.selectNode')}
                </Typography>
                {latencyMap.get(currentNodeDisplay) !== undefined && (
                  <Chip
                    size="small"
                    color={getNodeLatencyChipColor(
                      latencyMap.get(currentNodeDisplay)!,
                      latencyTimeoutMs,
                    )}
                    label={formatNodeLatencyLabel(
                      latencyMap.get(currentNodeDisplay)!,
                      latencyTimeoutMs,
                      {
                        timeout: t('layout.components.nodes.delay.timeout'),
                        unknown: t('layout.components.nodes.delay.notTested'),
                      },
                    )}
                  />
                )}
              </Stack>
              <Stack direction="row" spacing={1} alignItems="center">
                <Typography
                  variant="caption"
                  color="text.secondary"
                  sx={{ fontVariantNumeric: 'tabular-nums' }}
                >
                  ↑ {upVal} {upUnit}/s · ↓ {downVal} {downUnit}/s
                </Typography>
                <Button
                  size="small"
                  variant="outlined"
                  endIcon={<KeyboardArrowDownRounded />}
                  onClick={handleNodeMenuOpen}
                  disabled={busy || modeChanging || isEmpty}
                  sx={{ borderRadius: 999, fontWeight: 950 }}
                >
                  {t('layout.components.connect.actions.switchNode')}
                </Button>
              </Stack>
            </Stack>
            <Menu
              anchorEl={nodeMenuAnchor}
              open={Boolean(nodeMenuAnchor)}
              onClose={handleNodeMenuClose}
              slotProps={{
                paper: {
                  sx: {
                    mt: 1,
                    minWidth: 280,
                    maxHeight: 360,
                    borderRadius: 3,
                  },
                },
              }}
            >
              {nodeEntries.map((entry) => {
                const selected = entry.name === currentNode
                const delay = latencyMap.get(entry.displayName)
                return (
                  <MenuItem
                    key={`${entry.name}:${entry.displayName}`}
                    selected={selected}
                    disabled={selected}
                    onClick={() => handleNodeSelect(entry)}
                  >
                    <ListItemText
                      primary={entry.displayName}
                      secondary={
                        delay !== undefined
                          ? formatNodeLatencyLabel(delay, latencyTimeoutMs, {
                              timeout: t(
                                'layout.components.nodes.delay.timeout',
                              ),
                              unknown: t(
                                'layout.components.nodes.delay.notTested',
                              ),
                            })
                          : t('layout.components.nodes.delay.notTested')
                      }
                      primaryTypographyProps={{ fontWeight: 900, noWrap: true }}
                    />
                  </MenuItem>
                )
              })}
            </Menu>
          </Paper>
        </Paper>
      </Stack>
    </BasePage>
  )
}

export default ConnectPage
