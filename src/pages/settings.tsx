import {
  ArticleRounded,
  BugReportRounded,
  ChevronRightRounded,
  DarkModeRounded,
  DesktopWindowsRounded,
  LanguageRounded,
  RocketLaunchRounded,
  RouteRounded,
  SettingsApplicationsRounded,
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
    <BasePage title="设置">
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
            设置
          </Typography>
          <Typography variant="h5" fontWeight={950}>
            保留常用项，收起复杂项
          </Typography>
          <Typography variant="body2" color="text.secondary" sx={{ mt: 0.5 }}>
            默认只展示日常会用到的设置；排障工具放在高级入口里。
          </Typography>
        </Paper>

        <SettingsSection title="常用">
          <SettingsRow
            icon={<LanguageRounded />}
            title="语言"
            description="切换客户端界面语言。"
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
            title="主题"
            description="跟随系统，或手动选择浅色/深色。"
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
                <ToggleButton value="system">系统</ToggleButton>
                <ToggleButton value="light">亮</ToggleButton>
                <ToggleButton value="dark">暗</ToggleButton>
              </ToggleButtonGroup>
            }
          />
          <SettingsRow
            icon={<RocketLaunchRounded />}
            title="开机启动"
            description="Windows 登录后自动启动 XXLink。"
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
            title="自动检查更新"
            description="启动后自动检查 Windows 客户端新版本。"
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
            title="显示高级配置"
            description="仅在排障或手动配置时打开。"
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
          <SettingsSection title="高级">
            <SettingsRow
              icon={<ShieldRounded />}
              title="全局加速"
              description="让系统流量走加密通道；通常在连接页切换即可。"
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
              title="直连名单"
              description="让指定网站或本地网络直接访问。"
              onClick={() => sysproxyRef.current?.open()}
            />
            <SettingsRow
              icon={<BugReportRounded />}
              title="诊断日志"
              description="连接失败或加载异常时查看日志。"
              onClick={() => navigate('/logs')}
            />
            <SettingsRow
              icon={<ArticleRounded />}
              title="节点修复"
              description="仅在客服指导或节点异常时使用。"
              onClick={() => navigate('/profile')}
            />
            <SettingsRow
              icon={<SettingsApplicationsRounded />}
              title="开发者密钥"
              description="仅供高级用户和自动化场景使用。"
              onClick={() => navigate('/api-keys')}
            />
            <SettingsRow
              icon={<DesktopWindowsRounded />}
              title="实时连接"
              description="查看当前网络连接明细。"
              onClick={() => navigate('/connections')}
            />
            <SettingsRow
              icon={<RouteRounded />}
              title="分流明细"
              description="查看网络走向明细，仅用于排障。"
              onClick={() => navigate('/rules')}
            />
          </SettingsSection>
        )}
      </Stack>
    </BasePage>
  )
}

export default SettingsPage
