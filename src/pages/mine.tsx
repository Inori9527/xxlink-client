import {
  CampaignRounded,
  ChevronRightRounded,
  ExitToAppRounded,
  LocalOfferRounded,
  OpenInNewRounded,
  PersonRounded,
  RefreshRounded,
  SettingsRounded,
  SystemUpdateAltRounded,
} from '@mui/icons-material'
import {
  Alert,
  Box,
  Button,
  Chip,
  Dialog,
  DialogActions,
  DialogContent,
  DialogContentText,
  DialogTitle,
  LinearProgress,
  Paper,
  Stack,
  Typography,
  alpha,
  useTheme,
} from '@mui/material'
import { open } from '@tauri-apps/plugin-shell'
import { useLockFn } from 'ahooks'
import type { ReactNode } from 'react'
import { useEffect, useRef, useState } from 'react'
import { useNavigate } from 'react-router'

import { BasePage, type DialogRef } from '@/components/base'
import { UpdateViewer } from '@/components/setting/mods/update-viewer'
import { useUpdate } from '@/hooks/use-update'
import { api, type Announcement, type UsageData } from '@/services/api'
import { apiLogout } from '@/services/auth'
import { useAuth } from '@/services/auth-store'
import { showNotice } from '@/services/notice-service'
import parseTraffic from '@/utils/parse-traffic'

const DASHBOARD_URL = 'https://xxlink.net/dashboard'

const text = {
  pageTitle: '\u6211\u7684',
  userFallback: 'XXLink \u7528\u6237',
  usage: '\u5957\u9910\u5468\u671f\u7528\u91cf',
  remaining: '\u5269\u4f59',
  openDashboard: '\u6253\u5f00\u63a7\u5236\u53f0',
  view: '\u67e5\u770b',
  common: '\u5e38\u7528',
  management: '\u7ba1\u7406',
  account: '\u8d26\u6237',
  announcements: '\u516c\u544a\u4e2d\u5fc3',
  announcementsDesc: '\u6700\u65b0\u516c\u544a\u548c\u5386\u53f2\u8bb0\u5f55',
  promo: '\u4f18\u60e0\u7801',
  promoDesc: '\u5151\u6362\u6d41\u91cf\u6216\u8d26\u53f7\u6743\u76ca',
  update: '\u68c0\u67e5\u66f4\u65b0',
  updateDesc: '\u68c0\u67e5 Windows \u5ba2\u6237\u7aef\u65b0\u7248\u672c',
  updateFound: '\u53d1\u73b0\u65b0\u7248\u672c',
  checking: '\u68c0\u67e5\u4e2d',
  check: '\u68c0\u67e5',
  alreadyLatest: '\u5f53\u524d\u5df2\u662f\u6700\u65b0\u7248\u672c',
  settings: '\u8bbe\u7f6e',
  settingsDesc: '\u542f\u52a8\u3001\u4e3b\u9898\u4e0e\u5916\u89c2',
  logout: '\u9000\u51fa\u767b\u5f55',
  logoutDesc: '\u6e05\u9664\u672c\u673a\u767b\u5f55\u72b6\u6001',
  logoutTitle: '\u9000\u51fa\u767b\u5f55\uff1f',
  logoutBody:
    '\u9000\u51fa\u540e\u9700\u8981\u91cd\u65b0\u767b\u5f55\u624d\u80fd\u540c\u6b65\u8282\u70b9\u548c\u8d26\u53f7\u6743\u76ca\u3002',
  cancel: '\u53d6\u6d88',
}

const formatBytes = (bytes: number): string => {
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

interface MineRowProps {
  icon: ReactNode
  title: string
  description: string
  action?: ReactNode
  danger?: boolean
  onClick?: () => void
}

const MineRow = ({
  icon,
  title,
  description,
  action,
  danger,
  onClick,
}: MineRowProps) => {
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
        transition: 'background 160ms ease, transform 160ms ease',
        '&:hover': onClick
          ? {
              bgcolor: alpha(theme.palette.primary.main, 0.08),
              transform: 'translateY(-1px)',
            }
          : undefined,
      }}
    >
      <Box
        sx={{
          width: 42,
          height: 42,
          borderRadius: 2,
          display: 'grid',
          placeItems: 'center',
          color: danger ? 'error.main' : 'primary.light',
          bgcolor: danger
            ? alpha(theme.palette.error.main, 0.12)
            : alpha(theme.palette.primary.main, 0.12),
        }}
      >
        {icon}
      </Box>
      <Box sx={{ minWidth: 0, flex: 1 }}>
        <Typography fontWeight={900} color={danger ? 'error.main' : undefined}>
          {title}
        </Typography>
        <Typography variant="body2" color="text.secondary" noWrap>
          {description}
        </Typography>
      </Box>
      {action ?? <ChevronRightRounded color="disabled" />}
    </Box>
  )
}

const MineSection = ({
  title,
  children,
}: {
  title: string
  children: ReactNode
}) => {
  const theme = useTheme()
  return (
    <Stack spacing={1}>
      <Typography
        variant="overline"
        color="text.secondary"
        sx={{ px: 1, fontWeight: 800 }}
      >
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

const MinePage = () => {
  const theme = useTheme()
  const navigate = useNavigate()
  const { user, refreshToken, clearAuth } = useAuth()
  const updateViewerRef = useRef<DialogRef>(null)
  const { updateInfo, checkUpdate, loading: checkingUpdate } = useUpdate(false)
  const [logoutOpen, setLogoutOpen] = useState(false)
  const [usage, setUsage] = useState<UsageData | null>(null)
  const [announcement, setAnnouncement] = useState<Announcement | null>(null)

  useEffect(() => {
    let cancelled = false
    Promise.allSettled([api.user.usage(), api.announcements.latest()]).then(
      ([usageResult, announcementResult]) => {
        if (cancelled) return
        if (usageResult.status === 'fulfilled') setUsage(usageResult.value)
        if (announcementResult.status === 'fulfilled') {
          setAnnouncement(announcementResult.value)
        }
      },
    )
    return () => {
      cancelled = true
    }
  }, [])

  const confirmLogout = useLockFn(async () => {
    try {
      if (refreshToken) await apiLogout(refreshToken)
    } catch {
      /* local logout should still proceed */
    } finally {
      clearAuth()
      setLogoutOpen(false)
      navigate('/login')
    }
  })

  const handleCheckUpdate = async () => {
    const result = await checkUpdate()
    if (result.data?.available) {
      updateViewerRef.current?.open()
      return
    }
    showNotice.success(text.alreadyLatest)
  }

  const used = getNumericBytes(usage?.trafficUsed)
  const limit = getNumericBytes(usage?.trafficLimit)
  const remaining = getNumericBytes(usage?.trafficRemaining)
  const percent =
    typeof usage?.percentUsed === 'number'
      ? Math.min(Math.max(usage.percentUsed, 0), 100)
      : limit > 0
        ? Math.min((used / limit) * 100, 100)
        : 0

  return (
    <BasePage title={text.pageTitle} contentStyle={{ height: '100%' }}>
      <UpdateViewer ref={updateViewerRef} />
      <Stack
        spacing={2}
        sx={{
          maxWidth: 980,
          mx: 'auto',
          py: 2,
          height: '100%',
          overflow: 'auto',
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
                ? 'linear-gradient(135deg, rgba(24,27,36,0.96), rgba(14,16,22,0.96))'
                : '#fff',
          }}
        >
          <Stack
            direction={{ xs: 'column', md: 'row' }}
            spacing={2}
            justifyContent="space-between"
            alignItems={{ xs: 'stretch', md: 'center' }}
          >
            <Stack direction="row" spacing={1.5} alignItems="center">
              <Box
                sx={{
                  width: 58,
                  height: 58,
                  borderRadius: 3,
                  display: 'grid',
                  placeItems: 'center',
                  color: 'primary.light',
                  bgcolor: alpha(theme.palette.primary.main, 0.16),
                }}
              >
                <PersonRounded sx={{ fontSize: 32 }} />
              </Box>
              <Box>
                <Typography variant="h5" fontWeight={950}>
                  {user?.email ?? text.userFallback}
                </Typography>
                <Stack direction="row" spacing={1} sx={{ mt: 0.8 }}>
                  <Chip size="small" label={usage?.plan?.name ?? '当前账号'} />
                  <Chip
                    size="small"
                    color="success"
                    label={`${text.remaining} ${formatBytes(remaining)}`}
                  />
                </Stack>
              </Box>
            </Stack>
            <Box sx={{ minWidth: { md: 320 } }}>
              <Stack direction="row" justifyContent="space-between">
                <Typography variant="body2" color="text.secondary">
                  {text.usage}
                </Typography>
                <Typography variant="body2" fontWeight={900}>
                  {formatBytes(used)} / {limit > 0 ? formatBytes(limit) : '--'}
                </Typography>
              </Stack>
              <LinearProgress
                variant="determinate"
                value={percent}
                sx={{
                  mt: 1,
                  height: 8,
                  borderRadius: 999,
                  bgcolor: alpha(theme.palette.common.white, 0.08),
                  '& .MuiLinearProgress-bar': {
                    borderRadius: 999,
                    background:
                      percent > 80
                        ? 'linear-gradient(90deg,#FCD34D,#F87171)'
                        : 'linear-gradient(90deg,#2F80ED,#0FEDD2)',
                  },
                }}
              />
              <Button
                variant="outlined"
                size="small"
                startIcon={<OpenInNewRounded />}
                onClick={() => void open(DASHBOARD_URL)}
                sx={{ mt: 1.5, borderRadius: 999, fontWeight: 900 }}
              >
                {text.openDashboard}
              </Button>
            </Box>
          </Stack>
        </Paper>

        {announcement?.id && (
          <Alert
            severity={announcement.level ?? 'info'}
            action={
              <Button
                color="inherit"
                size="small"
                onClick={() => navigate('/announcements')}
              >
                {text.view}
              </Button>
            }
            sx={{ borderRadius: 3 }}
          >
            {announcement.title}
          </Alert>
        )}

        <MineSection title={text.common}>
          <MineRow
            icon={<CampaignRounded />}
            title={text.announcements}
            description={text.announcementsDesc}
            onClick={() => navigate('/announcements')}
          />
          <MineRow
            icon={<LocalOfferRounded />}
            title={text.promo}
            description={text.promoDesc}
            onClick={() => navigate('/promo-code')}
          />
          <MineRow
            icon={<SystemUpdateAltRounded />}
            title={text.update}
            description={
              updateInfo?.available
                ? `${text.updateFound} ${updateInfo.version}`
                : text.updateDesc
            }
            action={
              <Button
                size="small"
                variant="outlined"
                disabled={checkingUpdate}
                startIcon={<RefreshRounded />}
                onClick={(event) => {
                  event.stopPropagation()
                  void handleCheckUpdate()
                }}
                sx={{ borderRadius: 999, fontWeight: 900 }}
              >
                {checkingUpdate ? text.checking : text.check}
              </Button>
            }
            onClick={() => void handleCheckUpdate()}
          />
        </MineSection>

        <MineSection title={text.management}>
          <MineRow
            icon={<SettingsRounded />}
            title={text.settings}
            description={text.settingsDesc}
            onClick={() => navigate('/settings')}
          />
        </MineSection>

        <MineSection title={text.account}>
          <MineRow
            danger
            icon={<ExitToAppRounded />}
            title={text.logout}
            description={text.logoutDesc}
            onClick={() => setLogoutOpen(true)}
          />
        </MineSection>
      </Stack>

      <Dialog open={logoutOpen} onClose={() => setLogoutOpen(false)}>
        <DialogTitle>{text.logoutTitle}</DialogTitle>
        <DialogContent>
          <DialogContentText>{text.logoutBody}</DialogContentText>
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setLogoutOpen(false)}>{text.cancel}</Button>
          <Button color="error" onClick={confirmLogout} autoFocus>
            {text.logout}
          </Button>
        </DialogActions>
      </Dialog>
    </BasePage>
  )
}

export default MinePage
