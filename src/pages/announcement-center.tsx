import {
  CampaignRounded,
  CheckRounded,
  OpenInNewRounded,
  RefreshRounded,
} from '@mui/icons-material'
import {
  Alert,
  Box,
  Button,
  Chip,
  CircularProgress,
  Paper,
  Stack,
  Typography,
  alpha,
  useTheme,
} from '@mui/material'
import { useCallback, useEffect, useState } from 'react'

import { BasePage } from '@/components/base'
import { api, type Announcement } from '@/services/api'
import {
  markAnnouncementRead,
  normalizeAnnouncementLevel,
  openAnnouncementAction,
  readAnnouncementHistory,
  readAnnouncementIds,
  rememberAnnouncementHistory,
} from '@/utils/announcements'

const formatDate = (date?: string | null) => {
  if (!date) return '最新公告'
  const parsed = new Date(date)
  if (Number.isNaN(parsed.getTime())) return '最新公告'
  return parsed.toLocaleDateString()
}

const AnnouncementCenterPage = () => {
  const theme = useTheme()
  const [announcement, setAnnouncement] = useState<Announcement | null>(null)
  const [history, setHistory] = useState<Announcement[]>(() =>
    readAnnouncementHistory('UPDATE'),
  )
  const [readIds, setReadIds] = useState<Set<string>>(() =>
    readAnnouncementIds('UPDATE'),
  )
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const loadUpdates = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const updates = await api.announcements.listUpdates(20)
      const latest = updates[0] ?? null
      setAnnouncement(latest)
      setHistory(
        updates.length > 0
          ? rememberAnnouncementHistory('UPDATE', updates)
          : readAnnouncementHistory('UPDATE'),
      )
    } catch (err) {
      console.error('[AnnouncementCenter] failed to load updates', err)
      setError('公告加载失败，请稍后重试。')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void loadUpdates()
  }, [loadUpdates])

  const markCurrentRead = () => {
    if (!announcement?.id) return
    setReadIds(markAnnouncementRead('UPDATE', announcement.id))
  }

  const selectAnnouncement = (item: Announcement) => {
    setAnnouncement(item)
    if (item.id) setReadIds(markAnnouncementRead('UPDATE', item.id))
  }

  const isCurrentRead = Boolean(
    announcement?.id && readIds.has(announcement.id),
  )

  return (
    <BasePage
      title="公告中心"
      header={
        <Button
          size="small"
          variant="outlined"
          startIcon={
            loading ? <CircularProgress size={14} /> : <RefreshRounded />
          }
          onClick={loadUpdates}
          disabled={loading}
          sx={{ borderRadius: 999, fontWeight: 900 }}
        >
          刷新
        </Button>
      }
      contentStyle={{ height: '100%' }}
    >
      <Stack
        spacing={2}
        sx={{
          maxWidth: 860,
          mx: 'auto',
          py: 2,
          height: '100%',
          overflow: 'auto',
        }}
      >
        <Paper
          elevation={0}
          sx={{
            p: 3,
            borderRadius: 4,
            border: `1px solid ${alpha(theme.palette.common.white, 0.08)}`,
            background:
              theme.palette.mode === 'dark'
                ? 'linear-gradient(135deg, rgba(24,27,36,0.98), rgba(14,16,22,0.96))'
                : '#fff',
          }}
        >
          <Stack direction="row" spacing={1.5} alignItems="center">
            <Box
              sx={{
                width: 54,
                height: 54,
                borderRadius: 2.5,
                display: 'grid',
                placeItems: 'center',
                bgcolor: alpha(theme.palette.primary.main, 0.14),
                color: 'primary.light',
              }}
            >
              <CampaignRounded sx={{ fontSize: 30 }} />
            </Box>
            <Box>
              <Typography variant="h4" fontWeight={950}>
                公告中心
              </Typography>
              <Typography color="text.secondary">
                查看版本更新和服务公告。
              </Typography>
            </Box>
          </Stack>
        </Paper>

        {error && <Alert severity="error">{error}</Alert>}

        {announcement?.id ? (
          <Paper
            elevation={0}
            sx={{
              overflow: 'hidden',
              borderRadius: 4,
              border: `1px solid ${alpha(theme.palette.common.white, 0.08)}`,
              bgcolor: theme.palette.mode === 'dark' ? '#181B24' : '#fff',
            }}
          >
            <Box
              sx={{
                p: 2.5,
                bgcolor: alpha(theme.palette.primary.main, 0.16),
                borderBottom: `1px solid ${alpha(theme.palette.divider, 0.6)}`,
              }}
            >
              <Stack
                direction={{ xs: 'column', sm: 'row' }}
                spacing={1}
                justifyContent="space-between"
                alignItems={{ xs: 'flex-start', sm: 'center' }}
              >
                <Box>
                  <Typography variant="overline" color="primary.light">
                    {formatDate(announcement.publishedAt)}
                  </Typography>
                  <Typography variant="h5" fontWeight={950}>
                    {announcement.title}
                  </Typography>
                </Box>
                <Stack direction="row" spacing={1}>
                  <Chip
                    size="small"
                    color={normalizeAnnouncementLevel(announcement.level)}
                    label={normalizeAnnouncementLevel(announcement.level)}
                  />
                  {isCurrentRead && (
                    <Chip
                      size="small"
                      color="success"
                      icon={<CheckRounded />}
                      label="已读"
                    />
                  )}
                </Stack>
              </Stack>
            </Box>
            <Stack spacing={2} sx={{ p: 2.5 }}>
              <Typography
                sx={{
                  whiteSpace: 'pre-wrap',
                  lineHeight: 1.8,
                  color: 'text.primary',
                }}
              >
                {announcement.body}
              </Typography>
              <Stack direction={{ xs: 'column', sm: 'row' }} spacing={1}>
                {announcement.actionUrl && (
                  <Button
                    variant="contained"
                    startIcon={<OpenInNewRounded />}
                    onClick={() =>
                      void openAnnouncementAction(announcement.actionUrl)
                    }
                    sx={{ borderRadius: 999, fontWeight: 900 }}
                  >
                    {announcement.actionLabel ?? '打开链接'}
                  </Button>
                )}
                <Button
                  variant={isCurrentRead ? 'outlined' : 'contained'}
                  color={isCurrentRead ? 'success' : 'primary'}
                  onClick={markCurrentRead}
                  disabled={isCurrentRead}
                  sx={{ borderRadius: 999, fontWeight: 900 }}
                >
                  {isCurrentRead ? '已读' : '标记已读'}
                </Button>
              </Stack>
            </Stack>
          </Paper>
        ) : !error ? (
          <Paper
            elevation={0}
            sx={{
              p: 4,
              borderRadius: 4,
              textAlign: 'center',
              border: `1px dashed ${alpha(theme.palette.divider, 0.8)}`,
            }}
          >
            <Typography variant="h6" fontWeight={900}>
              暂无公告
            </Typography>
            <Typography color="text.secondary" sx={{ mt: 0.5 }}>
              有新公告时会显示在这里。
            </Typography>
          </Paper>
        ) : null}

        {history.length > 0 && (
          <Paper
            elevation={0}
            sx={{
              overflow: 'hidden',
              borderRadius: 4,
              border: `1px solid ${alpha(theme.palette.common.white, 0.08)}`,
              bgcolor: theme.palette.mode === 'dark' ? '#181B24' : '#fff',
            }}
          >
            <Box sx={{ px: 2.5, py: 2 }}>
              <Typography variant="h6" fontWeight={950}>
                更新公告
              </Typography>
              <Typography variant="body2" color="text.secondary">
                最近 20 条版本与服务更新。
              </Typography>
            </Box>
            {history.map((item) => {
              const isRead = readIds.has(item.id)
              return (
                <Box
                  key={item.id}
                  sx={{
                    px: 2.5,
                    py: 1.6,
                    cursor: 'pointer',
                    borderTop: `1px solid ${alpha(theme.palette.divider, 0.55)}`,
                    '&:hover': {
                      bgcolor: alpha(theme.palette.primary.main, 0.08),
                    },
                  }}
                  onClick={() => selectAnnouncement(item)}
                >
                  <Stack
                    direction="row"
                    spacing={1}
                    justifyContent="space-between"
                    alignItems="center"
                  >
                    <Box sx={{ minWidth: 0 }}>
                      <Typography fontWeight={900} noWrap>
                        {item.title}
                      </Typography>
                      <Typography variant="body2" color="text.secondary">
                        {formatDate(item.publishedAt)}
                      </Typography>
                    </Box>
                    <Chip
                      size="small"
                      color={
                        isRead
                          ? 'default'
                          : normalizeAnnouncementLevel(item.level)
                      }
                      label={
                        isRead ? '已读' : normalizeAnnouncementLevel(item.level)
                      }
                    />
                  </Stack>
                </Box>
              )
            })}
          </Paper>
        )}
      </Stack>
    </BasePage>
  )
}

export default AnnouncementCenterPage
