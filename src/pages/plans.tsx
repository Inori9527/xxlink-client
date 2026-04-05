import CheckCircleIcon from '@mui/icons-material/CheckCircle'
import ContentCopyIcon from '@mui/icons-material/ContentCopy'
import {
  Alert,
  Box,
  Button,
  Chip,
  Grid,
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

function formatDuration(days: number): string {
  const months = Math.round(days / 30)
  return months === 1 ? '月' : `${months} 个月`
}

function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString('zh-CN')
}

// ---------------------------------------------------------------------------
// Current Subscription Card
// ---------------------------------------------------------------------------

interface CurrentSubCardProps {
  sub: Subscription
  onCopied: () => void
}

const CurrentSubCard = ({ sub, onCopied }: CurrentSubCardProps) => {
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
      ? '活跃'
      : sub.status === 'EXPIRED'
        ? '已到期'
        : '已取消'

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
          当前套餐：{sub.plan.name}
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
            流量使用
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
            开始时间
          </Typography>
          <Typography variant="body2" fontWeight={600}>
            {formatDate(sub.startAt)}
          </Typography>
        </Box>
        <Box>
          <Typography variant="caption" color="text.secondary">
            到期时间
          </Typography>
          <Typography variant="body2" fontWeight={600}>
            {formatDate(sub.expireAt)}
          </Typography>
        </Box>
      </Box>

      <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
        <Typography
          variant="caption"
          color="text.secondary"
          noWrap
          sx={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis' }}
        >
          订阅链接：{sub.subUrl}
        </Typography>
        <Tooltip title="复制订阅链接">
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
  const monthLabel = formatDuration(plan.duration)

  return (
    <Paper
      elevation={0}
      sx={{
        p: 3,
        height: '100%',
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
          label="当前套餐"
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
        <FeatureRow label="流量" value={formatTraffic(plan.trafficLimit)} />
        <FeatureRow
          label="限速"
          value={plan.speedLimit ? `${plan.speedLimit} Mbps` : '不限速'}
        />
        <FeatureRow label="设备数" value={`${plan.maxDevices} 台`} />
        <FeatureRow label="有效期" value={monthLabel} />
      </Box>

      {isCurrent ? (
        <Button
          variant="outlined"
          disabled
          fullWidth
          sx={{ borderRadius: 1.5 }}
        >
          当前套餐
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
          {purchasing ? '处理中…' : '购买'}
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
        setError(err instanceof Error ? err.message : '加载失败，请稍后重试')
      } finally {
        setLoading(false)
      }
    }
    load()
  }, [])

  const handlePurchase = async (planId: string) => {
    setPurchasingId(planId)
    try {
      const result = await api.payment.createCheckout(
        planId,
        promoCode.trim() || undefined,
      )
      await open(result.sessionUrl)
    } catch (err) {
      setError(err instanceof Error ? err.message : '创建订单失败，请稍后重试')
    } finally {
      setPurchasingId(null)
    }
  }

  const handleCopied = () => {
    setCopySuccess(true)
    setTimeout(() => setCopySuccess(false), 2000)
  }

  return (
    <BasePage title="套餐购买" contentStyle={{ padding: 16 }}>
      {copySuccess && (
        <Alert
          severity="success"
          sx={{ mb: 2 }}
          onClose={() => setCopySuccess(false)}
        >
          订阅链接已复制到剪贴板
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
        可选套餐
      </Typography>

      <Grid container spacing={2} sx={{ mb: 3 }}>
        {loading
          ? Array.from({ length: 3 }).map((_, i) => (
              <Grid
                key={`skeleton-${String(i)}`}
                size={{ xs: 12, sm: 6, md: 4 }}
              >
                <Skeleton variant="rounded" height={320} />
              </Grid>
            ))
          : plans.map((plan) => (
              <Grid key={plan.id} size={{ xs: 12, sm: 6, md: 4 }}>
                <PlanCard
                  plan={plan}
                  isCurrent={
                    subscription?.planId === plan.id &&
                    subscription.status === 'ACTIVE'
                  }
                  onPurchase={handlePurchase}
                  purchasing={purchasingId === plan.id}
                />
              </Grid>
            ))}
      </Grid>

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
            优惠码
          </Typography>
          <Box sx={{ display: 'flex', gap: 1.5, alignItems: 'center' }}>
            <TextField
              size="small"
              placeholder="输入优惠码（可选）"
              value={promoCode}
              onChange={(e) => setPromoCode(e.target.value)}
              sx={{ flex: 1, maxWidth: 320 }}
            />
            <Typography variant="body2" color="text.secondary">
              购买时将自动应用
            </Typography>
          </Box>
        </Paper>
      )}
    </BasePage>
  )
}

export default PlansPage
