import { CheckCircleRounded } from '@mui/icons-material'
import {
  Box,
  Chip,
  Paper,
  Stack,
  Typography,
  alpha,
  useTheme,
} from '@mui/material'
import { useMemo } from 'react'

import { BasePage } from '@/components/base'
import { useProxySelection } from '@/hooks/use-proxy-selection'
import { useVerge } from '@/hooks/use-verge'
import { useAppData } from '@/providers/app-data-context'
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
  const theme = useTheme()
  const { verge } = useVerge()
  const { proxies, refreshProxy } = useAppData()
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

  const handleSelect = (node: DisplayNode) => {
    if (connected || !globalGroup?.name || node.name === currentNode) return
    changeProxy(globalGroup.name, node.name, currentNode, true)
  }

  return (
    <BasePage title="节点">
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
                节点
              </Typography>
              <Typography variant="h5" fontWeight={950}>
                选择一个入口
              </Typography>
              <Typography
                variant="body2"
                color="text.secondary"
                sx={{ mt: 0.25 }}
              >
                {connected
                  ? '当前已连接，请先断开后再切换节点。'
                  : '只展示节点名称，同名不同端口会自动去重。'}
              </Typography>
            </Box>
            <Chip
              label={`${nodes.length} 个节点`}
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
                  {selected && (
                    <CheckCircleRounded
                      color="primary"
                      sx={{ ml: 'auto', fontSize: 19 }}
                    />
                  )}
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
              暂无可用节点
            </Typography>
            <Typography color="text.secondary" sx={{ mt: 0.5 }}>
              请在连接页刷新节点，或打开套餐页确认当前权益。
            </Typography>
          </Paper>
        )}
      </Stack>
    </BasePage>
  )
}

export default NodesPage
