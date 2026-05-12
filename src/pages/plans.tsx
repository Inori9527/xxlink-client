import {
  BoltRounded,
  CardGiftcardRounded,
  CheckCircleRounded,
  DevicesRounded,
  OpenInNewRounded,
  RefreshRounded,
  ShieldRounded,
  SpeedRounded,
  WorkspacePremiumRounded,
} from '@mui/icons-material'
import {
  Alert,
  Box,
  Button,
  Chip,
  CircularProgress,
  LinearProgress,
  Paper,
  Skeleton,
  Stack,
  Typography,
  ToggleButton,
  ToggleButtonGroup,
  alpha,
  useTheme,
} from '@mui/material'
import { open } from '@tauri-apps/plugin-shell'
import { useLockFn } from 'ahooks'
import { useCallback, useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'

import { BasePage } from '@/components/base'
import {
  api,
  isSubscriptionActiveNow,
  type Plan,
  type PublicBenefitStatus,
  type Subscription,
  type UsageData,
} from '@/services/api'
import { showNotice } from '@/services/notice-service'

const DASHBOARD_RECHARGE_URL = 'https://xxlink.net/dashboard/recharge'
const TRUSTED_URL_HOSTS = new Set([
  'xxlink.net',
  'www.xxlink.net',
  'api.xxlink.net',
])
const TRUSTED_URL_SUFFIXES = ['.stripe.com', '.paypal.com']
type BillingPeriod = 'month' | 'quarter' | 'year'

const BILLING_PERIODS: Array<{ value: BillingPeriod; labelKey: string }> = [
  { value: 'month', labelKey: 'plans.page.periods.month' },
  { value: 'quarter', labelKey: 'plans.page.periods.quarter' },
  { value: 'year', labelKey: 'plans.page.periods.year' },
]

function formatTraffic(bytes: number): string {
  if (bytes <= 0) return '0 GB'
  const tb = bytes / 1024 ** 4
  if (tb >= 1) return `${tb.toFixed(tb >= 10 ? 0 : 2)} TB`
  const gb = bytes / 1024 ** 3
  return `${gb.toFixed(gb >= 10 ? 0 : 2)} GB`
}

function getNumericBytes(value: string | number | undefined): number {
  if (typeof value === 'number') return Number.isFinite(value) ? value : 0
  if (typeof value === 'string') {
    const parsed = Number(value)
    return Number.isFinite(parsed) ? parsed : 0
  }
  return 0
}

function formatDate(iso: string | null | undefined, locale: string): string {
  if (!iso) return '--'
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return '--'
  return date.toLocaleDateString(locale.startsWith('zh') ? 'zh-CN' : 'en-US', {
    year: 'numeric',
    month: 'long',
    day: 'numeric',
  })
}

function getBillingPeriod(days: number): BillingPeriod {
  if (days >= 360) return 'year'
  if (days >= 88) return 'quarter'
  return 'month'
}

function formatDuration(
  days: number,
  labels: {
    month: string
    quarter: string
    year: string
    days: (count: number) => string
  },
): string {
  if (days >= 360) return labels.year
  if (days >= 88) return labels.quarter
  if (days >= 28) return labels.month
  return labels.days(days)
}

function formatPrice(price: number): string {
  const normalized = price > 999 ? price / 100 : price
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
    minimumFractionDigits: normalized % 1 === 0 ? 0 : 2,
  }).format(normalized)
}

function formatCooldownHours(
  status: PublicBenefitStatus,
  labels: {
    available: string
    hours: (count: number) => string
    days: (count: number) => string
  },
): string {
  const hours =
    typeof status.cooldownHours === 'number'
      ? status.cooldownHours
      : typeof status.cooldownDays === 'number'
        ? status.cooldownDays * 24
        : 0
  if (hours <= 0) return labels.available
  if (hours < 24) return labels.hours(Math.ceil(hours))
  return labels.days(Math.ceil(hours / 24))
}

function isTrustedUrl(rawUrl: string): boolean {
  try {
    const url = new URL(rawUrl)
    if (url.protocol !== 'https:') return false
    if (TRUSTED_URL_HOSTS.has(url.hostname)) return true
    return TRUSTED_URL_SUFFIXES.some((suffix) => url.hostname.endsWith(suffix))
  } catch {
    return false
  }
}

const PlansPage = () => {
  const { i18n, t } = useTranslation()
  const theme = useTheme()
  const [plans, setPlans] = useState<Plan[]>([])
  const [subscription, setSubscription] = useState<Subscription | null>(null)
  const [usage, setUsage] = useState<UsageData | null>(null)
  const [publicBenefit, setPublicBenefit] =
    useState<PublicBenefitStatus | null>(null)
  const [loading, setLoading] = useState(true)
  const [refreshing, setRefreshing] = useState(false)
  const [claimingBenefit, setClaimingBenefit] = useState(false)
  const [checkoutPlanId, setCheckoutPlanId] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [preferredBillingPeriod, setPreferredBillingPeriod] =
    useState<BillingPeriod>('month')
  const durationLabels = useMemo(
    () => ({
      month: t('plans.page.periods.month'),
      quarter: t('plans.page.periods.quarter'),
      year: t('plans.page.periods.year'),
      days: (count: number) => t('plans.page.duration.days', { count }),
    }),
    [t],
  )
  const cooldownLabels = useMemo(
    () => ({
      available: t('plans.trial.available'),
      hours: (count: number) => t('plans.trial.cooldownHours', { count }),
      days: (count: number) => t('plans.trial.cooldownDays', { count }),
    }),
    [t],
  )

  const loadPlans = useCallback(async () => {
    setError(null)
    const [plansResult, subResult, usageResult, benefitResult] =
      await Promise.allSettled([
        api.subscription.plans(),
        api.subscription.current(),
        api.user.usage(),
        api.user.publicBenefit(),
      ])

    if (plansResult.status === 'fulfilled') {
      setPlans(plansResult.value)
    } else {
      setError(t('plans.page.feedback.errors.loadFailed'))
    }

    if (subResult.status === 'fulfilled') setSubscription(subResult.value)
    if (usageResult.status === 'fulfilled') setUsage(usageResult.value)
    if (benefitResult.status === 'fulfilled')
      setPublicBenefit(benefitResult.value)
  }, [t])

  useEffect(() => {
    loadPlans().finally(() => setLoading(false))
  }, [loadPlans])

  const activeSubscription = isSubscriptionActiveNow(subscription)
    ? subscription
    : null

  const sortedPlans = useMemo(
    () =>
      [...plans].sort((a, b) => {
        const durationDiff = a.duration - b.duration
        if (durationDiff !== 0) return durationDiff
        return a.price - b.price
      }),
    [plans],
  )

  const groupedPlans = useMemo(() => {
    const groups: Record<BillingPeriod, Plan[]> = {
      month: [],
      quarter: [],
      year: [],
    }
    for (const plan of sortedPlans) {
      groups[getBillingPeriod(plan.duration)].push(plan)
    }
    return groups
  }, [sortedPlans])

  const availableBillingPeriods = useMemo(
    () =>
      BILLING_PERIODS.filter((period) => groupedPlans[period.value].length > 0),
    [groupedPlans],
  )

  const currentBillingPeriod = activeSubscription
    ? getBillingPeriod(activeSubscription.plan.duration)
    : null
  const selectedBillingPeriod =
    groupedPlans[preferredBillingPeriod].length > 0
      ? preferredBillingPeriod
      : currentBillingPeriod && groupedPlans[currentBillingPeriod].length > 0
        ? currentBillingPeriod
        : (availableBillingPeriods[0]?.value ?? preferredBillingPeriod)
  const visiblePlans = groupedPlans[selectedBillingPeriod]

  const used = getNumericBytes(usage?.trafficUsed)
  const limit = getNumericBytes(usage?.trafficLimit)
  const remaining = getNumericBytes(usage?.trafficRemaining)
  const percent =
    typeof usage?.percentUsed === 'number'
      ? Math.min(Math.max(usage.percentUsed, 0), 100)
      : limit > 0
        ? Math.min((used / limit) * 100, 100)
        : 0

  const handleRefresh = useLockFn(async () => {
    setRefreshing(true)
    try {
      await loadPlans()
    } finally {
      setRefreshing(false)
    }
  })

  const handleClaimBenefit = useLockFn(async () => {
    setClaimingBenefit(true)
    setError(null)
    try {
      const benefitData = await api.user.claimPublicBenefit()
      setPublicBenefit(benefitData)
      await loadPlans()
      showNotice.success(t('plans.trial.claimSuccess'))
    } catch (claimError) {
      const message =
        claimError instanceof Error
          ? claimError.message
          : t('plans.trial.claimFailed')
      setError(message)
    } finally {
      setClaimingBenefit(false)
    }
  })

  const handleSubscribe = useLockFn(async (plan: Plan) => {
    setCheckoutPlanId(plan.id)
    setError(null)
    try {
      const { sessionUrl } = await api.payment.createCheckout(plan.id)
      if (!sessionUrl || !isTrustedUrl(sessionUrl)) {
        throw new Error(t('plans.page.feedback.errors.untrustedCheckout'))
      }
      await open(sessionUrl)
    } catch (checkoutError) {
      const message =
        checkoutError instanceof Error
          ? checkoutError.message
          : t('plans.page.feedback.errors.purchaseFailed')
      setError(message)
    } finally {
      setCheckoutPlanId(null)
    }
  })

  return (
    <BasePage
      title={t('plans.page.title')}
      header={
        <Button
          size="small"
          variant="outlined"
          startIcon={
            refreshing ? <CircularProgress size={14} /> : <RefreshRounded />
          }
          onClick={handleRefresh}
          disabled={refreshing || loading}
          sx={{ borderRadius: 999, fontWeight: 900 }}
        >
          {t('plans.page.actions.refresh')}
        </Button>
      }
      contentStyle={{ padding: '8px 12px 16px' }}
    >
      <Stack spacing={1.5} sx={{ maxWidth: 1080, mx: 'auto' }}>
        {error && (
          <Alert
            severity="error"
            sx={{ borderRadius: 3 }}
            onClose={() => setError(null)}
          >
            {error}
          </Alert>
        )}

        <Paper
          elevation={0}
          sx={{
            p: 2,
            borderRadius: 4,
            overflow: 'hidden',
            position: 'relative',
            border: `1px solid ${alpha(theme.palette.primary.main, 0.18)}`,
            background:
              theme.palette.mode === 'dark'
                ? 'radial-gradient(circle at 8% 0%, rgba(34,211,238,0.18), transparent 36%), linear-gradient(135deg, rgba(12,18,28,0.98), rgba(14,23,31,0.96))'
                : 'linear-gradient(135deg,#F7FCFF,#FFFFFF)',
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
                  width: 46,
                  height: 46,
                  borderRadius: 3,
                  display: 'grid',
                  placeItems: 'center',
                  color: '#0FEDD2',
                  bgcolor: alpha('#0FEDD2', 0.12),
                }}
              >
                <WorkspacePremiumRounded />
              </Box>
              <Box>
                <Typography variant="h5" fontWeight={950}>
                  {usage?.plan?.name ??
                    activeSubscription?.plan.name ??
                    t('plans.page.current.fallback')}
                </Typography>
                <Typography variant="body2" color="text.secondary">
                  {usage?.expireAt || activeSubscription?.expireAt
                    ? t('plans.page.current.expirePrefix', {
                        date: formatDate(
                          usage?.expireAt ?? activeSubscription?.expireAt,
                          i18n.language,
                        ),
                      })
                    : t('plans.page.current.syncHint')}
                </Typography>
              </Box>
            </Stack>

            <Box sx={{ minWidth: { md: 360 } }}>
              <Stack direction="row" justifyContent="space-between">
                <Typography variant="body2" color="text.secondary">
                  {t('plans.page.current.labels.trafficUsage')}
                </Typography>
                <Typography variant="body2" fontWeight={900}>
                  {formatTraffic(used)} /{' '}
                  {limit > 0 ? formatTraffic(limit) : '--'}
                </Typography>
              </Stack>
              <LinearProgress
                variant="determinate"
                value={percent}
                sx={{
                  mt: 1,
                  height: 9,
                  borderRadius: 999,
                  bgcolor: alpha(theme.palette.common.white, 0.08),
                  '& .MuiLinearProgress-bar': {
                    borderRadius: 999,
                    background:
                      percent > 80
                        ? 'linear-gradient(90deg,#F59E0B,#EF4444)'
                        : 'linear-gradient(90deg,#0FEDD2,#2F80ED)',
                  },
                }}
              />
              <Typography variant="caption" color="text.secondary">
                {t('plans.page.current.labels.remaining', {
                  traffic: formatTraffic(remaining),
                })}
              </Typography>
            </Box>
          </Stack>
        </Paper>

        {publicBenefit?.visible && publicBenefit.isTrial && (
          <Paper
            elevation={0}
            sx={{
              p: 2,
              borderRadius: 4,
              border: `1px solid ${alpha('#0FEDD2', 0.28)}`,
              bgcolor:
                theme.palette.mode === 'dark'
                  ? alpha('#0FEDD2', 0.08)
                  : alpha('#0FEDD2', 0.06),
            }}
          >
            <Stack
              direction={{ xs: 'column', md: 'row' }}
              spacing={1.5}
              justifyContent="space-between"
              alignItems={{ xs: 'stretch', md: 'center' }}
            >
              <Stack direction="row" spacing={1.5} alignItems="center">
                <Box
                  sx={{
                    width: 42,
                    height: 42,
                    borderRadius: 3,
                    display: 'grid',
                    placeItems: 'center',
                    color: '#0FEDD2',
                    bgcolor: alpha('#0FEDD2', 0.14),
                  }}
                >
                  <CardGiftcardRounded />
                </Box>
                <Box>
                  <Typography fontWeight={950}>
                    {t('plans.trial.title')}
                  </Typography>
                  <Typography variant="body2" color="text.secondary">
                    {t('plans.trial.subtitle', {
                      traffic: formatTraffic(
                        getNumericBytes(publicBenefit.claimBytes),
                      ),
                    })}
                    {publicBenefit.canClaim
                      ? t('plans.trial.available')
                      : formatCooldownHours(publicBenefit, cooldownLabels)}
                  </Typography>
                </Box>
              </Stack>
              <Button
                variant="contained"
                color="success"
                onClick={handleClaimBenefit}
                disabled={
                  claimingBenefit ||
                  !publicBenefit.emailVerified ||
                  !publicBenefit.canClaim
                }
                sx={{ borderRadius: 999, fontWeight: 950, px: 3 }}
              >
                {claimingBenefit
                  ? t('plans.trial.claiming')
                  : publicBenefit.canClaim
                    ? t('plans.trial.claim')
                    : publicBenefit.emailVerified
                      ? formatCooldownHours(publicBenefit, cooldownLabels)
                      : t('plans.trial.verifyEmail')}
              </Button>
            </Stack>
          </Paper>
        )}

        <Stack
          direction={{ xs: 'column', sm: 'row' }}
          justifyContent="space-between"
          alignItems={{ xs: 'flex-start', sm: 'center' }}
          spacing={1}
          sx={{ px: 0.5 }}
        >
          <Box>
            <Typography variant="h6" fontWeight={950}>
              {t('plans.page.sections.available')}
            </Typography>
            <Typography variant="body2" color="text.secondary">
              {t('plans.page.sections.availableHint')}
            </Typography>
          </Box>
          <Button
            variant="text"
            endIcon={<OpenInNewRounded />}
            onClick={() => void open(DASHBOARD_RECHARGE_URL)}
            sx={{ borderRadius: 999, fontWeight: 900 }}
          >
            {t('plans.page.actions.openDashboard')}
          </Button>
        </Stack>

        {availableBillingPeriods.length > 0 && (
          <ToggleButtonGroup
            exclusive
            size="small"
            value={selectedBillingPeriod}
            onChange={(_, value: BillingPeriod | null) => {
              if (value) setPreferredBillingPeriod(value)
            }}
            sx={{
              alignSelf: 'center',
              p: 0.4,
              borderRadius: 999,
              bgcolor: alpha(theme.palette.common.white, 0.06),
              border: `1px solid ${alpha(theme.palette.divider, 0.5)}`,
              '& .MuiToggleButton-root': {
                minWidth: 92,
                border: 0,
                borderRadius: 999,
                fontWeight: 950,
                px: 2.4,
              },
              '& .Mui-selected': {
                color: '#03151A !important',
                bgcolor: '#0FEDD2 !important',
              },
            }}
          >
            {availableBillingPeriods.map((period) => (
              <ToggleButton key={period.value} value={period.value}>
                {t(period.labelKey)}
              </ToggleButton>
            ))}
          </ToggleButtonGroup>
        )}

        {loading ? (
          <Box
            sx={{
              display: 'grid',
              gridTemplateColumns: {
                xs: '1fr',
                md: 'repeat(3, minmax(0, 1fr))',
              },
              gap: 1.5,
            }}
          >
            {[0, 1, 2].map((item) => (
              <Skeleton
                key={item}
                variant="rounded"
                height={260}
                sx={{ borderRadius: 4 }}
              />
            ))}
          </Box>
        ) : visiblePlans.length === 0 ? (
          <Paper
            elevation={0}
            sx={{
              p: 4,
              borderRadius: 4,
              textAlign: 'center',
              border: `1px dashed ${alpha(theme.palette.divider, 0.7)}`,
              bgcolor:
                theme.palette.mode === 'dark'
                  ? alpha('#101923', 0.84)
                  : '#FFFFFF',
            }}
          >
            <Typography variant="h6" fontWeight={950}>
              {t('plans.page.empty.title')}
            </Typography>
            <Typography
              variant="body2"
              color="text.secondary"
              sx={{ mt: 0.75 }}
            >
              {t('plans.page.empty.subtitle')}
            </Typography>
            <Button
              variant="contained"
              endIcon={<OpenInNewRounded />}
              onClick={() => void open(DASHBOARD_RECHARGE_URL)}
              sx={{ mt: 2, borderRadius: 999, fontWeight: 950 }}
            >
              {t('plans.page.actions.openDashboard')}
            </Button>
          </Paper>
        ) : (
          <Box
            sx={{
              display: 'grid',
              gridTemplateColumns: {
                xs: '1fr',
                md: 'repeat(3, minmax(0, 1fr))',
              },
              gap: 1.5,
            }}
          >
            {visiblePlans.map((plan, index) => {
              const isCurrent = activeSubscription?.planId === plan.id
              const processing = checkoutPlanId === plan.id
              const accent =
                index % 3 === 0
                  ? '#0FEDD2'
                  : index % 3 === 1
                    ? '#2F80ED'
                    : '#14B8A6'

              return (
                <Paper
                  key={plan.id}
                  elevation={0}
                  sx={{
                    p: 2.4,
                    minHeight: 258,
                    display: 'flex',
                    flexDirection: 'column',
                    borderRadius: 4,
                    border: `1px solid ${
                      isCurrent
                        ? alpha(accent, 0.78)
                        : alpha(theme.palette.divider, 0.5)
                    }`,
                    bgcolor:
                      theme.palette.mode === 'dark'
                        ? alpha('#101923', 0.92)
                        : '#FFFFFF',
                    boxShadow: isCurrent
                      ? `0 20px 60px ${alpha(accent, 0.12)}`
                      : `0 16px 42px ${alpha('#020617', theme.palette.mode === 'dark' ? 0.22 : 0.06)}`,
                  }}
                >
                  <Stack
                    direction="row"
                    justifyContent="space-between"
                    spacing={1}
                  >
                    <Box>
                      <Typography variant="h6" fontWeight={950}>
                        {plan.name}
                      </Typography>
                      <Typography variant="body2" color="text.secondary">
                        {formatDuration(plan.duration, durationLabels)}
                      </Typography>
                    </Box>
                    {isCurrent && (
                      <Chip
                        size="small"
                        icon={<CheckCircleRounded />}
                        label={t('plans.page.card.badge')}
                        sx={{
                          bgcolor: alpha(accent, 0.16),
                          color: accent,
                          fontWeight: 950,
                          '.MuiChip-icon': { color: accent },
                        }}
                      />
                    )}
                  </Stack>

                  <Box sx={{ my: 2 }}>
                    <Typography component="span" variant="h3" fontWeight={950}>
                      {formatPrice(plan.price)}
                    </Typography>
                    <Typography
                      component="span"
                      color="text.secondary"
                      sx={{ ml: 0.5 }}
                    >
                      / {formatDuration(plan.duration, durationLabels)}
                    </Typography>
                  </Box>

                  <Stack spacing={1.1} sx={{ flex: 1 }}>
                    <Stack direction="row" spacing={1} alignItems="center">
                      <BoltRounded sx={{ color: accent, fontSize: 19 }} />
                      <Typography variant="body2" color="text.secondary">
                        {t('plans.page.card.features.trafficValue', {
                          traffic: formatTraffic(
                            getNumericBytes(plan.trafficLimit),
                          ),
                        })}
                      </Typography>
                    </Stack>
                    <Stack direction="row" spacing={1} alignItems="center">
                      <SpeedRounded sx={{ color: accent, fontSize: 19 }} />
                      <Typography variant="body2" color="text.secondary">
                        {plan.speedLimit
                          ? t('plans.page.card.features.speedMbps', {
                              value: plan.speedLimit,
                            })
                          : t('plans.page.card.features.unlimited')}
                      </Typography>
                    </Stack>
                    <Stack direction="row" spacing={1} alignItems="center">
                      <DevicesRounded sx={{ color: accent, fontSize: 19 }} />
                      <Typography variant="body2" color="text.secondary">
                        {t('plans.page.card.features.devicesValue', {
                          count: plan.maxDevices,
                        })}
                      </Typography>
                    </Stack>
                    <Stack direction="row" spacing={1} alignItems="center">
                      <ShieldRounded sx={{ color: accent, fontSize: 19 }} />
                      <Typography variant="body2" color="text.secondary">
                        {t('plans.page.card.features.validUntilExpire')}
                      </Typography>
                    </Stack>
                  </Stack>

                  <Button
                    fullWidth
                    variant={isCurrent ? 'outlined' : 'contained'}
                    disabled={
                      isCurrent || processing || checkoutPlanId !== null
                    }
                    onClick={() => void handleSubscribe(plan)}
                    endIcon={
                      processing ? (
                        <CircularProgress size={16} color="inherit" />
                      ) : (
                        <OpenInNewRounded />
                      )
                    }
                    sx={{
                      mt: 2,
                      borderRadius: 999,
                      py: 1.1,
                      fontWeight: 950,
                      bgcolor: isCurrent ? undefined : accent,
                      color: isCurrent ? accent : '#03151A',
                      '&:hover': {
                        bgcolor: isCurrent ? alpha(accent, 0.08) : accent,
                        filter: 'brightness(1.04)',
                      },
                    }}
                  >
                    {isCurrent
                      ? t('plans.page.card.actions.current')
                      : processing
                        ? t('plans.page.card.actions.opening')
                        : t('plans.page.card.actions.subscribe')}
                  </Button>
                </Paper>
              )
            })}
          </Box>
        )}
      </Stack>
    </BasePage>
  )
}

export default PlansPage
