import CheckCircleIcon from '@mui/icons-material/CheckCircle'
import ContentCopyIcon from '@mui/icons-material/ContentCopy'
import OpenInNewRoundedIcon from '@mui/icons-material/OpenInNewRounded'
import RefreshRoundedIcon from '@mui/icons-material/RefreshRounded'
import ScheduleRoundedIcon from '@mui/icons-material/ScheduleRounded'
import StorageRoundedIcon from '@mui/icons-material/StorageRounded'
import WorkspacePremiumRoundedIcon from '@mui/icons-material/WorkspacePremiumRounded'
import {
  Alert,
  Box,
  Button,
  Chip,
  LinearProgress,
  Paper,
  Skeleton,
  Stack,
  Tooltip,
  Typography,
  alpha,
  useTheme,
} from '@mui/material'
import { writeText } from '@tauri-apps/plugin-clipboard-manager'
import { open } from '@tauri-apps/plugin-shell'
import { useEffect, useState } from 'react'

import { BasePage } from '@/components/base'
import { api, isSubscriptionActiveNow, type Subscription } from '@/services/api'

const WEB_RECHARGE_URL = 'https://xxlink.net/dashboard/recharge'

function formatTraffic(bytes: number): string {
  if (bytes <= 0) return '0 GB'
  const tb = bytes / 1024 ** 4
  if (tb >= 1) return `${tb.toFixed(2)} TB`
  const gb = bytes / 1024 ** 3
  return `${gb.toFixed(2)} GB`
}

function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString()
}

function getRemainingDays(iso: string): number {
  const diff = Date.parse(iso) - Date.now()
  if (!Number.isFinite(diff)) return 0
  return Math.max(0, Math.ceil(diff / (24 * 60 * 60 * 1000)))
}

const PlansPage = () => {
  const theme = useTheme()
  const [subscription, setSubscription] = useState<Subscription | null>(null)
  const [loading, setLoading] = useState(true)
  const [refreshing, setRefreshing] = useState(false)
  const [copySuccess, setCopySuccess] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const loadSubscription = async () => {
    setError(null)
    try {
      const subData = await api.subscription.current()
      setSubscription(subData)
    } catch {
      setError('套餐状态加载失败，请稍后重试。')
    }
  }

  useEffect(() => {
    loadSubscription().finally(() => setLoading(false))
  }, [])

  const activeSubscription = isSubscriptionActiveNow(subscription)
    ? subscription
    : null

  const handleRefresh = async () => {
    setRefreshing(true)
    await loadSubscription()
    setRefreshing(false)
  }

  const handleOpenRecharge = async () => {
    await open(WEB_RECHARGE_URL)
  }

  const handleCopy = async () => {
    if (!activeSubscription?.subUrl) return
    await writeText(activeSubscription.subUrl)
    setCopySuccess(true)
    setTimeout(() => setCopySuccess(false), 2000)
  }

  const used = activeSubscription?.trafficUsed ?? 0
  const total = activeSubscription?.plan.trafficLimit ?? 0
  const pct = total > 0 ? Math.min((used / total) * 100, 100) : 0
  const remainingDays = activeSubscription
    ? getRemainingDays(activeSubscription.expireAt)
    : 0

  return (
    <BasePage title="套餐与续费" contentStyle={{ padding: 16 }}>
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

      <Paper
        elevation={0}
        sx={{
          p: { xs: 2, md: 2.5 },
          borderRadius: 2,
          border: `1px solid ${alpha(theme.palette.divider, 0.75)}`,
          bgcolor:
            theme.palette.mode === 'dark'
              ? alpha(theme.palette.common.white, 0.03)
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
                width: 42,
                height: 42,
                borderRadius: 2,
                display: 'grid',
                placeItems: 'center',
                bgcolor: alpha(theme.palette.primary.main, 0.12),
                color: theme.palette.primary.main,
              }}
            >
              <WorkspacePremiumRoundedIcon />
            </Box>
            <Box>
              <Typography variant="h6" fontWeight={900}>
                Web 版套餐中心
              </Typography>
              <Typography variant="body2" color="text.secondary">
                续费、升级、钱包余额和 TRC-20 支付统一在官网完成。
              </Typography>
            </Box>
          </Stack>

          <Stack direction={{ xs: 'column', sm: 'row' }} spacing={1}>
            <Button
              variant="outlined"
              startIcon={<RefreshRoundedIcon />}
              onClick={handleRefresh}
              disabled={refreshing || loading}
              sx={{ borderRadius: 1.5 }}
            >
              刷新状态
            </Button>
            <Button
              variant="contained"
              startIcon={<OpenInNewRoundedIcon />}
              onClick={handleOpenRecharge}
              sx={{
                borderRadius: 1.5,
                fontWeight: 800,
                bgcolor: '#5B5BF6',
                '&:hover': { bgcolor: '#4B4BE0' },
              }}
            >
              打开续费页面
            </Button>
          </Stack>
        </Stack>
      </Paper>

      {loading ? (
        <Skeleton
          variant="rounded"
          height={260}
          sx={{ mt: 2, borderRadius: 2 }}
        />
      ) : activeSubscription ? (
        <Paper
          elevation={0}
          sx={{
            mt: 2,
            p: { xs: 2, md: 2.5 },
            borderRadius: 2,
            border: `1px solid ${alpha(theme.palette.primary.main, 0.28)}`,
            bgcolor:
              theme.palette.mode === 'dark'
                ? alpha(theme.palette.primary.main, 0.1)
                : alpha(theme.palette.primary.main, 0.04),
          }}
        >
          <Stack spacing={2}>
            <Stack
              direction={{ xs: 'column', sm: 'row' }}
              spacing={1.2}
              justifyContent="space-between"
              alignItems={{ xs: 'flex-start', sm: 'center' }}
            >
              <Box>
                <Typography variant="overline" color="text.secondary">
                  当前套餐
                </Typography>
                <Stack direction="row" spacing={1} alignItems="center">
                  <Typography variant="h5" fontWeight={900}>
                    {activeSubscription.plan.name}
                  </Typography>
                  <Chip
                    size="small"
                    icon={<CheckCircleIcon />}
                    label="有效"
                    sx={{
                      bgcolor: '#10B981',
                      color: '#fff',
                      fontWeight: 800,
                      '.MuiChip-icon': { color: '#fff' },
                    }}
                  />
                </Stack>
              </Box>
              <Typography variant="body2" color="text.secondary">
                到期 {formatDate(activeSubscription.expireAt)}，剩余{' '}
                {remainingDays} 天
              </Typography>
            </Stack>

            <Box>
              <Stack
                direction="row"
                justifyContent="space-between"
                alignItems="center"
                sx={{ mb: 0.8 }}
              >
                <Typography variant="body2" color="text.secondary">
                  流量使用
                </Typography>
                <Typography variant="body2" fontWeight={800}>
                  {formatTraffic(used)} / {formatTraffic(total)} (
                  {pct.toFixed(1)}%)
                </Typography>
              </Stack>
              <LinearProgress
                variant="determinate"
                value={pct}
                sx={{
                  height: 9,
                  borderRadius: 999,
                  bgcolor: alpha(theme.palette.common.white, 0.08),
                  '& .MuiLinearProgress-bar': {
                    borderRadius: 999,
                    background:
                      pct > 80
                        ? 'linear-gradient(90deg, #F97316 0%, #EF4444 100%)'
                        : 'linear-gradient(90deg, #5B5BF6 0%, #10B981 100%)',
                  },
                }}
              />
            </Box>

            <Stack direction={{ xs: 'column', md: 'row' }} spacing={1}>
              <Chip
                icon={<StorageRoundedIcon />}
                label={`总流量 ${formatTraffic(total)}`}
                variant="outlined"
              />
              <Chip
                icon={<ScheduleRoundedIcon />}
                label={`开始于 ${formatDate(activeSubscription.startAt)}`}
                variant="outlined"
              />
              <Tooltip title="复制订阅链接">
                <Button
                  variant="outlined"
                  startIcon={<ContentCopyIcon />}
                  onClick={handleCopy}
                  sx={{ borderRadius: 1.5 }}
                >
                  复制订阅链接
                </Button>
              </Tooltip>
            </Stack>
          </Stack>
        </Paper>
      ) : (
        <Paper
          elevation={0}
          sx={{
            mt: 2,
            p: 3,
            borderRadius: 2,
            border: `1px dashed ${alpha(theme.palette.divider, 0.9)}`,
            textAlign: 'center',
          }}
        >
          <Typography variant="h6" fontWeight={900}>
            暂无有效套餐
          </Typography>
          <Typography variant="body2" color="text.secondary" sx={{ mt: 0.75 }}>
            打开官网套餐中心后，可选择月卡、季卡或年卡并完成支付。
          </Typography>
          <Button
            variant="contained"
            startIcon={<OpenInNewRoundedIcon />}
            onClick={handleOpenRecharge}
            sx={{
              mt: 2,
              borderRadius: 1.5,
              fontWeight: 800,
              bgcolor: '#5B5BF6',
              '&:hover': { bgcolor: '#4B4BE0' },
            }}
          >
            去选择套餐
          </Button>
        </Paper>
      )}
    </BasePage>
  )
}

export default PlansPage
