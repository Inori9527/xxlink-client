import { RefreshRounded } from '@mui/icons-material'
import { LoadingButton } from '@mui/lab'
import {
  Box,
  Card,
  CardContent,
  LinearProgress,
  Stack,
  Typography,
} from '@mui/material'
import dayjs from 'dayjs'
import { useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'

import { BasePage } from '@/components/base'
import { useProfiles } from '@/hooks/use-profiles'
import { showNotice } from '@/services/notice-service'
import { syncSubscription } from '@/services/subscription-sync'
import parseTraffic from '@/utils/parse-traffic'

const ProfilePage = () => {
  const { t } = useTranslation()
  const [syncing, setSyncing] = useState(false)
  const { profiles = {}, mutateProfiles } = useProfiles()

  const currentItem = useMemo(() => {
    const items = profiles.items ?? []
    const current = profiles.current
    return items.find((i) => i.uid === current) ?? null
  }, [profiles])

  const onSync = async () => {
    if (syncing) return
    setSyncing(true)
    try {
      await syncSubscription()
      await mutateProfiles()
      showNotice.success('shared.feedback.notifications.importSuccess')
    } catch (err) {
      showNotice.error(err as Error | string, 4000)
    } finally {
      setSyncing(false)
    }
  }

  const extra = currentItem?.extra
  const upload = extra?.upload ?? 0
  const download = extra?.download ?? 0
  const total = extra?.total ?? 0
  const used = upload + download
  const progress =
    total > 0 ? Math.min(Math.round((used * 100) / total), 100) : 0
  const expireDate =
    extra?.expire && extra.expire > 0
      ? dayjs(extra.expire * 1000).format('YYYY-MM-DD')
      : null
  const updated = currentItem?.updated ?? 0

  return (
    <BasePage
      full
      title={t('profiles.page.title')}
      contentStyle={{ height: '100%' }}
    >
      <Box sx={{ p: 2, maxWidth: 640, mx: 'auto' }}>
        <Card variant="outlined">
          <CardContent>
            <Stack spacing={2}>
              <Box>
                <Typography variant="overline" color="text.secondary">
                  {t('profiles.page.title')}
                </Typography>
                <Typography variant="h6" sx={{ mt: 0.5 }}>
                  {currentItem?.name || '-'}
                </Typography>
                {currentItem?.desc && (
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
                <Stack direction="row" justifyContent="space-between">
                  <Typography variant="body2" color="text.secondary">
                    {t('shared.labels.expireTime')}
                  </Typography>
                  <Typography variant="body2">{expireDate}</Typography>
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

              <Box sx={{ display: 'flex', justifyContent: 'flex-end' }}>
                <LoadingButton
                  variant="contained"
                  size="small"
                  loading={syncing}
                  startIcon={<RefreshRounded />}
                  onClick={onSync}
                >
                  {t('profiles.page.actions.updateAll')}
                </LoadingButton>
              </Box>
            </Stack>
          </CardContent>
        </Card>
      </Box>
    </BasePage>
  )
}

export default ProfilePage
