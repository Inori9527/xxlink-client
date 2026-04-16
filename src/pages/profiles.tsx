import { BuildRounded, RefreshRounded } from '@mui/icons-material'
import { LoadingButton } from '@mui/lab'
import {
  Box,
  Button,
  Card,
  CardContent,
  Chip,
  LinearProgress,
  Stack,
  Typography,
} from '@mui/material'
import dayjs from 'dayjs'
import { useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useNavigate } from 'react-router'

import { BasePage } from '@/components/base'
import { useProfiles } from '@/hooks/use-profiles'
import { showNotice } from '@/services/notice-service'
import { syncSubscription } from '@/services/subscription-sync'
import parseTraffic from '@/utils/parse-traffic'

const ProfilePage = () => {
  const { t } = useTranslation()
  const navigate = useNavigate()
  const [syncing, setSyncing] = useState(false)
  const [rebuilding, setRebuilding] = useState(false)
  const { profiles = {}, mutateProfiles } = useProfiles()

  const currentItem = useMemo(() => {
    const items = profiles.items ?? []
    const current = profiles.current
    return items.find((i) => i.uid === current) ?? null
  }, [profiles])

  const onSync = async () => {
    if (syncing || rebuilding) return
    setSyncing(true)
    try {
      await syncSubscription()
      await mutateProfiles()
      showNotice.success('shared.feedback.notifications.importSuccess')
    } catch (err) {
      showNotice.error(
        'shared.feedback.notifications.common.refreshFailed',
        err as Error | string,
        4000,
      )
    } finally {
      setSyncing(false)
    }
  }

  const onForceRebuild = async () => {
    if (syncing || rebuilding) return
    if (!window.confirm(t('profiles.page.forceRebuild.confirm'))) return
    setRebuilding(true)
    try {
      await syncSubscription({ force: true })
      await mutateProfiles()
      showNotice.success('profiles.page.forceRebuild.success')
    } catch (err) {
      showNotice.error(
        'profiles.page.forceRebuild.failed',
        err as Error | string,
        4000,
      )
    } finally {
      setRebuilding(false)
    }
  }

  const extra = currentItem?.extra
  const upload = extra?.upload ?? 0
  const download = extra?.download ?? 0
  const total = extra?.total ?? 0
  const used = upload + download
  const progress =
    total > 0 ? Math.min(Math.round((used * 100) / total), 100) : 0
  const expireTimestamp =
    extra?.expire && extra.expire > 0 ? extra.expire * 1000 : null
  const expireDate = expireTimestamp
    ? dayjs(expireTimestamp).format('YYYY-MM-DD')
    : null
  const expiringSoon = expireTimestamp
    ? dayjs(expireTimestamp).diff(dayjs(), 'day') <= 7 &&
      dayjs(expireTimestamp).diff(dayjs(), 'day') >= 0
    : false
  const updated = currentItem?.updated ?? 0

  return (
    <BasePage
      full
      title={t('profiles.page.title')}
      contentStyle={{ height: '100%' }}
    >
      <Box sx={{ p: 2, maxWidth: 640, mx: 'auto' }}>
        {!currentItem ? (
          <Card variant="outlined">
            <CardContent>
              <Stack spacing={2}>
                <Box>
                  <Typography variant="h6">
                    {t('profiles.page.empty.title')}
                  </Typography>
                  <Typography variant="body2" color="text.secondary">
                    {t('profiles.page.empty.body')}
                  </Typography>
                </Box>
                <Box
                  sx={{ display: 'flex', gap: 1, justifyContent: 'flex-end' }}
                >
                  <LoadingButton
                    variant="outlined"
                    size="small"
                    loading={syncing}
                    startIcon={<RefreshRounded />}
                    onClick={onSync}
                  >
                    {t('profiles.page.empty.refresh')}
                  </LoadingButton>
                  <Button
                    variant="contained"
                    size="small"
                    onClick={() => navigate('/plans')}
                  >
                    {t('profiles.page.empty.goToPlans')}
                  </Button>
                </Box>
              </Stack>
            </CardContent>
          </Card>
        ) : (
          <Card variant="outlined">
            <CardContent>
              <Stack spacing={2}>
                <Box>
                  <Typography variant="overline" color="text.secondary">
                    {t('profiles.page.title')}
                  </Typography>
                  <Typography variant="h6" sx={{ mt: 0.5 }}>
                    {currentItem.name || '-'}
                  </Typography>
                  {currentItem.desc && (
                    <Typography variant="body2" color="text.secondary">
                      {currentItem.desc}
                    </Typography>
                  )}
                </Box>

                {extra && total > 0 && (
                  <Box>
                    <Stack
                      direction="row"
                      justifyContent="space-between"
                      sx={{ mb: 0.5 }}
                    >
                      <Typography variant="body2" color="text.secondary">
                        {t('shared.labels.usedTotal')}
                      </Typography>
                      <Typography variant="body2">
                        {parseTraffic(used)} / {parseTraffic(total)}
                      </Typography>
                    </Stack>
                    <LinearProgress variant="determinate" value={progress} />
                  </Box>
                )}

                {expireDate && (
                  <Stack
                    direction="row"
                    justifyContent="space-between"
                    alignItems="center"
                  >
                    <Typography variant="body2" color="text.secondary">
                      {t('shared.labels.expireTime')}
                    </Typography>
                    <Stack direction="row" spacing={1} alignItems="center">
                      <Typography variant="body2">{expireDate}</Typography>
                      {expiringSoon && (
                        <Chip
                          size="small"
                          color="warning"
                          label={t('profiles.page.expiringSoon')}
                        />
                      )}
                    </Stack>
                  </Stack>
                )}

                {updated > 0 && (
                  <Stack direction="row" justifyContent="space-between">
                    <Typography variant="body2" color="text.secondary">
                      {t('shared.labels.updateTime')}
                    </Typography>
                    <Typography variant="body2">
                      {dayjs(updated * 1000).format('YYYY-MM-DD HH:mm')}
                    </Typography>
                  </Stack>
                )}

                <Box
                  sx={{
                    display: 'flex',
                    gap: 1,
                    justifyContent: 'flex-end',
                    flexWrap: 'wrap',
                  }}
                >
                  <LoadingButton
                    variant="outlined"
                    size="small"
                    color="warning"
                    loading={rebuilding}
                    disabled={syncing}
                    startIcon={<BuildRounded />}
                    onClick={onForceRebuild}
                  >
                    {t('profiles.page.forceRebuild.button')}
                  </LoadingButton>
                  <LoadingButton
                    variant="contained"
                    size="small"
                    loading={syncing}
                    disabled={rebuilding}
                    startIcon={<RefreshRounded />}
                    onClick={onSync}
                  >
                    {t('profiles.page.actions.updateAll')}
                  </LoadingButton>
                </Box>
              </Stack>
            </CardContent>
          </Card>
        )}
      </Box>
    </BasePage>
  )
}

export default ProfilePage
