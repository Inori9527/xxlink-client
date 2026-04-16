import {
  ArrowDownwardRounded,
  ArrowUpwardRounded,
  PowerSettingsNewRounded,
} from '@mui/icons-material'
import {
  Box,
  Button,
  ButtonGroup,
  CircularProgress,
  FormControl,
  MenuItem,
  Select,
  SelectChangeEvent,
  Stack,
  Typography,
  alpha,
  keyframes,
  useTheme,
} from '@mui/material'
import { useLockFn } from 'ahooks'
import { useCallback, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'

import { BasePage } from '@/components/base'
import { useProxySelection } from '@/hooks/use-proxy-selection'
import { useTrafficData } from '@/hooks/use-traffic-data'
import { useVerge } from '@/hooks/use-verge'
import { useVisibility } from '@/hooks/use-visibility'
import { useAppData } from '@/providers/app-data-context'
import parseTraffic from '@/utils/parse-traffic'

type ConnectMode = 'system' | 'tun' | 'both'

const MODE_STORAGE_KEY = 'xxlink:connect-mode'
const DEFAULT_MODE: ConnectMode = 'both'

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

const ConnectPage = () => {
  const { t } = useTranslation()
  const theme = useTheme()
  const pageVisible = useVisibility()
  const { verge, patchVerge } = useVerge()
  const { proxies, refreshProxy } = useAppData()
  const { changeProxy } = useProxySelection({
    onSuccess: () => refreshProxy(),
    onError: (error) => console.error('[Connect] proxy change failed', error),
  })

  const [mode, setMode] = useState<ConnectMode>(() => loadMode())
  const [busy, setBusy] = useState(false)

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
    | { name?: string; now?: string; all?: Array<{ name: string } | string> }
    | undefined

  const currentNode = globalGroup?.now || ''
  const nodeOptions = useMemo(() => {
    const all = globalGroup?.all || []
    return all
      .map((item) => (typeof item === 'string' ? item : item?.name))
      .filter(
        (name): name is string =>
          typeof name === 'string' &&
          name.length > 0 &&
          name !== 'DIRECT' &&
          name !== 'REJECT',
      )
  }, [globalGroup?.all])

  const handleModeChange = useCallback((next: ConnectMode) => {
    setMode(next)
    try {
      localStorage.setItem(MODE_STORAGE_KEY, next)
    } catch {
      /* ignore */
    }
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
    } finally {
      setBusy(false)
    }
  })

  const handleNodeChange = useCallback(
    (event: SelectChangeEvent<string>) => {
      const newProxy = event.target.value
      if (!newProxy || !globalGroup?.name) return
      changeProxy(globalGroup.name, newProxy, currentNode, true)
    },
    [changeProxy, currentNode, globalGroup?.name],
  )

  // Button colors
  const getButtonColor = () => {
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
                opacity: 0.9,
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
          color={connected ? 'success.main' : 'text.secondary'}
        >
          {statusLabel}
        </Typography>

        {/* Node dropdown */}
        <FormControl fullWidth size="small">
          <Select
            displayEmpty
            value={currentNode}
            onChange={handleNodeChange}
            disabled={!globalGroup?.name || nodeOptions.length === 0}
            renderValue={(selected) =>
              selected || t('layout.components.connect.labels.noNode')
            }
            MenuProps={{
              PaperProps: { style: { maxHeight: 420 } },
            }}
            sx={{ borderRadius: 2 }}
          >
            {nodeOptions.map((name) => (
              <MenuItem key={name} value={name}>
                {name}
              </MenuItem>
            ))}
          </Select>
        </FormControl>

        {/* Mode selector */}
        <Box sx={{ width: '100%' }}>
          <Typography
            variant="caption"
            color="text.secondary"
            sx={{ display: 'block', mb: 1, textAlign: 'center' }}
          >
            {t('layout.components.connect.labels.mode')}
          </Typography>
          <ButtonGroup fullWidth size="small">
            <Button
              variant={mode === 'system' ? 'contained' : 'outlined'}
              onClick={() => handleModeChange('system')}
            >
              {t('layout.components.connect.labels.system')}
            </Button>
            <Button
              variant={mode === 'tun' ? 'contained' : 'outlined'}
              onClick={() => handleModeChange('tun')}
            >
              {t('layout.components.connect.labels.tun')}
            </Button>
            <Button
              variant={mode === 'both' ? 'contained' : 'outlined'}
              onClick={() => handleModeChange('both')}
            >
              {t('layout.components.connect.labels.both')}
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
          <Stack direction="row" alignItems="center" spacing={0.5}>
            <ArrowUpwardRounded
              fontSize="small"
              sx={{ color: theme.palette.secondary.main }}
            />
            <Typography variant="body2" fontWeight={600}>
              {upVal} {upUnit}/s
            </Typography>
          </Stack>
          <Stack direction="row" alignItems="center" spacing={0.5}>
            <ArrowDownwardRounded
              fontSize="small"
              sx={{ color: theme.palette.primary.main }}
            />
            <Typography variant="body2" fontWeight={600}>
              {downVal} {downUnit}/s
            </Typography>
          </Stack>
        </Stack>
      </Stack>
    </BasePage>
  )
}

export default ConnectPage
