import { ComputerRounded, LanguageRounded } from '@mui/icons-material'
import { Box, Paper, Stack, Typography } from '@mui/material'
import { useLockFn } from 'ahooks'
import { useMemo } from 'react'
import { useTranslation } from 'react-i18next'

import { useClash } from '@/hooks/use-clash'
import {
  ConnectMode,
  getConnectModePayload,
  useConnectMode,
} from '@/hooks/use-connect-mode'
import { useSystemState } from '@/hooks/use-system-state'
import { useVerge } from '@/hooks/use-verge'
import { showNotice } from '@/services/notice-service'

const MODE_META: Record<
  ConnectMode,
  {
    label: string
    activeDescription: string
    inactiveDescription: string
  }
> = {
  system: {
    label: 'layout.components.connect.mode.system',
    activeDescription: 'home.components.proxyTun.status.systemProxyEnabled',
    inactiveDescription: 'home.components.proxyTun.status.systemProxyDisabled',
  },
  both: {
    label: 'layout.components.connect.mode.both',
    activeDescription: 'home.components.proxyTun.status.tunModeEnabled',
    inactiveDescription: 'home.components.proxyTun.status.tunModeDisabled',
  },
}

export const ConnectModeCard = () => {
  const { t } = useTranslation()
  const { mode, setMode } = useConnectMode()
  const { verge, patchVerge } = useVerge()
  const { patchClash } = useClash()
  const { isTunModeAvailable } = useSystemState()

  const sysEnabled = verge?.enable_system_proxy ?? false
  const tunEnabled = verge?.enable_tun_mode ?? false
  const hasActiveProxy = sysEnabled || tunEnabled

  const modeDescription = useMemo(() => {
    if (mode === 'system') {
      return t(
        sysEnabled
          ? MODE_META.system.activeDescription
          : MODE_META.system.inactiveDescription,
      )
    }

    if (!isTunModeAvailable) {
      return t('home.components.proxyTun.status.tunModeServiceRequired')
    }

    return t(
      tunEnabled
        ? MODE_META.both.activeDescription
        : MODE_META.both.inactiveDescription,
    )
  }, [isTunModeAvailable, mode, sysEnabled, t, tunEnabled])

  const modeIcons = useMemo(
    () => ({
      system: <ComputerRounded fontSize="small" />,
      both: <LanguageRounded fontSize="small" />,
    }),
    [],
  )

  const onChangeMode = useLockFn(async (nextMode: ConnectMode) => {
    if (nextMode === mode) return

    const previousMode = mode
    setMode(nextMode)

    if (!hasActiveProxy) return

    try {
      if (nextMode === 'both') {
        await patchClash({ mode: 'global' })
      }

      await patchVerge(getConnectModePayload(nextMode, true))
    } catch (error) {
      setMode(previousMode)
      console.error('[Home] failed to change connect mode', error)
      showNotice.error('layout.components.connect.feedback.toggleFailed', error)
    }
  })

  const buttonStyles = (targetMode: ConnectMode) => ({
    cursor: 'pointer',
    px: 2,
    py: 1.2,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 1,
    bgcolor: targetMode === mode ? 'primary.main' : 'background.paper',
    color: targetMode === mode ? 'primary.contrastText' : 'text.primary',
    borderRadius: 1.5,
    transition: 'all 0.2s ease-in-out',
    position: 'relative',
    overflow: 'visible',
    '&:hover': {
      transform: 'translateY(-1px)',
      boxShadow: 1,
    },
    '&:active': {
      transform: 'translateY(1px)',
    },
    '&::after':
      targetMode === mode
        ? {
            content: '""',
            position: 'absolute',
            bottom: -16,
            left: '50%',
            width: 2,
            height: 16,
            bgcolor: 'primary.main',
            transform: 'translateX(-50%)',
          }
        : {},
  })

  return (
    <Box sx={{ display: 'flex', flexDirection: 'column', width: '100%' }}>
      <Stack
        direction="row"
        spacing={1}
        sx={{
          display: 'flex',
          justifyContent: 'center',
          py: 1,
          position: 'relative',
          zIndex: 2,
        }}
      >
        {(Object.keys(MODE_META) as ConnectMode[]).map((targetMode) => (
          <Paper
            key={targetMode}
            elevation={targetMode === mode ? 2 : 0}
            onClick={() => onChangeMode(targetMode)}
            sx={buttonStyles(targetMode)}
          >
            {modeIcons[targetMode]}
            <Typography
              variant="body2"
              sx={{
                fontWeight: targetMode === mode ? 600 : 400,
              }}
            >
              {t(MODE_META[targetMode].label)}
            </Typography>
          </Paper>
        ))}
      </Stack>

      <Box
        sx={{
          width: '100%',
          my: 1,
          position: 'relative',
          display: 'flex',
          justifyContent: 'center',
          overflow: 'visible',
        }}
      >
        <Typography
          variant="caption"
          component="div"
          sx={{
            width: '95%',
            textAlign: 'center',
            color: 'text.secondary',
            p: 0.8,
            borderRadius: 1,
            borderColor: 'primary.main',
            borderWidth: 1,
            borderStyle: 'solid',
            backgroundColor: 'background.paper',
            wordBreak: 'break-word',
            hyphens: 'auto',
          }}
        >
          {modeDescription}
        </Typography>
      </Box>
    </Box>
  )
}
