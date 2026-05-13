import { CheckCircleRounded, SpeedRounded } from '@mui/icons-material'
import {
  Box,
  Button,
  Chip,
  CircularProgress,
  Paper,
  Stack,
  Typography,
  alpha,
  useTheme,
} from '@mui/material'
import { useLockFn } from 'ahooks'
import { useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'

import { BasePage } from '@/components/base'
import { useProxySelection } from '@/hooks/use-proxy-selection'
import { useVerge } from '@/hooks/use-verge'
import { useAppData } from '@/providers/app-data-context'
import delayManager from '@/services/delay'
import { showNotice } from '@/services/notice-service'
import { getProxyDisplayKey, getProxyDisplayName } from '@/utils/proxy-display'

type ProxyEntry = {
  name: string
  history?: { time: string; delay: number }[]
}

type DisplayNode = ProxyEntry & {
  displayName: string
  key: string
}

const HIDDEN_NODES: ReadonlySet<string> = new Set(['direct', 'reject', 'proxy'])

const NodesPage = () => {
  const { t } = useTranslation()
  const theme = useTheme()
  const { verge } = useVerge()
  const { proxies, refreshProxy } = useAppData()
  const [delayRefreshTick, setDelayRefreshTick] = useState(0)
  const [testingDelay, setTestingDelay] = useState(false)
  const connected = Boolean(
    verge?.enable_tun_mode || verge?.enable_system_proxy,
  )
  const { changeProxy } = useProxySelection({
    onSuccess: () => refreshProxy(),
    onError: (error) => console.error('[Nodes] proxy change failed', error),
  })

  const globalGroup = proxies?.global as
    | {
        name?: string
        now?: string
        all?: Array<ProxyEntry | string>
      }
    | undefined

  const currentNode = globalGroup?.now || ''
  const groupName = globalGroup?.name || ''
  const latencyTimeout = verge?.default_latency_timeout || 10000

  const nodes = useMemo<DisplayNode[]>(() => {
    const byKey = new Map<string, DisplayNode>()

    for (const item of globalGroup?.all ?? []) {
      const entry =
        typeof item === 'string'
          ? ({ name: item } as ProxyEntry)
          : (item as ProxyEntry)

      if (!entry.name || HIDDEN_NODES.has(entry.name.toLowerCase())) continue

      const displayName = getProxyDisplayName(entry.name)
      const key = getProxyDisplayKey(entry.name)
      if (!displayName || !key) continue

      const node: DisplayNode = { ...entry, displayName, key }
      const existing = byKey.get(key)
      if (!existing || entry.name === currentNode) {
        byKey.set(key, node)
      }
    }

    return Array.from(byKey.values()).sort((a, b) => {
      const aAuto = a.displayName.toLowerCase() === 'auto'
      const bAuto = b.displayName.toLowerCase() === 'auto'
      if (aAuto && !bAuto) return -1
      if (bAuto && !aAuto) return 1
      return a.displayName.localeCompare(b.displayName)
    })
  }, [currentNode, globalGroup?.all])

  const selectedKey = currentNode ? getProxyDisplayKey(currentNode) : ''

  useEffect(() => {
    if (!groupName) return
    delayManager.setGroupListener(groupName, () =>
      setDelayRefreshTick((value) => value + 1),
    )
    return () => delayManager.removeGroupListener(groupName)
  }, [groupName])

  const handleSelect = (node: DisplayNode) => {
    if (connected || !globalGroup?.name || node.name === currentNode) return
    changeProxy(globalGroup.name, node.name, currentNode, true)
  }

  const handleTestDelay = useLockFn(async () => {
    if (!groupName || nodes.length === 0) return

    setTestingDelay(true)
    try {
      setDelayRefreshTick((value) => value + 1)
      await delayManager.checkListDelay(
        nodes.map((node) => node.name),
        groupName,
        latencyTimeout,
        6,
      )
      setDelayRefreshTick((value) => value + 1)
      await refreshProxy()
    } catch {
      showNotice.error(t('layout.components.nodes.delay.failed'))
    } finally {
      setTestingDelay(false)
    }
  })

  const getNodeDelay = (node: DisplayNode) => {
    void delayRefreshTick
    const cachedDelay = groupName
      ? delayManager.getDelayUpdate(node.name, groupName)?.delay
      : undefined
    if (typeof cachedDelay === 'number') return cachedDelay

    const historyDelay = node.history?.[node.history.length - 1]?.delay
    return typeof historyDelay === 'number' ? historyDelay : -1
  }

  const getDelayLabel = (delay: number) => {
    if (delay === -2) return t('layout.components.nodes.delay.testing')
    if (delay === -1) return t('layout.components.nodes.delay.notTested')
    if (delay === 0 || (delay >= latencyTimeout && delay <= 1e5)) {
      return t('layout.components.nodes.delay.timeout')
    }
    if (delay > 1e5) return t('layout.components.nodes.delay.failed')
    return t('layout.components.nodes.delay.ms', { value: delay })
  }

  const getDelayColor = (delay: number) => {
    if (delay === -2) return 'primary.main'
    if (delay < 0) return 'text.secondary'
    if (delay === 0 || delay >= latencyTimeout) return 'error.main'
    if (delay >= 400) return 'warning.main'
    return 'success.main'
  }

  return (
    <BasePage
      title={t('layout.components.nodes.title')}
      header={
        <Button
          size="small"
          variant="outlined"
          startIcon={
            testingDelay ? <CircularProgress size={14} /> : <SpeedRounded />
          }
          onClick={handleTestDelay}
          disabled={!groupName || nodes.length === 0 || testingDelay}
          sx={{ borderRadius: 999, fontWeight: 900 }}
        >
          {testingDelay
            ? t('layout.components.nodes.actions.testing')
            : t('layout.components.nodes.actions.test')}
        </Button>
      }
    >
      <Stack
        spacing={2}
        sx={{
          maxWidth: 980,
          mx: 'auto',
          py: 1.5,
        }}
      >
        <Paper
          elevation={0}
          sx={{
            p: 2.5,
            borderRadius: 4,
            border: `1px solid ${alpha(theme.palette.common.white, 0.08)}`,
            bgcolor:
              theme.palette.mode === 'dark'
                ? 'rgba(14,16,22,0.92)'
                : 'rgba(255,255,255,0.94)',
          }}
        >
          <Stack
            direction={{ xs: 'column', md: 'row' }}
            spacing={1.5}
            justifyContent="space-between"
            alignItems={{ xs: 'flex-start', md: 'center' }}
          >
            <Box>
              <Typography
                variant="overline"
                sx={{ color: 'primary.light', fontWeight: 900 }}
              >
                {t('layout.components.nodes.kicker')}
              </Typography>
              <Typography variant="h5" fontWeight={950}>
                {t('layout.components.nodes.heading')}
              </Typography>
              <Typography
                variant="body2"
                color="text.secondary"
                sx={{ mt: 0.25 }}
              >
                {connected
                  ? t('layout.components.nodes.connectedHint')
                  : t('layout.components.nodes.readyHint')}
              </Typography>
            </Box>
            <Chip
              label={t('layout.components.nodes.count', {
                count: nodes.length,
              })}
              color="primary"
              variant="outlined"
              sx={{ borderRadius: 999, fontWeight: 900 }}
            />
          </Stack>
        </Paper>

        <Box
          sx={{
            display: 'grid',
            gridTemplateColumns: {
              xs: '1fr',
              sm: 'repeat(2, minmax(0, 1fr))',
              lg: 'repeat(3, minmax(0, 1fr))',
            },
            gap: 1,
          }}
        >
          {nodes.map((node) => {
            const selected =
              selectedKey !== '' &&
              selectedKey === getProxyDisplayKey(node.name)
            const delay = getNodeDelay(node)

            return (
              <Paper
                key={`${node.key}:${node.name}`}
                component="button"
                type="button"
                elevation={0}
                disabled={connected || selected}
                onClick={() => handleSelect(node)}
                sx={{
                  width: '100%',
                  minHeight: 62,
                  p: 1.5,
                  textAlign: 'left',
                  borderRadius: 3,
                  border: `1px solid ${
                    selected
                      ? alpha(theme.palette.primary.main, 0.5)
                      : alpha(theme.palette.common.white, 0.08)
                  }`,
                  color: 'text.primary',
                  cursor: connected || selected ? 'default' : 'pointer',
                  bgcolor: selected
                    ? alpha(theme.palette.primary.main, 0.16)
                    : theme.palette.mode === 'dark'
                      ? 'rgba(24,27,36,0.92)'
                      : '#FFFFFF',
                  transition: 'border-color .18s ease, transform .18s ease',
                  '&:hover': connected
                    ? {}
                    : {
                        borderColor: alpha(theme.palette.primary.main, 0.45),
                        transform: selected ? 'none' : 'translateY(-1px)',
                      },
                  '&:disabled': {
                    opacity: selected ? 1 : 0.58,
                  },
                }}
              >
                <Stack direction="row" spacing={1} alignItems="center">
                  <Box
                    sx={{
                      width: 8,
                      height: 8,
                      borderRadius: '50%',
                      bgcolor: selected
                        ? 'primary.main'
                        : alpha(theme.palette.text.secondary, 0.45),
                      flex: '0 0 auto',
                    }}
                  />
                  <Typography variant="body1" fontWeight={900} noWrap>
                    {node.displayName}
                  </Typography>
                  <Stack
                    direction="row"
                    spacing={0.75}
                    alignItems="center"
                    sx={{ ml: 'auto' }}
                  >
                    <Chip
                      size="small"
                      label={getDelayLabel(delay)}
                      sx={{
                        height: 24,
                        borderRadius: 999,
                        color: getDelayColor(delay),
                        bgcolor: alpha(theme.palette.common.white, 0.06),
                        fontWeight: 900,
                      }}
                    />
                    {selected && (
                      <CheckCircleRounded
                        color="primary"
                        sx={{ fontSize: 19 }}
                      />
                    )}
                  </Stack>
                </Stack>
              </Paper>
            )
          })}
        </Box>

        {nodes.length === 0 && (
          <Paper
            elevation={0}
            sx={{
              p: 4,
              borderRadius: 4,
              textAlign: 'center',
              border: `1px dashed ${alpha(theme.palette.divider, 0.8)}`,
            }}
          >
            <Typography variant="h6" fontWeight={900}>
              {t('layout.components.nodes.empty.title')}
            </Typography>
            <Typography color="text.secondary" sx={{ mt: 0.5 }}>
              {t('layout.components.nodes.empty.subtitle')}
            </Typography>
          </Paper>
        )}
      </Stack>
    </BasePage>
  )
}

export default NodesPage
