import CheckCircleIcon from '@mui/icons-material/CheckCircle'
import ContentCopyIcon from '@mui/icons-material/ContentCopy'
import DevicesRoundedIcon from '@mui/icons-material/DevicesRounded'
import FlashOnRoundedIcon from '@mui/icons-material/FlashOnRounded'
import LocalOfferRoundedIcon from '@mui/icons-material/LocalOfferRounded'
import ScheduleRoundedIcon from '@mui/icons-material/ScheduleRounded'
import StorageRoundedIcon from '@mui/icons-material/StorageRounded'
import TrendingUpRoundedIcon from '@mui/icons-material/TrendingUpRounded'
import WorkspacePremiumRoundedIcon from '@mui/icons-material/WorkspacePremiumRounded'
import {
  Alert,
  Box,
  Button,
  Chip,
  IconButton,
  LinearProgress,
  Paper,
  Skeleton,
  Stack,
  TextField,
  Tooltip,
  Typography,
  alpha,
  useTheme,
} from '@mui/material'
import { writeText } from '@tauri-apps/plugin-clipboard-manager'
import { open } from '@tauri-apps/plugin-shell'
import { useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'

import { BasePage } from '@/components/base'
import {
  api,
  isSubscriptionActiveNow,
  type Plan,
  type Subscription,
} from '@/services/api'

type CycleKey = 'monthly' | 'quarterly' | 'yearly'

function formatTraffic(bytes: number): string {
  if (bytes <= 0) return '0 GB'
  const tb = bytes / 1024 ** 4
  if (tb >= 1) return `${tb.toFixed(2)} TB`
  const gb = bytes / 1024 ** 3
  return `${gb.toFixed(2)} GB`
}

function formatPrice(cents: number): string {
  return `¥${(cents / 100).toFixed(2)}`
}

function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString()
}

function getRemainingDays(iso: string): number {
  const diff = Date.parse(iso) - Date.now()
  if (!Number.isFinite(diff)) return 0
  return Math.max(0, Math.ceil(diff / (24 * 60 * 60 * 1000)))
}

function getCycle(plan: Plan): CycleKey {
  if (plan.duration >= 300) return 'yearly'
  if (plan.duration >= 75) return 'quarterly'
  return 'monthly'
}

function getCycleLabel(cycle: CycleKey): string {
  switch (cycle) {
    case 'monthly':
      return '月卡'
    case 'quarterly':
      return '季卡'
    case 'yearly':
      return '年卡'
    default:
      return '套餐'
  }
}

function getDurationLabel(days: number): string {
  if (days >= 300) return `${Math.round(days / 30)} 个月`
  if (days >= 75) return `${Math.round(days / 30)} 个月`
  if (days <= 3) return `${days} 天`
  return `${days} 天`
}

function getDailyPrice(price: number, duration: number): string {
  if (!duration) return '0.00'
  return (price / 100 / duration).toFixed(2)
}

function mapError(
  err: unknown,
  t: (key: string) => string,
  fallbackKey: string,
): string {
  if (err instanceof Error) {
    const msg = err.message || ''
    const lower = msg.toLowerCase()
    if (
      msg.includes('401') ||
      lower.includes('unauthorized') ||
      lower.includes('登录')
    ) {
      return t('plans.page.feedback.errors.sessionExpired')
    }
    if (
      lower.includes('network') ||
      lower.includes('fetch') ||
      lower.includes('timeout') ||
      lower.includes('econn')
    ) {
      return t('plans.page.feedback.errors.networkError')
    }
    return t(fallbackKey)
  }
  if (typeof err === 'string' && err) return err
  return t(fallbackKey)
}

function getPlanTone(plan: Plan, currentPlanId?: string): {
  accent: string
  soft: string
  badge?: string
} {
  if (plan.id === currentPlanId) {
    return {
      accent: '#5B5BF6',
      soft: 'rgba(91, 91, 246, 0.14)',
      badge: '当前',
    }
  }

  if (plan.trafficLimit >= 1024 ** 4 || plan.maxDevices >= 5) {
    return {
      accent: '#06B6D4',
      soft: 'rgba(6, 182, 212, 0.14)',
      badge: '旗舰',
    }
  }

  if (plan.price >= 799) {
    return {
      accent: '#10B981',
      soft: 'rgba(16, 185, 129, 0.14)',
      badge: '升级',
    }
  }

  return {
    accent: '#7C3AED',
    soft: 'rgba(124, 58, 237, 0.14)',
  }
}

interface MetricProps {
  label: string
  value: string
  icon: React.ReactNode
}

const DashboardMetric = ({ label, value, icon }: MetricProps) => (
  <Paper
    elevation={0}
    sx={(theme) => ({
      p: 2,
      borderRadius: 3,
      bgcolor:
        theme.palette.mode === 'dark'
          ? alpha(theme.palette.common.white, 0.04)
          : alpha(theme.palette.common.black, 0.04),
      border: `1px solid ${alpha(theme.palette.divider, 0.6)}`,
    })}
  >
    <Stack direction="row" spacing={1.5} alignItems="center">
      <Box
        sx={(theme) => ({
          width: 38,
          height: 38,
          borderRadius: 2,
          display: 'grid',
          placeItems: 'center',
          bgcolor: alpha(theme.palette.primary.main, 0.12),
          color: theme.palette.primary.main,
        })}
      >
        {icon}
      </Box>
      <Box>
        <Typography variant="caption" color="text.secondary">
          {label}
        </Typography>
        <Typography variant="body1" fontWeight={700}>
          {value}
        </Typography>
      </Box>
    </Stack>
  </Paper>
)

interface CurrentDashboardProps {
  sub: Subscription
  onCopied: () => void
}

const CurrentDashboard = ({ sub, onCopied }: CurrentDashboardProps) => {
  const used = sub.trafficUsed
  const total = sub.plan.trafficLimit
  const pct = total > 0 ? Math.min((used / total) * 100, 100) : 0
  const remainingDays = getRemainingDays(sub.expireAt)

  const handleCopy = async () => {
    try {
      await writeText(sub.subUrl)
      onCopied()
    } catch {
      /* ignore */
    }
  }

  return (
    <Paper
      elevation={0}
      sx={(theme) => ({
        p: { xs: 2.5, md: 3 },
        borderRadius: 4,
        mb: 3,
        border: `1px solid ${alpha(theme.palette.primary.main, 0.28)}`,
        background:
          theme.palette.mode === 'dark'
            ? `linear-gradient(135deg, ${alpha(theme.palette.primary.main, 0.18)} 0%, ${alpha('#0F172A', 0.86)} 58%, ${alpha('#111827', 0.94)} 100%)`
            : `linear-gradient(135deg, ${alpha(theme.palette.primary.main, 0.08)} 0%, rgba(255,255,255,0.98) 60%, rgba(248,250,252,0.96) 100%)`,
        boxShadow: `0 24px 50px ${alpha(theme.palette.common.black, 0.12)}`,
      })}
    >
      <Stack
        direction={{ xs: 'column', lg: 'row' }}
        spacing={3}
        justifyContent="space-between"
      >
        <Box sx={{ flex: 1, minWidth: 0 }}>
          <Stack
            direction={{ xs: 'column', sm: 'row' }}
            spacing={1.2}
            justifyContent="space-between"
            alignItems={{ xs: 'flex-start', sm: 'center' }}
            sx={{ mb: 2 }}
          >
            <Box>
              <Typography variant="overline" sx={{ opacity: 0.76 }}>
                当前套餐
              </Typography>
              <Typography variant="h5" fontWeight={800}>
                {sub.plan.name}
              </Typography>
            </Box>
            <Chip
              icon={<CheckCircleIcon />}
              label="订阅有效"
              sx={{
                bgcolor: '#5B5BF6',
                color: '#fff',
                fontWeight: 700,
                '.MuiChip-icon': { color: '#fff' },
              }}
            />
          </Stack>

          <Typography
            variant="body1"
            color="text.secondary"
            sx={{ mb: 2.5, maxWidth: 640 }}
          >
            到期 {formatDate(sub.expireAt)}，剩余 {remainingDays} 天。你可以直接在这里查看当前订阅状态、流量消耗和续费入口。
          </Typography>

          <Box sx={{ mb: 2.5 }}>
            <Stack
              direction="row"
              justifyContent="space-between"
              alignItems="center"
              sx={{ mb: 0.8 }}
            >
              <Typography variant="body2" color="text.secondary">
                流量使用
              </Typography>
              <Typography variant="body2" fontWeight={700}>
                {formatTraffic(used)} / {formatTraffic(total)} ({pct.toFixed(1)}%)
              </Typography>
            </Stack>
            <LinearProgress
              variant="determinate"
              value={pct}
              sx={{
                height: 10,
                borderRadius: 999,
                bgcolor: alpha('#FFFFFF', 0.08),
                '& .MuiLinearProgress-bar': {
                  borderRadius: 999,
                  background:
                    pct > 80
                      ? 'linear-gradient(90deg, #F97316 0%, #EF4444 100%)'
                      : 'linear-gradient(90deg, #6366F1 0%, #22C55E 100%)',
                },
              }}
            />
          </Box>

          <Stack
            direction={{ xs: 'column', md: 'row' }}
            spacing={1.2}
            sx={{ flexWrap: 'wrap' }}
          >
            <Chip
              icon={<StorageRoundedIcon />}
              label={`总流量 ${formatTraffic(total)}`}
              variant="outlined"
            />
            <Chip
              icon={<DevicesRoundedIcon />}
              label={`${sub.plan.maxDevices} 台设备`}
              variant="outlined"
            />
            <Chip
              icon={<ScheduleRoundedIcon />}
              label={`开始于 ${formatDate(sub.startAt)}`}
              variant="outlined"
            />
          </Stack>
        </Box>

        <Box sx={{ width: { xs: '100%', lg: 360 }, flexShrink: 0 }}>
          <Stack spacing={1.25}>
            <DashboardMetric
              label="剩余天数"
              value={`${remainingDays} 天`}
              icon={<ScheduleRoundedIcon fontSize="small" />}
            />
            <DashboardMetric
              label="剩余流量"
              value={formatTraffic(Math.max(total - used, 0))}
              icon={<TrendingUpRoundedIcon fontSize="small" />}
            />
            <DashboardMetric
              label="速度策略"
              value={sub.plan.speedLimit ? `${sub.plan.speedLimit} Mbps` : '不限速'}
              icon={<FlashOnRoundedIcon fontSize="small" />}
            />
          </Stack>

          <Paper
            elevation={0}
            sx={(theme) => ({
              mt: 1.5,
              p: 2,
              borderRadius: 3,
              border: `1px solid ${alpha(theme.palette.divider, 0.6)}`,
              bgcolor: alpha(theme.palette.common.white, 0.03),
            })}
          >
            <Typography variant="caption" color="text.secondary">
              订阅链接
            </Typography>
            <Typography
              variant="body2"
              sx={{ mt: 0.5, wordBreak: 'break-all', opacity: 0.9 }}
            >
              {sub.subUrl}
            </Typography>
            <Button
              variant="contained"
              fullWidth
              startIcon={<ContentCopyIcon />}
              onClick={handleCopy}
              sx={{
                mt: 1.5,
                borderRadius: 2,
                fontWeight: 700,
                bgcolor: '#5B5BF6',
                '&:hover': { bgcolor: '#4B4BE0' },
              }}
            >
              复制订阅地址
            </Button>
          </Paper>
        </Box>
      </Stack>
    </Paper>
  )
}

interface PlanCardProps {
  plan: Plan
  isCurrent: boolean
  currentPlan?: Plan | null
  onPurchase: (planId: string) => Promise<void>
  purchasing: boolean
}

const PlanDashboardCard = ({
  plan,
  isCurrent,
  currentPlan,
  onPurchase,
  purchasing,
}: PlanCardProps) => {
  const theme = useTheme()
  const tone = getPlanTone(plan, currentPlan?.id)
  const durationText = getDurationLabel(plan.duration)
  const pricePerDay = getDailyPrice(plan.price, Math.max(plan.duration, 1))
  const actionLabel = isCurrent
    ? '续费当前套餐'
    : currentPlan
      ? plan.price >= currentPlan.price
        ? '升级到此套餐'
        : '降级（下周期生效）'
      : '立即购买'

  return (
    <Paper
      elevation={0}
      sx={{
        p: 2.5,
        borderRadius: 4,
        position: 'relative',
        border: isCurrent
          ? `2px solid ${tone.accent}`
          : `1px solid ${alpha(theme.palette.divider, 0.85)}`,
        bgcolor:
          theme.palette.mode === 'dark'
            ? alpha(theme.palette.common.white, 0.03)
            : '#FFFFFF',
        boxShadow: isCurrent
          ? `0 16px 34px ${alpha(tone.accent, 0.22)}`
          : `0 12px 24px ${alpha(theme.palette.common.black, 0.08)}`,
        transition: 'transform 0.2s ease, box-shadow 0.2s ease, border-color 0.2s ease',
        '&:hover': {
          transform: 'translateY(-4px)',
          boxShadow: `0 18px 36px ${alpha(tone.accent, isCurrent ? 0.24 : 0.16)}`,
        },
      }}
    >
      {tone.badge && (
        <Chip
          label={tone.badge}
          size="small"
          sx={{
            position: 'absolute',
            top: 14,
            right: 14,
            bgcolor: tone.soft,
            color: tone.accent,
            fontWeight: 800,
          }}
        />
      )}

      <Stack spacing={1.25}>
        <Typography variant="h5" fontWeight={800}>
          {plan.name}
        </Typography>

        <Stack direction="row" spacing={1} alignItems="flex-end">
          <Typography variant="h3" fontWeight={900} sx={{ color: tone.accent }}>
            {formatPrice(plan.price)}
          </Typography>
          <Typography variant="h6" color="text.secondary" sx={{ pb: 0.45 }}>
            / {durationText}
          </Typography>
        </Stack>

        <Typography variant="body2" color="text.secondary">
          日均 ¥{pricePerDay}
        </Typography>

        <Stack direction="row" spacing={1} flexWrap="wrap" useFlexGap>
          <Chip label={formatTraffic(plan.trafficLimit)} variant="outlined" />
          <Chip label={`${plan.maxDevices} 设备`} variant="outlined" />
          <Chip
            label={plan.speedLimit ? `${plan.speedLimit} Mbps` : '不限速'}
            variant="outlined"
          />
        </Stack>

        {plan.description && (
          <Typography
            variant="body1"
            color="text.secondary"
            sx={{ minHeight: 54 }}
          >
            {plan.description}
          </Typography>
        )}

        <Box
          sx={{
            display: 'grid',
            gridTemplateColumns: 'repeat(2, minmax(0, 1fr))',
            gap: 1.25,
            pt: 0.5,
          }}
        >
          <DashboardMetric
            label="流量"
            value={formatTraffic(plan.trafficLimit)}
            icon={<StorageRoundedIcon fontSize="small" />}
          />
          <DashboardMetric
            label="设备数"
            value={`${plan.maxDevices} 台`}
            icon={<DevicesRoundedIcon fontSize="small" />}
          />
          <DashboardMetric
            label="周期"
            value={durationText}
            icon={<ScheduleRoundedIcon fontSize="small" />}
          />
          <DashboardMetric
            label="策略"
            value={plan.speedLimit ? `${plan.speedLimit} Mbps` : '不限速'}
            icon={<FlashOnRoundedIcon fontSize="small" />}
          />
        </Box>

        <Button
          variant="contained"
          fullWidth
          disabled={purchasing}
          onClick={() => onPurchase(plan.id)}
          sx={{
            mt: 1.5,
            borderRadius: 2.5,
            py: 1.2,
            fontWeight: 800,
            bgcolor: isCurrent ? tone.accent : plan.price >= (currentPlan?.price ?? 0) ? '#10B981' : '#5B5BF6',
            '&:hover': {
              bgcolor: isCurrent ? '#4B4BE0' : plan.price >= (currentPlan?.price ?? 0) ? '#0E9F6E' : '#4B4BE0',
            },
          }}
        >
          {purchasing ? '跳转支付中...' : actionLabel}
        </Button>
      </Stack>
    </Paper>
  )
}

const PlansPage = () => {
  const { t } = useTranslation()
  const theme = useTheme()
  const [plans, setPlans] = useState<Plan[]>([])
  const [subscription, setSubscription] = useState<Subscription | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [promoCode, setPromoCode] = useState('')
  const [purchasingId, setPurchasingId] = useState<string | null>(null)
  const [copySuccess, setCopySuccess] = useState(false)

  useEffect(() => {
    const load = async () => {
      setLoading(true)
      setError(null)
      try {
        const [plansData, subData] = await Promise.all([
          api.subscription.plans(),
          api.subscription.current(),
        ])
        setPlans(plansData)
        setSubscription(subData)
      } catch (err) {
        setError(mapError(err, t, 'plans.page.feedback.errors.loadFailed'))
      } finally {
        setLoading(false)
      }
    }
    load()
  }, [t])

  const activeSubscription = isSubscriptionActiveNow(subscription)
    ? subscription
    : null
  const currentPlan = useMemo(
    () => plans.find((plan) => plan.id === activeSubscription?.planId) ?? null,
    [activeSubscription?.planId, plans],
  )

  const cycleOrder: CycleKey[] = ['monthly', 'quarterly', 'yearly']
  const groupedPlans = useMemo(() => {
    return cycleOrder.reduce(
      (acc, cycle) => {
        acc[cycle] = plans
          .filter((plan) => getCycle(plan) === cycle)
          .sort((a, b) => a.price - b.price)
        return acc
      },
      {
        monthly: [] as Plan[],
        quarterly: [] as Plan[],
        yearly: [] as Plan[],
      },
    )
  }, [plans])

  const availableCycles = cycleOrder.filter((cycle) => groupedPlans[cycle].length > 0)
  const [selectedCycle, setSelectedCycle] = useState<CycleKey>('monthly')

  useEffect(() => {
    if (!availableCycles.length) return
    if (!availableCycles.includes(selectedCycle)) {
      setSelectedCycle(availableCycles[0])
      return
    }
    if (activeSubscription) {
      const preferred = getCycle(activeSubscription.plan)
      if (availableCycles.includes(preferred)) {
        setSelectedCycle(preferred)
      }
    }
  }, [availableCycles, selectedCycle, activeSubscription])

  const visiblePlans = groupedPlans[selectedCycle] ?? []

  const handlePurchase = async (planId: string) => {
    setPurchasingId(planId)
    try {
      const result = await api.payment.createCheckout(
        planId,
        promoCode.trim() || undefined,
      )
      await open(result.sessionUrl)
    } catch (err) {
      setError(mapError(err, t, 'plans.page.feedback.errors.purchaseFailed'))
    } finally {
      setPurchasingId(null)
    }
  }

  const handleCopied = () => {
    setCopySuccess(true)
    setTimeout(() => setCopySuccess(false), 2000)
  }

  return (
    <BasePage title={t('plans.page.title')} contentStyle={{ padding: 16 }}>
      {copySuccess && (
        <Alert
          severity="success"
          sx={{ mb: 2 }}
          onClose={() => setCopySuccess(false)}
        >
          {t('plans.page.feedback.copied')}
        </Alert>
      )}

      {error && (
        <Alert severity="error" sx={{ mb: 2 }} onClose={() => setError(null)}>
          {error}
        </Alert>
      )}

      {loading ? (
        <Skeleton variant="rounded" height={260} sx={{ mb: 3, borderRadius: 4 }} />
      ) : activeSubscription ? (
        <CurrentDashboard sub={activeSubscription} onCopied={handleCopied} />
      ) : (
        <Paper
          elevation={0}
          sx={{
            p: 3,
            mb: 3,
            borderRadius: 4,
            border: `1px solid ${alpha(theme.palette.divider, 0.7)}`,
            bgcolor:
              theme.palette.mode === 'dark'
                ? alpha(theme.palette.common.white, 0.03)
                : alpha(theme.palette.common.black, 0.03),
          }}
        >
          <Stack direction="row" spacing={1.5} alignItems="center">
            <Box
              sx={{
                width: 44,
                height: 44,
                borderRadius: 2.5,
                display: 'grid',
                placeItems: 'center',
                bgcolor: alpha(theme.palette.primary.main, 0.12),
                color: theme.palette.primary.main,
              }}
            >
              <WorkspacePremiumRoundedIcon />
            </Box>
            <Box>
              <Typography variant="h6" fontWeight={800}>
                选择适合你的套餐
              </Typography>
              <Typography variant="body2" color="text.secondary">
                先按周期筛选，再从仪表盘卡片里直接进入支付。
              </Typography>
            </Box>
          </Stack>
        </Paper>
      )}

      <Paper
        elevation={0}
        sx={{
          p: { xs: 2, md: 3 },
          borderRadius: 4,
          border: `1px solid ${alpha(theme.palette.divider, 0.7)}`,
          bgcolor:
            theme.palette.mode === 'dark'
              ? alpha(theme.palette.common.white, 0.02)
              : alpha(theme.palette.common.black, 0.02),
        }}
      >
        <Stack
          direction={{ xs: 'column', lg: 'row' }}
          spacing={3}
          justifyContent="space-between"
          sx={{ mb: 3 }}
        >
          <Box>
            <Typography variant="h5" fontWeight={900}>
              选择套餐
            </Typography>
            <Typography variant="body2" color="text.secondary" sx={{ mt: 0.7 }}>
              按周期切换，点击卡片底部按钮即可进入支付。当前套餐会自动高亮显示。
            </Typography>
          </Box>

          <Stack direction={{ xs: 'column', sm: 'row' }} spacing={1.5}>
            <Paper
              elevation={0}
              sx={(theme) => ({
                p: 0.5,
                borderRadius: 999,
                bgcolor:
                  theme.palette.mode === 'dark'
                    ? alpha(theme.palette.common.white, 0.04)
                    : alpha(theme.palette.common.black, 0.04),
                border: `1px solid ${alpha(theme.palette.divider, 0.7)}`,
              })}
            >
              <Stack direction="row" spacing={0.5}>
                {availableCycles.map((cycle) => {
                  const active = selectedCycle === cycle
                  return (
                    <Button
                      key={cycle}
                      onClick={() => setSelectedCycle(cycle)}
                      variant={active ? 'contained' : 'text'}
                      sx={{
                        minWidth: 92,
                        borderRadius: 999,
                        fontWeight: 800,
                        color: active ? '#fff' : 'text.primary',
                        bgcolor: active ? '#5B5BF6' : 'transparent',
                        '&:hover': {
                          bgcolor: active
                            ? '#4B4BE0'
                            : alpha(theme.palette.primary.main, 0.08),
                        },
                      }}
                    >
                      {getCycleLabel(cycle)}
                    </Button>
                  )
                })}
              </Stack>
            </Paper>

            <Paper
              elevation={0}
              sx={(theme) => ({
                p: 1.5,
                minWidth: 220,
                borderRadius: 3,
                bgcolor:
                  theme.palette.mode === 'dark'
                    ? alpha(theme.palette.common.white, 0.04)
                    : '#FFFFFF',
                border: `1px solid ${alpha(theme.palette.divider, 0.7)}`,
              })}
            >
              <Typography variant="caption" color="text.secondary">
                优惠码
              </Typography>
              <Stack direction="row" spacing={1.2} alignItems="center" sx={{ mt: 0.8 }}>
                <TextField
                  size="small"
                  placeholder={t('plans.page.form.promoPlaceholder')}
                  value={promoCode}
                  onChange={(e) => setPromoCode(e.target.value)}
                  sx={{ flex: 1 }}
                />
                <Chip
                  icon={<LocalOfferRoundedIcon />}
                  label="结算时生效"
                  variant="outlined"
                />
              </Stack>
            </Paper>
          </Stack>
        </Stack>

        <Box
          sx={{
            display: 'grid',
            gridTemplateColumns: {
              xs: '1fr',
              md: 'repeat(2, minmax(0, 1fr))',
              xl: 'repeat(3, minmax(0, 1fr))',
            },
            gap: 2,
          }}
        >
          {loading
            ? Array.from({ length: 3 }).map((_, i) => (
                <Skeleton
                  key={`skeleton-${String(i)}`}
                  variant="rounded"
                  height={420}
                  sx={{ borderRadius: 4 }}
                />
              ))
            : visiblePlans.map((plan) => (
                <PlanDashboardCard
                  key={plan.id}
                  plan={plan}
                  isCurrent={activeSubscription?.planId === plan.id}
                  currentPlan={currentPlan}
                  onPurchase={handlePurchase}
                  purchasing={purchasingId === plan.id}
                />
              ))}
        </Box>
      </Paper>
    </BasePage>
  )
}

export default PlansPage
