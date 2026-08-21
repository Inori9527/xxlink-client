import {
  ChevronRightRounded,
  ContentCopyRounded,
  ExitToAppRounded,
  OpenInNewRounded,
  RefreshRounded,
  SystemUpdateAltRounded,
  TuneRounded,
} from '@mui/icons-material'
import {
  Alert,
  Box,
  Button,
  ButtonGroup,
  Chip,
  CircularProgress,
  Dialog,
  DialogActions,
  DialogContent,
  DialogContentText,
  DialogTitle,
  Divider,
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
import { UpdateButton } from '@/components/layout/update-button'
import { PromoRedeemPanel } from '@/components/mine/promo-redeem-panel'
import { UpdateViewer } from '@/components/setting/mods/update-viewer'
import { useConnectModeControl } from '@/hooks/use-connect-mode-control'
import { useUpdate } from '@/hooks/use-update'
import { designTokens } from '@/pages/_theme'
import { useAppData } from '@/providers/app-data-context'
import {
  formatUsagePairLabel,
  shouldShowRefreshFailureNotice,
} from '@/services/account-display-state'
import {
  ACCOUNT_LKG_CHANGED_EVENT,
  readAccountLkgCache,
  writeAccountLkgCache,
} from '@/services/account-lkg-cache'
import { runAccountRefreshExclusive } from '@/services/account-refresh-coordinator'
import {
  getUsageAuthorizationEvidence,
  isRecognizedUsageSnapshot,
  parseAuthoritativeBytes,
  resolveAccountAccessDecision,
} from '@/services/account-state-validation'
import { useAuth } from '@/services/auth-store'
import {
  backendController,
  isBackendSubjectCurrent,
  type UsageView,
} from '@/services/backend-controller'
import { showNotice } from '@/services/notice-service'
import { runtimeActionController } from '@/services/runtime-action-controller'
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
        borderRadius: designTokens.radius.md,
        cursor: onClick ? 'pointer' : 'default',
        transition: theme.transitions.create(['background-color', 'transform']),
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
          borderRadius: designTokens.radius.md,
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
      {action}
      {onClick && <ChevronRightRounded color={danger ? 'error' : 'disabled'} />}
    </Box>
  )
}

const MinePage = () => {
  const { t } = useTranslation()
  const theme = useTheme()
  const navigate = useNavigate()
  const { user } = useAuth()
  const { refreshProxy } = useAppData()
  const updateViewerRef = useRef<DialogRef>(null)
  const { updateInfo, checkUpdate, loading: checkingUpdate } = useUpdate(false)
  const modeControl = useConnectModeControl({ onRefreshProxy: refreshProxy })
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
    settings: t('mine.sections.settings'),
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
    connectMode: t('mine.rows.connectMode.title'),
    connectModeDescription: t('mine.rows.connectMode.description'),
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

    void runAccountRefreshExclusive(async () => {
      if (cancelled || !isBackendSubjectCurrent(user.id)) return
      const value = await backendController.usage()
      if (cancelled || !isBackendSubjectCurrent(user.id)) return
      if (!isRecognizedUsageSnapshot(value)) {
        throw new Error('invalid_usage_snapshot')
      }
      const authorization = getUsageAuthorizationEvidence(value)
      const accessDecision = resolveAccountAccessDecision({
        subscriptionKnown: false,
        subscriptionActive: false,
        publicBenefitKnown: false,
        activeBenefitBytes: 0,
        usageKnown: true,
        usageAuthorizationKnown: authorization.known,
        usageAuthorized: authorization.authorized,
        trafficRemaining: parseAuthoritativeBytes(value.trafficRemaining) ?? 0,
      })
      setUsage(value)
      setUsageRefreshFailed(false)
      writeAccountLkgCache(user.id, {
        usage: value,
        accessDecision:
          accessDecision === 'unknown' ? undefined : accessDecision,
      })
    }).catch(() => {
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
      const cleaned = await manualLogout()
      if (!cleaned) {
        const error = new Error('logout_cleanup_pending')
        reportSafeClientFailure('mine-manual-logout', error)
        showNotice.error(
          toSafeClientErrorMessage(classifyClientError(error).kind, t),
        )
      }
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
      await runtimeActionController.copyDiagnostics()
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
  const accountLabel = user?.email ?? text.userFallback
  const accountInitial = accountLabel.trim().charAt(0).toUpperCase() || 'X'

  return (
    <BasePage
      title={text.pageTitle}
      header={<UpdateButton />}
      contentStyle={{ height: '100%' }}
    >
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
        <Paper variant="surface" sx={{ p: 2.5 }}>
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
                  borderRadius: designTokens.radius.pill,
                  display: 'grid',
                  placeItems: 'center',
                  color: 'primary.main',
                  bgcolor: alpha(theme.palette.primary.main, 0.16),
                }}
              >
                <Typography variant="h5" fontWeight={900}>
                  {accountInitial}
                </Typography>
              </Box>
              <Box sx={{ minWidth: 0 }}>
                <Typography variant="h6" fontWeight={900} noWrap>
                  {accountLabel}
                </Typography>
                <Stack
                  direction="row"
                  spacing={1}
                  sx={{ mt: 0.8, flexWrap: 'wrap' }}
                >
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
                color={percent > 80 ? 'error' : 'primary'}
                value={percent}
                sx={{
                  mt: 1,
                  height: 8,
                  borderRadius: designTokens.radius.pill,
                  bgcolor: 'action.hover',
                  '& .MuiLinearProgress-bar': {
                    borderRadius: designTokens.radius.pill,
                  },
                }}
              />
              <Button
                variant="outlined"
                size="small"
                startIcon={<OpenInNewRounded />}
                onClick={() => void open(DASHBOARD_URL)}
                sx={{ mt: 1.5, fontWeight: 900 }}
              >
                {text.openDashboard}
              </Button>
            </Box>
          </Stack>
        </Paper>

        {showUsageRefreshNotice && (
          <Alert severity="warning">{text.usageRefreshFailed}</Alert>
        )}

        <PromoRedeemPanel />

        <Paper variant="surface" sx={{ p: 1, overflow: 'hidden' }}>
          <Typography
            variant="overline"
            color="text.secondary"
            sx={{ px: 2, fontWeight: 800 }}
          >
            {text.common}
          </Typography>
          <MineRow
            icon={<ContentCopyRounded />}
            title={text.diagnostics}
            description={text.diagnosticsDesc}
            onClick={() => void handleCopyDiagnostics()}
          />
          <Divider />
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
                sx={{ fontWeight: 900, flexShrink: 0 }}
              >
                {checkingUpdate ? text.checking : text.check}
              </Button>
            }
            onClick={() => void handleCheckUpdate()}
          />
          <Divider />
          <Typography
            variant="overline"
            color="text.secondary"
            sx={{ px: 2, fontWeight: 800 }}
          >
            {text.settings}
          </Typography>
          <MineRow
            icon={<TuneRounded />}
            title={text.connectMode}
            description={text.connectModeDescription}
            action={
              <ButtonGroup
                size="small"
                aria-label={text.connectMode}
                sx={{
                  flex: '0 0 auto',
                  '& .MuiButton-root': {
                    minWidth: { xs: 0, sm: 58 },
                    px: { xs: 0.9, sm: 1.25 },
                    fontWeight: 850,
                  },
                }}
              >
                <Button
                  variant={
                    modeControl.mode === 'system' ? 'contained' : 'outlined'
                  }
                  onClick={() => modeControl.handleModeChange('system')}
                  disabled={
                    !modeControl.preferencesReady ||
                    modeControl.modeChanging ||
                    modeControl.serviceInstalling
                  }
                >
                  {t('layout.components.connect.mode.system')}
                </Button>
                <Button
                  variant={
                    modeControl.mode === 'both' ? 'contained' : 'outlined'
                  }
                  onClick={() => modeControl.handleModeChange('both')}
                  disabled={
                    !modeControl.preferencesReady ||
                    modeControl.modeChanging ||
                    modeControl.serviceInstalling ||
                    !modeControl.systemStateReady
                  }
                >
                  {t('layout.components.connect.mode.both')}
                </Button>
                <Button
                  variant={
                    modeControl.mode === 'smart' ? 'contained' : 'outlined'
                  }
                  onClick={() => modeControl.handleModeChange('smart')}
                  disabled={
                    !modeControl.preferencesReady ||
                    modeControl.modeChanging ||
                    modeControl.serviceInstalling ||
                    !modeControl.systemStateReady
                  }
                >
                  {t('layout.components.connect.mode.smart')}
                </Button>
              </ButtonGroup>
            }
          />
          {modeControl.serviceInstallMode && (
            <Alert
              severity="warning"
              sx={{ mx: 1, mb: 1 }}
              action={
                <Button
                  color="inherit"
                  size="small"
                  onClick={modeControl.handleInstallService}
                  disabled={
                    modeControl.serviceInstalling ||
                    !modeControl.preferencesReady
                  }
                  startIcon={
                    modeControl.serviceInstalling ? (
                      <CircularProgress size={14} color="inherit" />
                    ) : undefined
                  }
                >
                  {modeControl.serviceInstalling
                    ? t('settings.statuses.clashService.installing')
                    : t(
                        'settings.sections.proxyControl.actions.installService',
                      )}
                </Button>
              }
            >
              {t('settings.sections.proxyControl.tooltips.tunUnavailable')}
            </Alert>
          )}
          <Divider />
          <Typography
            variant="overline"
            color="text.secondary"
            sx={{ px: 2, fontWeight: 800 }}
          >
            {text.account}
          </Typography>
          <MineRow
            danger
            icon={<ExitToAppRounded />}
            title={text.logout}
            description={text.logoutDesc}
            onClick={() => setLogoutOpen(true)}
          />
        </Paper>
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
