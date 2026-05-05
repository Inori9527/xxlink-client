import {
  AccessTimeRounded,
  ArrowDownwardRounded,
  ArrowUpwardRounded,
  DataUsageRounded,
  InfoOutlineRounded,
  PowerSettingsNewRounded,
  RefreshRounded,
} from '@mui/icons-material'
import {
  Alert,
  Autocomplete,
  Box,
  Button,
  ButtonGroup,
  Chip,
  CircularProgress,
  IconButton,
  LinearProgress,
  Paper,
  Stack,
  TextField,
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
import { useClash } from '@/hooks/use-clash'
import { useProxySelection } from '@/hooks/use-proxy-selection'
import { useTrafficData } from '@/hooks/use-traffic-data'
import { useVerge } from '@/hooks/use-verge'
import { useVisibility } from '@/hooks/use-visibility'
import { useAppData } from '@/providers/app-data-context'
import {
  api,
  isSubscriptionActiveNow,
  type PublicBenefitStatus,
} from '@/services/api'
import { showNotice } from '@/services/notice-service'
import { syncSubscription } from '@/services/subscription-sync'
import parseTraffic from '@/utils/parse-traffic'
import { getProxyDisplayName, getProxyDisplayKey } from '@/utils/proxy-display'

const STARTUP_SYNC_ERROR_KEY = 'xxlink:last-sync-error'
const STARTUP_SYNC_ERROR_TTL_MS = 5 * 60 * 1000
const DASHBOARD_URL = 'https://xxlink.net/dashboard'

type ConnectMode = 'system' | 'both'

const MODE_STORAGE_KEY = 'xxlink:connect-mode'
const DEFAULT_MODE: ConnectMode = 'both'

// Names to exclude from the node dropdown (case-insensitive).
// "proxy" is the raw manual-selection group the upstream ships; end users
// should just use "auto" (url-test) which picks the best node automatically.
const HIDDEN_NODES: ReadonlySet<string> = new Set(['direct', 'reject', 'proxy'])

const loadMode = (): ConnectMode => {
  try {
    const saved = localStorage.getItem(MODE_STORAGE_KEY)
    if (saved === 'system' || saved === 'both') {
      return saved
    }
    // Legacy 'tun' mode was removed — coerce to recommended default.
    if (saved === 'tun') return 'both'
  } catch {
    /* ignore */
  }
  return DEFAULT_MODE
}

const pulse = keyframes`
  0% { box-shadow: 0 0 0 0 rgba(255, 152, 0, 0.6); }
  70% { box-shadow: 0 0 0 22px rgba(255, 152, 0, 0); }
  100% { box-shadow: 0 0 0 0 rgba(255, 152, 0, 0); }
`

type ProxyEntry = {
  name: string
  history?: { time: string; delay: number }[]
}

type DisplayProxyEntry = ProxyEntry & {
  displayName: string
}

const getLatency = (entry: ProxyEntry | undefined): number | undefined => {
  const history = entry?.history
  if (!history || history.length === 0) return undefined
  const last = history[history.length - 1]
  if (!last || typeof last.delay !== 'number' || last.delay <= 0)
    return undefined
  return last.delay
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

const getBestTrafficLimit = (
  usage: PeriodUsageState | null,
  publicBenefit: PublicBenefitStatus | null,
): number => {
  const usageLimit = usage?.limit ?? 0
  if (usageLimit > 0) return usageLimit
  if (publicBenefit?.visible && publicBenefit.isTrial) {
    const activeBonusBytes = getNumericBytes(publicBenefit.activeBonusBytes)
    if (activeBonusBytes > 0) return activeBonusBytes
    if (publicBenefit.subscriptionCreated || publicBenefit.bonusGranted) {
      return getNumericBytes(publicBenefit.claimBytes)
    }
  }
  return 0
}

const ConnectPage = () => {
  const { t } = useTranslation()
  const theme = useTheme()
  const navigate = useNavigate()
  const pageVisible = useVisibility()
  const { verge, patchVerge } = useVerge()
  const { patchClash } = useClash()
  const { proxies, refreshProxy } = useAppData()
  const { changeProxy } = useProxySelection({
    onSuccess: () => refreshProxy(),
    onError: (error) => console.error('[Connect] proxy change failed', error),
  })

  const [mode, setMode] = useState<ConnectMode>(() => loadMode())
  const [busy, setBusy] = useState(false)
  const [errorFlash, setErrorFlash] = useState(false)
  const [refreshing, setRefreshing] = useState(false)
  const [hasSubscription, setHasSubscription] = useState<boolean | null>(null)
  const [publicBenefit, setPublicBenefit] =
    useState<PublicBenefitStatus | null>(null)
  const [periodUsage, setPeriodUsage] = useState<PeriodUsageState | null>(null)
  const [periodTrafficDelta, setPeriodTrafficDelta] = useState(0)
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
  const wasConnectedRef = useRef(false)
  const currentTrafficRateRef = useRef({ up: 0, down: 0 })
  const lastTrafficSampleRef = useRef<{
    ts: number
    up: number
    down: number
  } | null>(null)

  // Probe current subscription status every time the page becomes visible.
  // This ensures users who buy a plan on /plans and return to Connect see
  // the refresh button appear. Failure => treat as "no subscription"
  // (safer default — hide the refresh button).
  useEffect(() => {
    if (!pageVisible) return
    let cancelled = false
    Promise.allSettled([
      api.subscription.current(),
      api.user.publicBenefit(),
      api.user.usage(),
    ])
      .then(([subscriptionResult, benefitResult, usageResult]) => {
        if (cancelled) return
        if (subscriptionResult.status === 'fulfilled') {
          setHasSubscription(isSubscriptionActiveNow(subscriptionResult.value))
        } else {
          setHasSubscription(false)
        }
        if (benefitResult.status === 'fulfilled') {
          setPublicBenefit(benefitResult.value)
        }
        if (usageResult.status === 'fulfilled') {
          setPeriodUsage({
            used: getNumericBytes(usageResult.value.trafficUsed),
            limit: getNumericBytes(usageResult.value.trafficLimit),
          })
          setPeriodTrafficDelta(0)
        }
      })
      .catch(() => {
        if (!cancelled) setHasSubscription(false)
      })
    return () => {
      cancelled = true
    }
  }, [pageVisible])

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

  // Connected state per selected mode
  const connected = useMemo(() => {
    switch (mode) {
      case 'system':
        return sysEnabled
      case 'both':
        return tunEnabled || sysEnabled
      default:
        return false
    }
  }, [mode, tunEnabled, sysEnabled])

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
      lastTrafficSampleRef.current = {
        ts: now,
        up: currentTrafficRateRef.current.up,
        down: currentTrafficRateRef.current.down,
      }
    }

    if (!connected && wasConnectedRef.current) {
      updateConnectionSession({ type: 'stop' })
      lastTrafficSampleRef.current = null
    }

    wasConnectedRef.current = connected
  }, [connected])

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
      setPeriodTrafficDelta(
        (prev) =>
          prev +
          Math.max(0, last.up) * deltaSeconds +
          Math.max(0, last.down) * deltaSeconds,
      )
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

  const currentNode = globalGroup?.now || ''

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
        entry.name.length === 0 ||
        HIDDEN_NODES.has(entry.name.toLowerCase())
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
  }, [currentNode, globalGroup?.all])

  const nodeOptions = useMemo(
    () => nodeEntries.map((entry) => entry.displayName),
    [nodeEntries],
  )

  const displayToNodeMap = useMemo(() => {
    const map = new Map<string, string>()
    for (const entry of nodeEntries) {
      map.set(entry.displayName, entry.name)
    }
    return map
  }, [nodeEntries])

  const currentNodeDisplay = useMemo(() => {
    const match = nodeEntries.find((entry) => entry.name === currentNode)
    return (
      match?.displayName ??
      (currentNode ? getProxyDisplayName(currentNode) : '')
    )
  }, [currentNode, nodeEntries])

  const latencyMap = useMemo(() => {
    const map = new Map<string, number>()
    for (const entry of nodeEntries) {
      const delay = getLatency(entry)
      if (delay !== undefined) map.set(entry.displayName, delay)
    }
    return map
  }, [nodeEntries])

  const isEmpty = nodeOptions.length === 0

  // Auto-select "auto" (url-test) when the current GLOBAL selection is empty
  // or has been filtered out of the visible list (e.g. raw "proxy" group).
  // Self-healing: re-fires whenever the selection becomes invalid (e.g. after
  // a force-rebuild) but is idempotent when the current selection is valid.
  useEffect(() => {
    if (!globalGroup?.name || nodeEntries.length === 0) return
    if (currentNode && nodeEntries.some((entry) => entry.name === currentNode))
      return
    const target =
      nodeEntries.find((entry) => entry.displayName.toLowerCase() === 'auto') ??
      nodeEntries[0]
    if (target && target.name !== currentNode) {
      changeProxy(globalGroup.name, target.name, currentNode, true)
    }
  }, [globalGroup?.name, nodeEntries, currentNode, changeProxy])

  const handleModeChange = useCallback((next: ConnectMode) => {
    setMode(next)
    try {
      localStorage.setItem(MODE_STORAGE_KEY, next)
    } catch {
      /* ignore */
    }
  }, [])

  const triggerErrorFlash = useCallback(() => {
    setErrorFlash(true)
    if (errorTimerRef.current) clearTimeout(errorTimerRef.current)
    errorTimerRef.current = setTimeout(() => setErrorFlash(false), 2000)
  }, [])

  const handleToggle = useLockFn(async () => {
    if (busy) return
    setBusy(true)
    try {
      const next = !connected
      const payload: Partial<IVergeConfig> = {}
      if (mode === 'system') {
        payload.enable_tun_mode = false
        payload.enable_system_proxy = next
      } else {
        // both (recommended)
        payload.enable_tun_mode = next
        payload.enable_system_proxy = next
      }
      // When connecting, force Clash routing mode to `global` so the node
      // selected in the GLOBAL group actually carries traffic. Without this,
      // a `rule`-mode subscription would ignore our selection and route
      // through whatever the rules dictate (often a different country).
      if (next) {
        await patchClash({ mode: 'global' })
      }
      await patchVerge(payload)
    } catch (error) {
      console.error('[Connect] toggle failed', error)
      showNotice.error('layout.components.connect.feedback.toggleFailed', error)
      triggerErrorFlash()
    } finally {
      setBusy(false)
    }
  })

  const handleNodeChange = useCallback(
    (_event: unknown, newProxy: string | null) => {
      if (!newProxy || !globalGroup?.name) return
      const actualProxy = displayToNodeMap.get(newProxy) ?? newProxy
      changeProxy(globalGroup.name, actualProxy, currentNode, true)
    },
    [changeProxy, currentNode, displayToNodeMap, globalGroup?.name],
  )

  const handleRefresh = useLockFn(async () => {
    if (refreshing) return
    setRefreshing(true)
    try {
      await syncSubscription({ force: true })
      await refreshProxy()
      // Re-probe subscription status in case the user just bought a plan
      // outside the app (e.g. browser checkout) before hitting Refresh.
      try {
        const [sub, benefit] = await Promise.all([
          api.subscription.current(),
          api.user.publicBenefit().catch(() => null),
        ])
        setHasSubscription(isSubscriptionActiveNow(sub))
        if (benefit) setPublicBenefit(benefit)
        const usage = await api.user.usage().catch(() => null)
        if (usage) {
          setPeriodUsage({
            used: getNumericBytes(usage.trafficUsed),
            limit: getNumericBytes(usage.trafficLimit),
          })
          setPeriodTrafficDelta(0)
        }
      } catch {
        /* leave existing state */
      }
      try {
        localStorage.removeItem(STARTUP_SYNC_ERROR_KEY)
      } catch {
        /* ignore */
      }
      setStartupSyncError(false)
      showNotice.success('layout.components.connect.feedback.refreshed')
    } catch (error) {
      console.error('[Connect] refresh failed', error)
      showNotice.error(
        'layout.components.connect.feedback.refreshFailed',
        error,
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

  // Button colors
  const getButtonColor = () => {
    if (errorFlash) return theme.palette.error.main
    if (busy) return theme.palette.warning.main
    if (connected) return theme.palette.success.main
    return theme.palette.grey[500]
  }

  const buttonColor = getButtonColor()
  const trialNeedsClaim =
    publicBenefit?.visible === true &&
    publicBenefit.isTrial &&
    getNumericBytes(publicBenefit.activeBonusBytes) <= 0 &&
    !publicBenefit.subscriptionCreated &&
    !publicBenefit.bonusGranted

  const connectedDurationLabel = connectionSession.connectedAt
    ? formatDuration(durationNow - connectionSession.connectedAt)
    : '0:00'
  const realtimePeriodUsed = (periodUsage?.used ?? 0) + periodTrafficDelta
  const periodTrafficLimit = getBestTrafficLimit(periodUsage, publicBenefit)
  const periodTrafficPct =
    periodTrafficLimit > 0
      ? Math.min((realtimePeriodUsed / periodTrafficLimit) * 100, 100)
      : 0
  const periodTrafficLabel =
    periodTrafficLimit > 0
      ? `${formatTrafficTotal(realtimePeriodUsed)} / ${formatTrafficTotal(
          periodTrafficLimit,
        )}`
      : `${formatTrafficTotal(realtimePeriodUsed)} / --`

  const statusLabel = busy
    ? t('layout.components.connect.actions.connecting')
    : connected
      ? t('layout.components.connect.actions.clickToDisconnect')
      : t('layout.components.connect.actions.clickToConnect')

  const getChipColor = (delay: number): 'success' | 'warning' | 'error' => {
    if (delay < 200) return 'success'
    if (delay < 500) return 'warning'
    return 'error'
  }

  return (
    <BasePage title={t('layout.components.connect.title')}>
      <Stack
        spacing={4}
        alignItems="center"
        sx={{
          pt: 4,
          pb: 4,
          maxWidth: 480,
          mx: 'auto',
          width: '100%',
        }}
      >
        {hasSubscription === true && (
          <Box
            sx={{
              width: '100%',
              display: 'flex',
              justifyContent: 'flex-end',
              mb: -2,
            }}
          >
            <Tooltip title={t('layout.components.connect.empty.rebuild')}>
              <span>
                <IconButton
                  aria-label={t('layout.components.connect.empty.rebuild')}
                  onClick={handleRefresh}
                  disabled={refreshing}
                  sx={{
                    border: `1px solid ${alpha(theme.palette.divider, 0.7)}`,
                    bgcolor: alpha(theme.palette.primary.main, 0.06),
                    color: 'primary.main',
                    '&:hover': {
                      bgcolor: alpha(theme.palette.primary.main, 0.12),
                    },
                  }}
                >
                  {refreshing ? (
                    <CircularProgress size={20} />
                  ) : (
                    <RefreshRounded />
                  )}
                </IconButton>
              </span>
            </Tooltip>
          </Box>
        )}

        {trialNeedsClaim && (
          <Alert
            severity="info"
            sx={{ width: '100%', borderRadius: 2 }}
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

        {isEmpty ? (
          <>
            {hasSubscription === true && startupSyncError && (
              <Alert
                severity="error"
                onClose={handleDismissStartupSyncError}
                sx={{ width: '100%', cursor: 'pointer' }}
                onClick={handleRetryStartupSync}
                action={
                  <Button
                    size="small"
                    color="inherit"
                    onClick={(e) => {
                      e.stopPropagation()
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
            <Paper
              elevation={0}
              sx={{
                width: '100%',
                p: 4,
                borderRadius: 3,
                textAlign: 'center',
                bgcolor: alpha(theme.palette.primary.main, 0.04),
                border: `1px solid ${alpha(theme.palette.divider, 0.6)}`,
              }}
            >
              <Stack spacing={2} alignItems="center">
                <Typography variant="h6" sx={{ fontWeight: 600 }}>
                  {t(
                    trialNeedsClaim
                      ? 'layout.components.connect.trial.emptyTitle'
                      : 'layout.components.connect.empty.title',
                  )}
                </Typography>
                <Typography variant="body2" color="text.secondary">
                  {t(
                    trialNeedsClaim
                      ? 'layout.components.connect.trial.emptySubtitle'
                      : 'layout.components.connect.empty.subtitle',
                  )}
                </Typography>
                {hasSubscription !== true && !trialNeedsClaim && (
                  <Chip
                    size="small"
                    label={t('layout.components.connect.empty.noSubscription')}
                    color="default"
                    variant="outlined"
                  />
                )}
                <Stack direction="row" spacing={2} sx={{ pt: 1 }}>
                  <Button
                    variant="contained"
                    onClick={
                      trialNeedsClaim
                        ? handleOpenDashboard
                        : () => navigate('/plans')
                    }
                  >
                    {t(
                      trialNeedsClaim
                        ? 'layout.components.connect.trial.openDashboard'
                        : 'layout.components.connect.empty.goToPlans',
                    )}
                  </Button>
                </Stack>
              </Stack>
            </Paper>
          </>
        ) : (
          <>
            {/* Big round button */}
            <Box
              sx={{
                position: 'relative',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
              }}
            >
              <Button
                onClick={handleToggle}
                disabled={busy}
                sx={{
                  width: 180,
                  height: 180,
                  minWidth: 180,
                  borderRadius: '50%',
                  bgcolor: buttonColor,
                  color: theme.palette.getContrastText(buttonColor),
                  transition: 'all 0.3s ease-in-out',
                  boxShadow: connected
                    ? `0 0 28px 4px ${alpha(theme.palette.success.main, 0.45)}`
                    : `0 4px 16px ${alpha(theme.palette.common.black, 0.2)}`,
                  animation: busy ? `${pulse} 1.4s infinite` : 'none',
                  '&:hover': {
                    bgcolor: buttonColor,
                    filter: 'brightness(1.08)',
                  },
                  '&.Mui-disabled': {
                    bgcolor: buttonColor,
                    color: theme.palette.getContrastText(buttonColor),
                    opacity: busy ? 0.75 : 0.9,
                    cursor: busy ? 'wait' : 'default',
                    animation: busy ? `${pulse} 1.4s infinite` : 'none',
                  },
                }}
              >
                {busy ? (
                  <CircularProgress
                    size={56}
                    thickness={4}
                    sx={{ color: 'inherit' }}
                  />
                ) : (
                  <PowerSettingsNewRounded sx={{ fontSize: 72 }} />
                )}
              </Button>
            </Box>

            <Typography
              variant="h6"
              sx={{ fontWeight: 600, textAlign: 'center' }}
              color={
                errorFlash
                  ? 'error.main'
                  : connected
                    ? 'success.main'
                    : 'text.secondary'
              }
            >
              {statusLabel}
            </Typography>

            {/* Node selector (Autocomplete with latency chip) */}
            <Autocomplete
              fullWidth
              size="small"
              disableClearable
              options={nodeOptions}
              value={currentNodeDisplay || undefined}
              onChange={handleNodeChange}
              disabled={
                !globalGroup?.name ||
                nodeOptions.length === 0 ||
                connected ||
                busy
              }
              getOptionLabel={(option) => option ?? ''}
              renderOption={(props, option) => {
                const delay = latencyMap.get(option)
                const { key, ...liProps } = props as typeof props & {
                  key: string
                }
                return (
                  <li key={key ?? option} {...liProps}>
                    <Box
                      sx={{
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'space-between',
                        width: '100%',
                        gap: 1,
                      }}
                    >
                      <Typography
                        variant="body2"
                        sx={{
                          overflow: 'hidden',
                          textOverflow: 'ellipsis',
                          whiteSpace: 'nowrap',
                        }}
                      >
                        {option}
                      </Typography>
                      {delay !== undefined && (
                        <Chip
                          size="small"
                          label={`${delay}ms`}
                          color={getChipColor(delay)}
                          sx={{ height: 20, fontSize: 11 }}
                        />
                      )}
                    </Box>
                  </li>
                )
              }}
              renderInput={(params) => (
                <TextField
                  {...params}
                  placeholder={t('layout.components.connect.labels.selectNode')}
                  helperText={
                    connected
                      ? t('layout.components.connect.labels.disconnectFirst')
                      : undefined
                  }
                />
              )}
              slotProps={{
                listbox: { style: { maxHeight: 320 } },
                paper: { sx: { borderRadius: 2 } },
              }}
              sx={{ width: '100%' }}
            />

            {/* Mode selector */}
            <Box sx={{ width: '100%' }}>
              <Stack
                direction="row"
                spacing={0.5}
                alignItems="center"
                justifyContent="center"
                sx={{ mb: 1 }}
              >
                <Typography variant="caption" color="text.secondary">
                  {t('layout.components.connect.labels.mode')}
                </Typography>
                <Tooltip
                  title={t('layout.components.connect.modeTooltip')}
                  arrow
                  placement="top"
                >
                  <InfoOutlineRounded
                    sx={{
                      fontSize: 14,
                      color: 'text.secondary',
                      cursor: 'help',
                    }}
                  />
                </Tooltip>
              </Stack>
              <ButtonGroup fullWidth size="small">
                <Button
                  variant={mode === 'system' ? 'contained' : 'outlined'}
                  onClick={() => handleModeChange('system')}
                >
                  {t('layout.components.connect.mode.system')}
                </Button>
                <Button
                  variant={mode === 'both' ? 'contained' : 'outlined'}
                  onClick={() => handleModeChange('both')}
                >
                  {t('layout.components.connect.mode.both')}
                </Button>
              </ButtonGroup>
            </Box>

            <Stack
              direction={{ xs: 'column', sm: 'row' }}
              spacing={1.2}
              sx={{ width: '100%' }}
            >
              <Paper
                elevation={0}
                sx={{
                  flex: 1,
                  p: 1.5,
                  borderRadius: 2,
                  border: `1px solid ${alpha(theme.palette.divider, 0.7)}`,
                  bgcolor: alpha(theme.palette.primary.main, 0.04),
                }}
              >
                <Stack direction="row" spacing={1} alignItems="center">
                  <AccessTimeRounded color="primary" fontSize="small" />
                  <Box>
                    <Typography variant="caption" color="text.secondary">
                      {t('layout.components.connect.session.duration')}
                    </Typography>
                    <Typography variant="body2" fontWeight={800}>
                      {connected ? connectedDurationLabel : '0:00'}
                    </Typography>
                  </Box>
                </Stack>
              </Paper>

              <Paper
                elevation={0}
                sx={{
                  flex: 1,
                  p: 1.5,
                  borderRadius: 2,
                  border: `1px solid ${alpha(theme.palette.divider, 0.7)}`,
                  bgcolor: alpha(theme.palette.success.main, 0.05),
                }}
              >
                <Stack direction="row" spacing={1} alignItems="center">
                  <DataUsageRounded color="success" fontSize="small" />
                  <Box>
                    <Typography variant="caption" color="text.secondary">
                      {t('layout.components.connect.session.traffic')}
                    </Typography>
                    <Typography variant="body2" fontWeight={800}>
                      {periodTrafficLabel}
                    </Typography>
                    {periodTrafficLimit > 0 && (
                      <LinearProgress
                        variant="determinate"
                        value={periodTrafficPct}
                        sx={{
                          mt: 0.6,
                          height: 4,
                          borderRadius: 999,
                          bgcolor: alpha(theme.palette.success.main, 0.16),
                          '& .MuiLinearProgress-bar': {
                            borderRadius: 999,
                          },
                        }}
                      />
                    )}
                  </Box>
                </Stack>
              </Paper>
            </Stack>

            {/* Traffic */}
            <Stack
              direction="row"
              spacing={3}
              justifyContent="center"
              sx={{ width: '100%' }}
            >
              <Stack
                direction="row"
                alignItems="center"
                spacing={0.5}
                sx={{
                  minWidth: 96,
                  fontVariantNumeric: 'tabular-nums',
                  justifyContent: 'center',
                }}
              >
                <ArrowUpwardRounded
                  fontSize="small"
                  sx={{ color: theme.palette.secondary.main }}
                />
                <Typography
                  variant="body2"
                  fontWeight={600}
                  sx={{ fontVariantNumeric: 'tabular-nums' }}
                >
                  {upVal} {upUnit}/s
                </Typography>
              </Stack>
              <Stack
                direction="row"
                alignItems="center"
                spacing={0.5}
                sx={{
                  minWidth: 96,
                  fontVariantNumeric: 'tabular-nums',
                  justifyContent: 'center',
                }}
              >
                <ArrowDownwardRounded
                  fontSize="small"
                  sx={{ color: theme.palette.primary.main }}
                />
                <Typography
                  variant="body2"
                  fontWeight={600}
                  sx={{ fontVariantNumeric: 'tabular-nums' }}
                >
                  {downVal} {downUnit}/s
                </Typography>
              </Stack>
            </Stack>
          </>
        )}
      </Stack>
    </BasePage>
  )
}

export default ConnectPage
