import {
  ArrowDownwardRounded,
  ArrowUpwardRounded,
  InfoOutlineRounded,
  PowerSettingsNewRounded,
  RefreshRounded,
} from '@mui/icons-material'
import {
  Autocomplete,
  Box,
  Button,
  ButtonGroup,
  Chip,
  CircularProgress,
  Paper,
  Stack,
  TextField,
  Tooltip,
  Typography,
  alpha,
  keyframes,
  useTheme,
} from '@mui/material'
import { useLockFn } from 'ahooks'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useNavigate } from 'react-router'

import { BasePage } from '@/components/base'
import { useProxySelection } from '@/hooks/use-proxy-selection'
import { useTrafficData } from '@/hooks/use-traffic-data'
import { useVerge } from '@/hooks/use-verge'
import { useVisibility } from '@/hooks/use-visibility'
import { useAppData } from '@/providers/app-data-context'
import { showNotice } from '@/services/notice-service'
import { syncSubscription } from '@/services/subscription-sync'
import parseTraffic from '@/utils/parse-traffic'

type ConnectMode = 'system' | 'tun' | 'both'

const MODE_STORAGE_KEY = 'xxlink:connect-mode'
const DEFAULT_MODE: ConnectMode = 'both'

// Names to exclude from the node dropdown (case-insensitive).
// "proxy" is the raw manual-selection group the upstream ships; end users
// should just use "auto" (url-test) which picks the best node automatically.
const HIDDEN_NODES: ReadonlySet<string> = new Set(['direct', 'reject', 'proxy'])

const loadMode = (): ConnectMode => {
  try {
    const saved = localStorage.getItem(MODE_STORAGE_KEY)
    if (saved === 'system' || saved === 'tun' || saved === 'both') {
      return saved
    }
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

const getLatency = (entry: ProxyEntry | undefined): number | undefined => {
  const history = entry?.history
  if (!history || history.length === 0) return undefined
  const last = history[history.length - 1]
  if (!last || typeof last.delay !== 'number' || last.delay <= 0)
    return undefined
  return last.delay
}

const ConnectPage = () => {
  const { t } = useTranslation()
  const theme = useTheme()
  const navigate = useNavigate()
  const pageVisible = useVisibility()
  const { verge, patchVerge } = useVerge()
  const { proxies, refreshProxy } = useAppData()
  const { changeProxy } = useProxySelection({
    onSuccess: () => refreshProxy(),
    onError: (error) => console.error('[Connect] proxy change failed', error),
  })

  const [mode, setMode] = useState<ConnectMode>(() => loadMode())
  const [busy, setBusy] = useState(false)
  const [errorFlash, setErrorFlash] = useState(false)
  const [refreshing, setRefreshing] = useState(false)
  const errorTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  const tunEnabled = verge?.enable_tun_mode ?? false
  const sysEnabled = verge?.enable_system_proxy ?? false

  // Connected state per selected mode
  const connected = useMemo(() => {
    switch (mode) {
      case 'tun':
        return tunEnabled
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
  } = useTrafficData({ enabled: connected && pageVisible })

  const [upVal, upUnit] = parseTraffic(traffic?.up || 0)
  const [downVal, downUnit] = parseTraffic(traffic?.down || 0)

  // GLOBAL group for simple one-click node selection
  const globalGroup = proxies?.global as
    | {
        name?: string
        now?: string
        all?: Array<ProxyEntry | string>
      }
    | undefined

  const currentNode = globalGroup?.now || ''

  const nodeEntries = useMemo<ProxyEntry[]>(() => {
    const all = globalGroup?.all || []
    return all
      .map((item) =>
        typeof item === 'string'
          ? ({ name: item } as ProxyEntry)
          : (item as ProxyEntry),
      )
      .filter(
        (entry): entry is ProxyEntry =>
          !!entry &&
          typeof entry.name === 'string' &&
          entry.name.length > 0 &&
          !HIDDEN_NODES.has(entry.name.toLowerCase()),
      )
  }, [globalGroup?.all])

  const nodeOptions = useMemo(
    () => nodeEntries.map((entry) => entry.name),
    [nodeEntries],
  )

  const latencyMap = useMemo(() => {
    const map = new Map<string, number>()
    for (const entry of nodeEntries) {
      const delay = getLatency(entry)
      if (delay !== undefined) map.set(entry.name, delay)
    }
    return map
  }, [nodeEntries])

  const isEmpty = nodeOptions.length === 0

  // Auto-select "auto" (url-test) when the current GLOBAL selection is empty
  // or has been filtered out of the visible list (e.g. raw "proxy" group).
  const autoSelectedRef = useRef(false)
  useEffect(() => {
    if (autoSelectedRef.current) return
    if (!globalGroup?.name || nodeOptions.length === 0) return
    const currentValid = currentNode && nodeOptions.includes(currentNode)
    if (currentValid) return
    const autoOption = nodeOptions.find((n) => n.toLowerCase() === 'auto')
    const target = autoOption ?? nodeOptions[0]
    if (!target) return
    autoSelectedRef.current = true
    changeProxy(globalGroup.name, target, currentNode, true)
  }, [globalGroup?.name, nodeOptions, currentNode, changeProxy])

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
      if (mode === 'tun') {
        payload.enable_tun_mode = next
        payload.enable_system_proxy = false
      } else if (mode === 'system') {
        payload.enable_tun_mode = false
        payload.enable_system_proxy = next
      } else {
        // both
        payload.enable_tun_mode = next
        payload.enable_system_proxy = next
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
      changeProxy(globalGroup.name, newProxy, currentNode, true)
    },
    [changeProxy, currentNode, globalGroup?.name],
  )

  const handleRefresh = useLockFn(async () => {
    if (refreshing) return
    setRefreshing(true)
    try {
      await syncSubscription()
      await refreshProxy()
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

  // Button colors
  const getButtonColor = () => {
    if (errorFlash) return theme.palette.error.main
    if (busy) return theme.palette.warning.main
    if (connected) return theme.palette.success.main
    return theme.palette.grey[500]
  }

  const buttonColor = getButtonColor()

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
        {isEmpty ? (
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
                {t('layout.components.connect.empty.title')}
              </Typography>
              <Typography variant="body2" color="text.secondary">
                {t('layout.components.connect.empty.subtitle')}
              </Typography>
              <Stack direction="row" spacing={2} sx={{ pt: 1 }}>
                <Button variant="contained" onClick={() => navigate('/plans')}>
                  {t('layout.components.connect.empty.goToPlans')}
                </Button>
                <Button
                  variant="outlined"
                  onClick={handleRefresh}
                  disabled={refreshing}
                  startIcon={
                    refreshing ? (
                      <CircularProgress size={16} />
                    ) : (
                      <RefreshRounded />
                    )
                  }
                >
                  {refreshing
                    ? t('layout.components.connect.empty.refreshing')
                    : t('layout.components.connect.empty.refresh')}
                </Button>
              </Stack>
            </Stack>
          </Paper>
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
              value={currentNode || undefined}
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
                  variant={mode === 'tun' ? 'contained' : 'outlined'}
                  onClick={() => handleModeChange('tun')}
                >
                  {t('layout.components.connect.mode.tun')}
                </Button>
                <Button
                  variant={mode === 'both' ? 'contained' : 'outlined'}
                  onClick={() => handleModeChange('both')}
                >
                  {t('layout.components.connect.mode.both')}
                </Button>
              </ButtonGroup>
            </Box>

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
