import CardGiftcardRoundedIcon from '@mui/icons-material/CardGiftcardRounded'
import RedeemRoundedIcon from '@mui/icons-material/RedeemRounded'
import {
  Alert,
  Box,
  Button,
  Chip,
  Paper,
  Stack,
  TextField,
  Typography,
  alpha,
  useTheme,
} from '@mui/material'
import { useState } from 'react'
import { useTranslation } from 'react-i18next'

import { useAppData } from '@/providers/app-data-context'
import { api, type PromoRedeemResult } from '@/services/api'
import {
  classifyClientError,
  reportSafeClientFailure,
  toSafeClientErrorMessage,
} from '@/services/safe-client-error'
import { syncSubscription } from '@/services/subscription-sync'

function formatRedeemResult(
  result: PromoRedeemResult,
  t: (key: string, options?: Record<string, unknown>) => string,
): string {
  if (result.message) return result.message
  const traffic = Number(result.trafficGb ?? 0)
  const benefitLabel =
    Number.isFinite(traffic) && traffic > 0
      ? `${traffic.toLocaleString()} GB`
      : result.planName
        ? result.planName
        : t('mine.promo.result.traffic')
  return t('mine.promo.result.success', {
    traffic: benefitLabel,
    days: result.validDays ?? '-',
  })
}

export const PromoRedeemPanel = () => {
  const { t } = useTranslation()
  const theme = useTheme()
  const { refreshProxy } = useAppData()
  const [code, setCode] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [syncing, setSyncing] = useState(false)
  const [result, setResult] = useState<PromoRedeemResult | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [syncWarning, setSyncWarning] = useState(false)

  const handleSync = async () => {
    setSyncing(true)
    setSyncWarning(false)
    try {
      await syncSubscription({ force: true })
      await refreshProxy()
    } catch (syncError) {
      reportSafeClientFailure('promo-sync', syncError)
      setSyncWarning(true)
    } finally {
      setSyncing(false)
    }
  }

  const handleRedeem = async () => {
    const normalizedCode = code.trim()
    if (!normalizedCode) {
      setError(t('mine.promo.errors.empty'))
      return
    }

    setSubmitting(true)
    setError(null)
    setResult(null)

    try {
      const redeemResult = await api.promo.redeemCode(normalizedCode)
      setResult(redeemResult)
      setCode('')
      await handleSync()
    } catch (redeemError) {
      reportSafeClientFailure('promo-redeem', redeemError)
      setError(
        toSafeClientErrorMessage(classifyClientError(redeemError).kind, t),
      )
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <Paper
      elevation={0}
      sx={{
        p: { xs: 2, md: 2.5 },
        borderRadius: 3,
        border: `1px solid ${alpha(theme.palette.primary.main, 0.22)}`,
        bgcolor:
          theme.palette.mode === 'dark'
            ? alpha(theme.palette.primary.main, 0.08)
            : alpha(theme.palette.primary.main, 0.04),
      }}
    >
      <Stack spacing={2}>
        <Stack direction="row" spacing={1.5} alignItems="center">
          <Box
            sx={{
              width: 44,
              height: 44,
              borderRadius: 2,
              display: 'grid',
              placeItems: 'center',
              color: theme.palette.primary.main,
              bgcolor: alpha(theme.palette.primary.main, 0.13),
            }}
          >
            <CardGiftcardRoundedIcon />
          </Box>
          <Box>
            <Typography variant="h6" fontWeight={900}>
              {t('mine.promo.heading')}
            </Typography>
            <Typography variant="body2" color="text.secondary">
              {t('mine.promo.subtitle')}
            </Typography>
          </Box>
        </Stack>

        <Stack direction={{ xs: 'column', sm: 'row' }} spacing={1.2}>
          <TextField
            fullWidth
            value={code}
            onChange={(event) => setCode(event.target.value)}
            placeholder={t('mine.promo.placeholder')}
            disabled={submitting || syncing}
            onKeyDown={(event) => {
              if (event.key === 'Enter') {
                event.preventDefault()
                void handleRedeem()
              }
            }}
          />
          <Button
            variant="contained"
            startIcon={<RedeemRoundedIcon />}
            onClick={handleRedeem}
            disabled={submitting || syncing}
            sx={{ minWidth: 132, borderRadius: 1.5, fontWeight: 800 }}
          >
            {submitting ? t('mine.promo.redeeming') : t('mine.promo.redeem')}
          </Button>
        </Stack>

        <Stack direction="row" spacing={1} flexWrap="wrap" useFlexGap>
          <Chip label={t('mine.promo.chips.autoSync')} variant="outlined" />
          <Chip label={t('mine.promo.chips.trafficCode')} variant="outlined" />
        </Stack>

        {result && (
          <Alert severity="success" onClose={() => setResult(null)}>
            {formatRedeemResult(result, t)}
          </Alert>
        )}

        {syncWarning && (
          <Alert
            severity="warning"
            onClose={() => setSyncWarning(false)}
            action={
              <Button
                color="inherit"
                size="small"
                onClick={handleSync}
                disabled={syncing}
              >
                {syncing ? t('mine.promo.syncing') : t('mine.promo.retrySync')}
              </Button>
            }
          >
            {t('mine.promo.syncWarning')}
          </Alert>
        )}

        {error && (
          <Alert severity="error" onClose={() => setError(null)}>
            {error}
          </Alert>
        )}
      </Stack>
    </Paper>
  )
}
