import {
  BuildRounded,
  DeleteForeverRounded,
  PauseCircleOutlineRounded,
  PlayCircleOutlineRounded,
  SettingsRounded,
  WarningRounded,
} from '@mui/icons-material'
import { Box, Typography, alpha, useTheme } from '@mui/material'
import { useLockFn } from 'ahooks'
import React, { useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'

import { DialogRef, Switch, TooltipIcon } from '@/components/base'
import { SysproxyViewer } from '@/components/setting/mods/sysproxy-viewer'
import { TunViewer } from '@/components/setting/mods/tun-viewer'
import { useServiceInstaller } from '@/hooks/use-service-installer'
import { useServiceUninstaller } from '@/hooks/use-service-uninstaller'
import { useSystemProxyState } from '@/hooks/use-system-proxy-state'
import { useSystemState } from '@/hooks/use-system-state'
import { useVerge } from '@/hooks/use-verge'
import { runtimeActionController } from '@/services/runtime-action-controller'
type ProxyControlKind = 'systemProxy' | 'tun'

interface ProxyControlProps {
  onError: (error: unknown) => void
}

interface ProxySwitchProps extends ProxyControlProps {
  kind: ProxyControlKind
  noRightPadding?: boolean
}

interface SwitchRowProps {
  label: string
  active: boolean
  disabled?: boolean
  infoTitle: string
  onInfoClick?: () => void
  extraIcons?: React.ReactNode
  onToggle: (value: boolean) => Promise<void>
  onError: (error: unknown) => void
  highlight?: boolean
}

/**
 * 抽取的子组件：统一的开关 UI
 * active = 真实状态OS/配置 乐观更新
 */
const SwitchRow = ({
  label,
  active,
  disabled,
  infoTitle,
  onInfoClick,
  extraIcons,
  onToggle,
  onError,
  highlight,
}: SwitchRowProps) => {
  const theme = useTheme()
  const [optimisticValue, setOptimisticValue] = useState<boolean | null>(null)
  const [pending, setPending] = useState(false)

  const handleChange = (_: React.ChangeEvent, value: boolean) => {
    if (pending) return
    setPending(true)
    setOptimisticValue(value)
    void onToggle(value)
      .catch((error: unknown) => {
        onError(error)
      })
      .finally(() => {
        setOptimisticValue(null)
        setPending(false)
      })
  }

  return (
    <Box
      sx={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        p: 1,
        pr: 2,
        borderRadius: 1.5,
        bgcolor: highlight
          ? alpha(theme.palette.success.main, 0.07)
          : 'transparent',
        opacity: disabled ? 0.6 : 1,
        transition: 'background-color 0.3s',
      }}
    >
      <Box sx={{ display: 'flex', alignItems: 'center' }}>
        {active ? (
          <PlayCircleOutlineRounded sx={{ color: 'success.main', mr: 1 }} />
        ) : (
          <PauseCircleOutlineRounded sx={{ color: 'text.disabled', mr: 1 }} />
        )}
        <Typography
          variant="subtitle1"
          sx={{ fontWeight: 500, fontSize: '15px' }}
        >
          {label}
        </Typography>
        <TooltipIcon
          title={infoTitle}
          icon={SettingsRounded}
          onClick={onInfoClick}
          sx={{ ml: 1 }}
        />
        {extraIcons}
      </Box>

      <Switch
        edge="end"
        disabled={disabled || pending}
        checked={optimisticValue ?? active}
        onChange={handleChange}
      />
    </Box>
  )
}

const SystemProxyControl = ({ onError }: ProxyControlProps) => {
  const { t } = useTranslation()
  const {
    indicator: systemProxyIndicator,
    canToggle: canToggleSystemProxy,
    toggleSystemProxy,
  } = useSystemProxyState()
  const sysproxyRef = useRef<DialogRef>(null)

  return (
    <>
      <SwitchRow
        label={t('settings.sections.proxyControl.fields.systemProxy')}
        active={systemProxyIndicator === true}
        disabled={!canToggleSystemProxy}
        infoTitle={t('settings.sections.proxyControl.tooltips.systemProxy')}
        onInfoClick={() => sysproxyRef.current?.open()}
        onToggle={(value) => toggleSystemProxy(value)}
        onError={onError}
        highlight={systemProxyIndicator === true}
      />
      <SysproxyViewer ref={sysproxyRef} />
    </>
  )
}

const TunControl = ({ onError }: ProxyControlProps) => {
  const { t } = useTranslation()
  const { verge, refreshVerge } = useVerge()
  const { installServiceAndRestartCore } = useServiceInstaller()
  const { uninstallServiceAndRestartCore } = useServiceUninstaller()
  const { isReady, isServiceInstalled, isTunModeAvailable } = useSystemState()
  const tunRef = useRef<DialogRef>(null)

  const { enable_tun_mode } = verge ?? {}

  const handleTunToggle = async (value: boolean) => {
    if (value && !isTunModeAvailable) {
      const msgKey = 'settings.sections.proxyControl.tooltips.tunUnavailable'
      throw new Error(t(msgKey))
    }
    let operationError: unknown
    try {
      await runtimeActionController.setTunEnabled(value)
    } catch (error) {
      operationError = error
    }
    let refreshError: unknown
    try {
      await refreshVerge()
    } catch (error) {
      refreshError = error
    }
    if (operationError) throw operationError
    if (refreshError) throw refreshError
  }

  const onInstallService = useLockFn(async () => {
    try {
      await installServiceAndRestartCore()
    } catch (error) {
      onError(error)
    }
  })

  const onUninstallService = useLockFn(async () => {
    try {
      if (verge?.enable_tun_mode) {
        await handleTunToggle(false)
      }
      await uninstallServiceAndRestartCore()
    } catch (error) {
      onError(error)
    }
  })

  return (
    <>
      <SwitchRow
        label={t('settings.sections.proxyControl.fields.tunMode')}
        active={enable_tun_mode || false}
        infoTitle={t('settings.sections.proxyControl.tooltips.tunMode')}
        onInfoClick={() => tunRef.current?.open()}
        onToggle={handleTunToggle}
        onError={onError}
        disabled={enable_tun_mode !== true && (!isReady || !isTunModeAvailable)}
        highlight={enable_tun_mode || false}
        extraIcons={
          <>
            {isReady && !isTunModeAvailable && (
              <>
                <TooltipIcon
                  title={t(
                    'settings.sections.proxyControl.tooltips.tunUnavailable',
                  )}
                  icon={WarningRounded}
                  sx={{ color: 'warning.main', ml: 1 }}
                />
                <TooltipIcon
                  title={t(
                    'settings.sections.proxyControl.actions.installService',
                  )}
                  icon={BuildRounded}
                  color="primary"
                  onClick={onInstallService}
                  sx={{ ml: 1 }}
                />
              </>
            )}
            {isReady && isServiceInstalled && (
              <TooltipIcon
                title={t(
                  'settings.sections.proxyControl.actions.uninstallService',
                )}
                icon={DeleteForeverRounded}
                color="secondary"
                onClick={onUninstallService}
                sx={{ ml: 1 }}
              />
            )}
          </>
        }
      />
      <TunViewer ref={tunRef} />
    </>
  )
}

const ProxyControlSwitches = ({
  kind,
  onError,
  noRightPadding = false,
}: ProxySwitchProps) => (
  <Box sx={{ width: '100%', pr: noRightPadding ? 1 : 2 }}>
    {kind === 'systemProxy' ? (
      <SystemProxyControl onError={onError} />
    ) : (
      <TunControl onError={onError} />
    )}
  </Box>
)

export default ProxyControlSwitches
