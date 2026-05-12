import {
  ArticleRounded,
  BugReportRounded,
  ChevronRightRounded,
  DarkModeRounded,
  DesktopWindowsRounded,
  LanguageRounded,
  RocketLaunchRounded,
  RouteRounded,
  ShieldRounded,
  TuneRounded,
} from '@mui/icons-material'
import {
  Box,
  MenuItem,
  Paper,
  Select,
  Stack,
  Switch,
  ToggleButton,
  ToggleButtonGroup,
  Typography,
  alpha,
  useTheme,
} from '@mui/material'
import type { ReactNode } from 'react'
import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useNavigate } from 'react-router'

import { BasePage, type DialogRef } from '@/components/base'
import { SysproxyViewer } from '@/components/setting/mods/sysproxy-viewer'
import { useVerge } from '@/hooks/use-verge'
import { supportedLanguages } from '@/services/i18n'

const ADVANCED_SETTINGS_STORAGE_KEY = 'xxlink:show-advanced-settings'

const readAdvancedSettingsFlag = (): boolean => {
  try {
    return localStorage.getItem(ADVANCED_SETTINGS_STORAGE_KEY) === 'true'
  } catch {
    return false
  }
}

const writeAdvancedSettingsFlag = (value: boolean) => {
  try {
    localStorage.setItem(ADVANCED_SETTINGS_STORAGE_KEY, String(value))
    window.dispatchEvent(
      new CustomEvent('xxlink:advanced-settings-changed', { detail: value }),
    )
  } catch {
    /* ignore */
  }
}

const languageOptions = supportedLanguages.map((code) => {
  const labels: Record<string, string> = {
    zh: '中文',
    en: 'English',
  }
  return { code, label: labels[code] ?? code }
})

interface SettingsRowProps {
  icon: ReactNode
  title: string
  description: string
  control?: ReactNode
  onClick?: () => void
}

const SettingsRow = ({
  icon,
  title,
  description,
  control,
  onClick,
}: SettingsRowProps) => {
  const theme = useTheme()
  return (
    <Box
      onClick={onClick}
      sx={{
        display: 'flex',
        alignItems: 'center',
        gap: 1.5,
        px: 2,
        py: 1.6,
        borderRadius: 2.5,
        cursor: onClick ? 'pointer' : 'default',
        '&:hover': onClick
          ? { bgcolor: alpha(theme.palette.primary.main, 0.08) }
          : undefined,
      }}
    >
      <Box
        sx={{
          width: 40,
          height: 40,
          borderRadius: 2,
          display: 'grid',
          placeItems: 'center',
          color: 'primary.light',
          bgcolor: alpha(theme.palette.primary.main, 0.12),
        }}
      >
        {icon}
      </Box>
      <Box sx={{ minWidth: 0, flex: 1 }}>
        <Typography fontWeight={900}>{title}</Typography>
        <Typography variant="body2" color="text.secondary">
          {description}
        </Typography>
      </Box>
      {control ?? <ChevronRightRounded color="disabled" />}
    </Box>
  )
}

const SettingsSection = ({
  title,
  children,
}: {
  title: string
  children: ReactNode
}) => {
  const theme = useTheme()
  return (
    <Stack spacing={1}>
      <Typography variant="overline" color="text.secondary" sx={{ px: 1 }}>
        {title}
      </Typography>
      <Paper
        elevation={0}
        sx={{
          p: 1,
          borderRadius: 4,
          border: `1px solid ${alpha(theme.palette.common.white, 0.08)}`,
          bgcolor: theme.palette.mode === 'dark' ? '#181B24' : '#fff',
        }}
      >
        {children}
      </Paper>
    </Stack>
  )
}

const SettingsPage = () => {
  const { t } = useTranslation()
  const theme = useTheme()
  const navigate = useNavigate()
  const { verge, mutateVerge, patchVerge } = useVerge()
  const sysproxyRef = useRef<DialogRef>(null)
  const [advancedVisible, setAdvancedVisible] = useState(
    readAdvancedSettingsFlag,
  )

  useEffect(() => {
    const sync = () => setAdvancedVisible(readAdvancedSettingsFlag())
    window.addEventListener('xxlink:advanced-settings-changed', sync)
    window.addEventListener('storage', sync)
    return () => {
      window.removeEventListener('xxlink:advanced-settings-changed', sync)
      window.removeEventListener('storage', sync)
    }
  }, [])

  const patchOptimistic = async (patch: Partial<IVergeConfig>) => {
    mutateVerge({ ...verge, ...patch }, false)
    await patchVerge(patch)
  }

  const setAdvanced = (checked: boolean) => {
    setAdvancedVisible(checked)
    writeAdvancedSettingsFlag(checked)
  }

  return (
    <BasePage title={t('settings.simplified.pageTitle')}>
      <SysproxyViewer ref={sysproxyRef} />
      <Stack
        spacing={2}
        sx={{
          maxWidth: 880,
          mx: 'auto',
          py: 2,
        }}
      >
        <Paper
          elevation={0}
          sx={{
            p: 2.5,
            borderRadius: 4,
            border: `1px solid ${alpha(theme.palette.common.white, 0.08)}`,
            background:
              theme.palette.mode === 'dark'
                ? 'linear-gradient(135deg, rgba(24,27,36,0.98), rgba(14,16,22,0.96))'
                : '#fff',
          }}
        >
          <Typography variant="overline" color="primary.light">
            {t('settings.simplified.hero.eyebrow')}
          </Typography>
          <Typography variant="h5" fontWeight={950}>
            {t('settings.simplified.hero.title')}
          </Typography>
          <Typography variant="body2" color="text.secondary" sx={{ mt: 0.5 }}>
            {t('settings.simplified.hero.subtitle')}
          </Typography>
        </Paper>

        <SettingsSection title={t('settings.simplified.sections.common')}>
          <SettingsRow
            icon={<LanguageRounded />}
            title={t('settings.simplified.rows.language.title')}
            description={t('settings.simplified.rows.language.description')}
            control={
              <Select
                size="small"
                value={verge?.language ?? 'zh'}
                onClick={(event) => event.stopPropagation()}
                onChange={(event) => {
                  void patchOptimistic({ language: event.target.value })
                }}
                sx={{ minWidth: 112 }}
              >
                {languageOptions.map((item) => (
                  <MenuItem key={item.code} value={item.code}>
                    {item.label}
                  </MenuItem>
                ))}
              </Select>
            }
          />
          <SettingsRow
            icon={<DarkModeRounded />}
            title={t('settings.simplified.rows.theme.title')}
            description={t('settings.simplified.rows.theme.description')}
            control={
              <ToggleButtonGroup
                exclusive
                size="small"
                value={verge?.theme_mode ?? 'system'}
                onClick={(event) => event.stopPropagation()}
                onChange={(_, value: IVergeConfig['theme_mode'] | null) => {
                  if (value) void patchOptimistic({ theme_mode: value })
                }}
                sx={{
                  '& .MuiToggleButton-root': {
                    px: 1.3,
                    fontWeight: 900,
                  },
                }}
              >
                <ToggleButton value="system">
                  {t('settings.simplified.theme.system')}
                </ToggleButton>
                <ToggleButton value="light">
                  {t('settings.simplified.theme.light')}
                </ToggleButton>
                <ToggleButton value="dark">
                  {t('settings.simplified.theme.dark')}
                </ToggleButton>
              </ToggleButtonGroup>
            }
          />
          <SettingsRow
            icon={<RocketLaunchRounded />}
            title={t('settings.simplified.rows.autoLaunch.title')}
            description={t('settings.simplified.rows.autoLaunch.description')}
            control={
              <Switch
                checked={verge?.enable_auto_launch ?? false}
                onClick={(event) => event.stopPropagation()}
                onChange={(_, checked) => {
                  void patchOptimistic({ enable_auto_launch: checked })
                }}
              />
            }
          />
          <SettingsRow
            icon={<DesktopWindowsRounded />}
            title={t('settings.simplified.rows.autoUpdate.title')}
            description={t('settings.simplified.rows.autoUpdate.description')}
            control={
              <Switch
                checked={verge?.auto_check_update ?? true}
                onClick={(event) => event.stopPropagation()}
                onChange={(_, checked) => {
                  void patchOptimistic({ auto_check_update: checked })
                }}
              />
            }
          />
          <SettingsRow
            icon={<TuneRounded />}
            title={t('settings.simplified.rows.advancedToggle.title')}
            description={t(
              'settings.simplified.rows.advancedToggle.description',
            )}
            control={
              <Switch
                checked={advancedVisible}
                onClick={(event) => event.stopPropagation()}
                onChange={(_, checked) => setAdvanced(checked)}
              />
            }
          />
        </SettingsSection>

        {advancedVisible && (
          <SettingsSection title={t('settings.simplified.sections.advanced')}>
            <SettingsRow
              icon={<ShieldRounded />}
              title={t('settings.simplified.rows.tun.title')}
              description={t('settings.simplified.rows.tun.description')}
              control={
                <Switch
                  checked={verge?.enable_tun_mode ?? false}
                  onClick={(event) => event.stopPropagation()}
                  onChange={(_, checked) => {
                    void patchOptimistic({ enable_tun_mode: checked })
                  }}
                />
              }
            />
            <SettingsRow
              icon={<RouteRounded />}
              title={t('settings.simplified.rows.bypass.title')}
              description={t('settings.simplified.rows.bypass.description')}
              onClick={() => sysproxyRef.current?.open()}
            />
            <SettingsRow
              icon={<BugReportRounded />}
              title={t('settings.simplified.rows.logs.title')}
              description={t('settings.simplified.rows.logs.description')}
              onClick={() => navigate('/logs')}
            />
            <SettingsRow
              icon={<ArticleRounded />}
              title={t('settings.simplified.rows.profileRepair.title')}
              description={t(
                'settings.simplified.rows.profileRepair.description',
              )}
              onClick={() => navigate('/profile')}
            />
            <SettingsRow
              icon={<DesktopWindowsRounded />}
              title={t('settings.simplified.rows.connections.title')}
              description={t(
                'settings.simplified.rows.connections.description',
              )}
              onClick={() => navigate('/connections')}
            />
            <SettingsRow
              icon={<RouteRounded />}
              title={t('settings.simplified.rows.rules.title')}
              description={t('settings.simplified.rows.rules.description')}
              onClick={() => navigate('/rules')}
            />
          </SettingsSection>
        )}
      </Stack>
    </BasePage>
  )
}

export default SettingsPage
