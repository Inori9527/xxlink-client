import CheckCircleIcon from '@mui/icons-material/CheckCircle'
import ContentCopyIcon from '@mui/icons-material/ContentCopy'
import {
  Alert,
  Box,
  Button,
  Chip,
  IconButton,
  LinearProgress,
  Paper,
  Skeleton,
  TextField,
  Tooltip,
  Typography,
} from '@mui/material'
import { writeText } from '@tauri-apps/plugin-clipboard-manager'
import { open } from '@tauri-apps/plugin-shell'
import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'

import { BasePage } from '@/components/base'
import { api, type Plan, type Subscription } from '@/services/api'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

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

/**
 * Map raw API/network errors onto user-friendly translated strings.
 * Falls back to the plans.* error keys when no specific match is found.
 */
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

// ---------------------------------------------------------------------------
// Current Subscription Card
// ---------------------------------------------------------------------------

interface CurrentSubCardProps {
  sub: Subscription
  onCopied: () => void
}

const CurrentSubCard = ({ sub, onCopied }: CurrentSubCardProps) => {
  const { t } = useTranslation()
  const used = sub.trafficUsed
  const total = sub.plan.trafficLimit
  const pct = total > 0 ? Math.min((used / total) * 100, 100) : 0

  const handleCopy = async () => {
    try {
      await writeText(sub.subUrl)
      onCopied()
    } catch {
      // ignore
    }
  }

  const statusLabel =
    sub.status === 'ACTIVE'
      ? t('plans.page.current.status.active')
      : sub.status === 'EXPIRED'
        ? t('plans.page.current.status.expired')
        : t('plans.page.current.status.cancelled')

  return (
    <Paper
      elevation={0}
      sx={{
        p: 3,
        mb: 3,
        border: '2px solid #4f46e5',
        borderRadius: 2,
        background:
          'linear-gradient(135deg, rgba(79,70,229,0.08) 0%, rgba(99,102,241,0.04) 100%)',
      }}
    >
      <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, mb: 2 }}>
        <Typography variant="h6" fontWeight={700}>
          {t('plans.page.current.title', { name: sub.plan.name })}
        </Typography>
        <Chip
          icon={<CheckCircleIcon />}
          label={statusLabel}
          size="small"
          sx={{
            bgcolor: sub.status === 'ACTIVE' ? 'success.main' : 'warning.main',
            color: '#fff',
            fontWeight: 600,
          }}
        />
      </Box>

      <Box sx={{ mb: 2 }}>
        <Box sx={{ display: 'flex', justifyContent: 'space-between', mb: 0.5 }}>
          <Typography variant="body2" color="text.secondary">
            {t('plans.page.current.labels.trafficUsage')}
          </Typography>
          <Typography variant="body2" color="text.secondary">
            {formatTraffic(used)} / {formatTraffic(total)} ({pct.toFixed(1)}%)
          </Typography>
        </Box>
        <LinearProgress
          variant="determinate"
          value={pct}
          sx={{
            height: 8,
            borderRadius: 4,
            bgcolor: 'action.hover',
            '& .MuiLinearProgress-bar': {
              bgcolor: pct > 80 ? 'error.main' : '#4f46e5',
              borderRadius: 4,
            },
          }}
        />
      </Box>

      <Box sx={{ display: 'flex', gap: 4, mb: 2, flexWrap: 'wrap' }}>
        <Box>
          <Typography variant="caption" color="text.secondary">
            {t('plans.page.current.labels.startAt')}
          </Typography>
          <Typography variant="body2" fontWeight={600}>
            {formatDate(sub.startAt)}
          </Typography>
        </Box>
        <Box>
          <Typography variant="caption" color="text.secondary">
            {t('plans.page.current.labels.expireAt')}
          </Typography>
          <Typography variant="body2" fontWeight={600}>
            {formatDate(sub.expireAt)}
          </Typography>
        </Box>
      </Box>

      <Box sx={{ display: 'flex', alignItems: 'flex-start', gap: 1 }}>
        <Box sx={{ flex: 1, minWidth: 0 }}>
          <Typography
            variant="caption"
            color="text.secondary"
            component="div"
            sx={{ mb: 0.25 }}
          >
            {t('plans.page.current.labels.subUrl')}
          </Typography>
          <Typography
            variant="caption"
            color="text.secondary"
            component="div"
            sx={{ wordBreak: 'break-all' }}
          >
            {sub.subUrl}
          </Typography>
        </Box>
        <Tooltip title={t('plans.page.current.tooltips.copy')}>
          <IconButton
            size="small"
            onClick={handleCopy}
            sx={{ color: '#4f46e5', flexShrink: 0 }}
          >
            <ContentCopyIcon fontSize="small" />
          </IconButton>
        </Tooltip>
      </Box>
    </Paper>
  )
}

// ---------------------------------------------------------------------------
// Plan Card
// ---------------------------------------------------------------------------

interface PlanCardProps {
  plan: Plan
  isCurrent: boolean
  onPurchase: (planId: string) => Promise<void>
  purchasing: boolean
}

const PlanCard = ({
  plan,
  isCurrent,
  onPurchase,
  purchasing,
}: PlanCardProps) => {
  const { t } = useTranslation()
  const months = Math.round(plan.duration / 30)
  const monthLabel =
    months === 1
      ? t('plans.page.duration.month')
      : t('plans.page.duration.months', { count: months })

  return (
    <Paper
      elevation={0}
      sx={{
        p: 3,
        display: 'flex',
        flexDirection: 'column',
        border: isCurrent ? '2px solid #4f46e5' : '1px solid',
        borderColor: isCurrent ? '#4f46e5' : 'divider',
        borderRadius: 2,
        position: 'relative',
        transition: 'box-shadow 0.2s',
        '&:hover': {
          boxShadow: isCurrent
            ? '0 0 0 2px #4f46e5'
            : '0 4px 20px rgba(0,0,0,0.12)',
        },
      }}
    >
      {isCurrent && (
        <Chip
          label={t('plans.page.card.badge')}
          size="small"
          sx={{
            position: 'absolute',
            top: 12,
            right: 12,
            bgcolor: '#4f46e5',
            color: '#fff',
            fontWeight: 700,
            fontSize: '0.7rem',
          }}
        />
      )}

      <Typography variant="h6" fontWeight={700} gutterBottom>
        {plan.name}
      </Typography>

      <Box sx={{ mb: 2 }}>
        <Typography
          component="span"
          variant="h4"
          fontWeight={800}
          sx={{ color: '#4f46e5' }}
        >
          {formatPrice(plan.price)}
        </Typography>
        <Typography component="span" variant="body2" color="text.secondary">
          /{monthLabel}
        </Typography>
      </Box>

      {plan.description && (
        <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
          {plan.description}
        </Typography>
      )}

      <Box
        sx={{
          flex: 1,
          display: 'flex',
          flexDirection: 'column',
          gap: 1,
          mb: 3,
        }}
      >
        <FeatureRow
          label={t('plans.page.card.features.traffic')}
          value={formatTraffic(plan.trafficLimit)}
        />
        <FeatureRow
          label={t('plans.page.card.features.speed')}
          value={
            plan.speedLimit
              ? t('plans.page.card.features.speedMbps', {
                  value: plan.speedLimit,
                })
              : t('plans.page.card.features.unlimited')
          }
        />
        <FeatureRow
          label={t('plans.page.card.features.devices')}
          value={t('plans.page.card.features.devicesValue', {
            count: plan.maxDevices,
          })}
        />
        <FeatureRow
          label={t('plans.page.card.features.duration')}
          value={monthLabel}
        />
      </Box>

      {isCurrent ? (
        <Button
          variant="outlined"
          disabled
          fullWidth
          sx={{ borderRadius: 1.5 }}
        >
          {t('plans.page.card.actions.current')}
        </Button>
      ) : (
        <Button
          variant="contained"
          fullWidth
          disabled={purchasing}
          onClick={() => onPurchase(plan.id)}
          sx={{
            borderRadius: 1.5,
            bgcolor: '#4f46e5',
            '&:hover': { bgcolor: '#4338ca' },
            fontWeight: 700,
          }}
        >
          {purchasing
            ? t('plans.page.card.actions.processing')
            : t('plans.page.card.actions.purchase')}
        </Button>
      )}
    </Paper>
  )
}

const FeatureRow = ({ label, value }: { label: string; value: string }) => (
  <Box
    sx={{
      display: 'flex',
      justifyContent: 'space-between',
      alignItems: 'center',
    }}
  >
    <Typography variant="body2" color="text.secondary">
      {label}
    </Typography>
    <Typography variant="body2" fontWeight={600}>
      {value}
    </Typography>
  </Box>
)

// ---------------------------------------------------------------------------
// Plans Page
// ---------------------------------------------------------------------------

const PlansPage = () => {
  const { t } = useTranslation()
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

      {/* Current Subscription */}
      {loading ? (
        <Skeleton variant="rounded" height={180} sx={{ mb: 3 }} />
      ) : (
        subscription?.status === 'ACTIVE' && (
          <CurrentSubCard sub={subscription} onCopied={handleCopied} />
        )
      )}

      {/* Plans Grid */}
      <Typography variant="subtitle1" fontWeight={700} sx={{ mb: 2 }}>
        {t('plans.page.sections.available')}
      </Typography>

      <Box
        sx={{
          display: 'grid',
          gridTemplateColumns: {
            xs: '1fr',
            sm: 'repeat(2, 1fr)',
            md: 'repeat(3, 1fr)',
          },
          gap: 2,
          mb: 3,
        }}
      >
        {loading
          ? Array.from({ length: 3 }).map((_, i) => (
              <Skeleton
                key={`skeleton-${String(i)}`}
                variant="rounded"
                height={320}
              />
            ))
          : plans.map((plan) => (
              <PlanCard
                key={plan.id}
                plan={plan}
                isCurrent={
                  subscription?.planId === plan.id &&
                  subscription.status === 'ACTIVE'
                }
                onPurchase={handlePurchase}
                purchasing={purchasingId === plan.id}
              />
            ))}
      </Box>

      {/* Promo Code */}
      {!loading && (
        <Paper
          elevation={0}
          sx={{
            p: 2.5,
            border: '1px solid',
            borderColor: 'divider',
            borderRadius: 2,
          }}
        >
          <Typography variant="subtitle2" fontWeight={600} sx={{ mb: 1.5 }}>
            {t('plans.page.sections.promo')}
          </Typography>
          <Box sx={{ display: 'flex', gap: 1.5, alignItems: 'center' }}>
            <TextField
              size="small"
              placeholder={t('plans.page.form.promoPlaceholder')}
              value={promoCode}
              onChange={(e) => setPromoCode(e.target.value)}
              sx={{ flex: 1, maxWidth: 320 }}
            />
            <Typography variant="body2" color="text.secondary">
              {t('plans.page.form.promoHelp')}
            </Typography>
          </Box>
        </Paper>
      )}
    </BasePage>
  )
}

export default PlansPage
