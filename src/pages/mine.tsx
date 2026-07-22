import {
  ChevronRightRounded,
  ContentCopyRounded,
  ExitToAppRounded,
  OpenInNewRounded,
  PersonRounded,
  RefreshRounded,
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
import { useTranslation } from 'react-i18next'
import { useNavigate } from 'react-router'

import { BasePage, type DialogRef } from '@/components/base'
import { PromoRedeemPanel } from '@/components/mine/promo-redeem-panel'
import { UpdateViewer } from '@/components/setting/mods/update-viewer'
import { useUpdate } from '@/hooks/use-update'
import {
  formatUsagePairLabel,
  shouldShowRefreshFailureNotice,
} from '@/services/account-display-state'
import {
  ACCOUNT_LKG_CHANGED_EVENT,
  readAccountLkgCache,
  writeAccountLkgCache,
} from '@/services/account-lkg-cache'
import { useAuth } from '@/services/auth-store'
import {
  backendController,
  isBackendSubjectCurrent,
  type UsageView,
} from '@/services/backend-controller'
import { copyDiagnosticsBundleToClipboard } from '@/services/diagnostics-bundle'
import { showNotice } from '@/services/notice-service'
import {
  classifyClientError,
  reportSafeClientFailure,
  toSafeClientErrorMessage,
} from '@/services/safe-client-error'
import { manualLogout } from '@/services/secure-session-controller'
import parseTraffic from '@/utils/parse-traffic'

const DASHBOARD_URL = 'https://xxlink.net/dashboard'

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
  const { t } = useTranslation()
  const theme = useTheme()
  const navigate = useNavigate()
  const { user } = useAuth()
  const updateViewerRef = useRef<DialogRef>(null)
  const { updateInfo, checkUpdate, loading: checkingUpdate } = useUpdate(false)
  const [logoutOpen, setLogoutOpen] = useState(false)
  const [usage, setUsage] = useState<UsageView | null>(
    () => readAccountLkgCache(user?.id)?.usage ?? null,
  )
  const [usageRefreshFailed, setUsageRefreshFailed] = useState(false)
  const text = {
    pageTitle: t('mine.pageTitle'),
    userFallback: t('mine.userFallback'),
    usage: t('mine.usage'),
    remaining: t('mine.remaining'),
    openDashboard: t('mine.openDashboard'),
    common: t('mine.sections.common'),
    account: t('mine.sections.account'),
    diagnostics: t('mine.rows.diagnostics.title'),
    diagnosticsDesc: t('mine.rows.diagnostics.description'),
    diagnosticsCopied: t('mine.diagnostics.copied'),
    update: t('mine.rows.update.title'),
    updateDesc: t('mine.rows.update.description'),
    updateFound: t('mine.rows.update.found'),
    checking: t('mine.rows.update.checking'),
    check: t('mine.rows.update.check'),
    alreadyLatest: t('mine.rows.update.latest'),
    logout: t('mine.rows.logout.title'),
    logoutDesc: t('mine.rows.logout.description'),
    logoutTitle: t('mine.rows.logout.confirmTitle'),
    logoutBody: t('mine.rows.logout.confirmBody'),
    cancel: t('mine.cancel'),
    currentAccount: t('mine.currentAccount'),
    usageUnavailable: t('mine.usageUnavailable'),
    usageRefreshFailed: t('mine.usageRefreshFailed'),
  }

  useEffect(() => {
    let disposed = false
    let timeoutId: number | undefined

    const applyUsageFromCache = () => {
      if (disposed) return
      setUsage(readAccountLkgCache(user?.id)?.usage ?? null)
      setUsageRefreshFailed(false)
    }

    if (!user?.id) {
      timeoutId = window.setTimeout(applyUsageFromCache, 0)
      return () => {
        disposed = true
        if (timeoutId !== undefined) window.clearTimeout(timeoutId)
      }
    }

    const refreshUsageFromCache = () => {
      if (disposed) return
      setUsage(readAccountLkgCache(user.id)?.usage ?? null)
    }

    timeoutId = window.setTimeout(refreshUsageFromCache, 0)
    window.addEventListener(ACCOUNT_LKG_CHANGED_EVENT, refreshUsageFromCache)

    return () => {
      disposed = true
      if (timeoutId !== undefined) window.clearTimeout(timeoutId)
      window.removeEventListener(
        ACCOUNT_LKG_CHANGED_EVENT,
        refreshUsageFromCache,
      )
    }
  }, [user?.id])

  useEffect(() => {
    if (!user?.id) {
      return
    }

    let cancelled = false

    backendController
      .usage()
      .then((value) => {
        if (cancelled || !isBackendSubjectCurrent(user.id)) return
        setUsage(value)
        setUsageRefreshFailed(false)
        writeAccountLkgCache(user.id, { usage: value })
      })
      .catch(() => {
        if (!cancelled && isBackendSubjectCurrent(user.id)) {
          setUsageRefreshFailed(true)
        }
      })

    return () => {
      cancelled = true
    }
  }, [user?.id])

  const confirmLogout = useLockFn(async () => {
    try {
      await manualLogout()
      setLogoutOpen(false)
      navigate('/login')
    } catch (error) {
      reportSafeClientFailure('mine-manual-logout', error)
      showNotice.error(
        toSafeClientErrorMessage(classifyClientError(error).kind, t),
      )
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

  const handleCopyDiagnostics = async () => {
    try {
      await copyDiagnosticsBundleToClipboard()
      showNotice.success(text.diagnosticsCopied)
    } catch (error) {
      reportSafeClientFailure('mine-copy-diagnostics', error)
      showNotice.error(
        toSafeClientErrorMessage(classifyClientError(error).kind, t),
      )
    }
  }

  const used = usage ? getNumericBytes(usage.trafficUsed) : 0
  const limit = usage ? getNumericBytes(usage.trafficLimit) : 0
  const remaining = usage ? getNumericBytes(usage.trafficRemaining) : 0
  const percent =
    typeof usage?.percentUsed === 'number'
      ? Math.min(Math.max(usage.percentUsed, 0), 100)
      : limit > 0
        ? Math.min((used / limit) * 100, 100)
        : 0
  const usageLabel = formatUsagePairLabel({
    usageKnown: usage !== null,
    usedLabel: formatBytes(used),
    limitLabel: limit > 0 ? formatBytes(limit) : null,
    unknownLabel: text.usageUnavailable,
  })
  const remainingLabel = usage ? formatBytes(remaining) : text.usageUnavailable
  const showUsageRefreshNotice = shouldShowRefreshFailureNotice({
    refreshFailed: usageRefreshFailed,
    hasLastKnownGood: usage !== null,
  })

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
                  <Chip
                    size="small"
                    label={
                      usage?.plan?.name ??
                      (usage ? text.currentAccount : text.usageUnavailable)
                    }
                  />
                  <Chip
                    size="small"
                    color={usage ? 'success' : 'default'}
                    label={`${text.remaining} ${remainingLabel}`}
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
                  {usageLabel}
                </Typography>
              </Stack>
              <LinearProgress
                variant={usage ? 'determinate' : 'indeterminate'}
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

        {showUsageRefreshNotice && (
          <Alert severity="warning" sx={{ borderRadius: 3 }}>
            {text.usageRefreshFailed}
          </Alert>
        )}

        <MineSection title={text.common}>
          <MineRow
            icon={<ContentCopyRounded />}
            title={text.diagnostics}
            description={text.diagnosticsDesc}
            onClick={() => void handleCopyDiagnostics()}
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

        <PromoRedeemPanel />

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
