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

function formatDate(iso?: string | null): string {
  if (!iso) return '--'
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return '--'
  return date.toLocaleDateString('zh-CN', {
    year: 'numeric',
    month: 'long',
    day: 'numeric',
  })
}

function formatDuration(days: number): string {
  if (days >= 360) return '年卡'
  if (days >= 88) return '季卡'
  if (days >= 28) return '月卡'
  return `${days} 天`
}

function formatPrice(price: number): string {
  const normalized = price > 999 ? price / 100 : price
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
    minimumFractionDigits: normalized % 1 === 0 ? 0 : 2,
  }).format(normalized)
}

function formatCooldownHours(status: PublicBenefitStatus): string {
  const hours =
    typeof status.cooldownHours === 'number'
      ? status.cooldownHours
      : typeof status.cooldownDays === 'number'
        ? status.cooldownDays * 24
        : 0
  if (hours <= 0) return '可领取'
  if (hours < 24) return `${Math.ceil(hours)} 小时后`
  return `${Math.ceil(hours / 24)} 天后`
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
  const { t } = useTranslation()
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
      setError('套餐加载失败，请稍后重试。')
    }

    if (subResult.status === 'fulfilled') setSubscription(subResult.value)
    if (usageResult.status === 'fulfilled') setUsage(usageResult.value)
    if (benefitResult.status === 'fulfilled')
      setPublicBenefit(benefitResult.value)
  }, [])

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
      showNotice.success('公益流量已领取')
    } catch (claimError) {
      const message =
        claimError instanceof Error
          ? claimError.message
          : '领取失败，请稍后重试。'
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
        throw new Error('支付链接未通过安全校验。')
      }
      await open(sessionUrl)
    } catch (checkoutError) {
      const message =
        checkoutError instanceof Error
          ? checkoutError.message
          : '创建订单失败，请稍后重试。'
      setError(message)
    } finally {
      setCheckoutPlanId(null)
    }
  })

  return (
    <BasePage
      title="套餐"
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
          刷新
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
                    '选择适合你的套餐'}
                </Typography>
                <Typography variant="body2" color="text.secondary">
                  {usage?.expireAt || activeSubscription?.expireAt
                    ? `到期 ${formatDate(usage?.expireAt ?? activeSubscription?.expireAt)}`
                    : '购买后会自动同步到客户端'}
                </Typography>
              </Box>
            </Stack>

            <Box sx={{ minWidth: { md: 360 } }}>
              <Stack direction="row" justifyContent="space-between">
                <Typography variant="body2" color="text.secondary">
                  周期用量
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
                剩余 {formatTraffic(remaining)}
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
                    每日{' '}
                    {formatTraffic(getNumericBytes(publicBenefit.claimBytes))}，
                    {publicBenefit.canClaim
                      ? '现在可领取'
                      : formatCooldownHours(publicBenefit)}
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
                      ? formatCooldownHours(publicBenefit)
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
              选择套餐
            </Typography>
            <Typography variant="body2" color="text.secondary">
              在客户端选择，浏览器完成支付。
            </Typography>
          </Box>
          <Button
            variant="text"
            endIcon={<OpenInNewRounded />}
            onClick={() => void open(DASHBOARD_RECHARGE_URL)}
            sx={{ borderRadius: 999, fontWeight: 900 }}
          >
            打开账户页
          </Button>
        </Stack>

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
        ) : sortedPlans.length === 0 ? (
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
              暂无可选套餐
            </Typography>
            <Typography
              variant="body2"
              color="text.secondary"
              sx={{ mt: 0.75 }}
            >
              可先在账户页查看套餐。
            </Typography>
            <Button
              variant="contained"
              endIcon={<OpenInNewRounded />}
              onClick={() => void open(DASHBOARD_RECHARGE_URL)}
              sx={{ mt: 2, borderRadius: 999, fontWeight: 950 }}
            >
              打开账户页
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
            {sortedPlans.map((plan, index) => {
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
                        {formatDuration(plan.duration)}
                      </Typography>
                    </Box>
                    {isCurrent && (
                      <Chip
                        size="small"
                        icon={<CheckCircleRounded />}
                        label="当前"
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
                      / {formatDuration(plan.duration)}
                    </Typography>
                  </Box>

                  <Stack spacing={1.1} sx={{ flex: 1 }}>
                    <Stack direction="row" spacing={1} alignItems="center">
                      <BoltRounded sx={{ color: accent, fontSize: 19 }} />
                      <Typography variant="body2" color="text.secondary">
                        {formatTraffic(getNumericBytes(plan.trafficLimit))} 流量
                      </Typography>
                    </Stack>
                    <Stack direction="row" spacing={1} alignItems="center">
                      <SpeedRounded sx={{ color: accent, fontSize: 19 }} />
                      <Typography variant="body2" color="text.secondary">
                        {plan.speedLimit ? `${plan.speedLimit} Mbps` : '不限速'}
                      </Typography>
                    </Stack>
                    <Stack direction="row" spacing={1} alignItems="center">
                      <DevicesRounded sx={{ color: accent, fontSize: 19 }} />
                      <Typography variant="body2" color="text.secondary">
                        {plan.maxDevices} 台设备
                      </Typography>
                    </Stack>
                    <Stack direction="row" spacing={1} alignItems="center">
                      <ShieldRounded sx={{ color: accent, fontSize: 19 }} />
                      <Typography variant="body2" color="text.secondary">
                        到期前持续可用
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
                    {isCurrent ? '当前套餐' : processing ? '打开中' : '订阅'}
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
