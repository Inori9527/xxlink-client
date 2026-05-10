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
import { open } from '@tauri-apps/plugin-shell'
import { useCallback, useEffect, useState } from 'react'

import { BasePage } from '@/components/base'
import { api, type Announcement } from '@/services/api'

const DISMISSED_ANNOUNCEMENT_KEY = 'xxlink:dismissed-announcement-id'
const ANNOUNCEMENT_HISTORY_KEY = 'xxlink:announcement-history'

const readAnnouncementHistory = (): Announcement[] => {
  try {
    const raw = localStorage.getItem(ANNOUNCEMENT_HISTORY_KEY)
    if (!raw) return []
    const list = JSON.parse(raw) as Announcement[]
    return Array.isArray(list) ? list.filter((item) => item?.id) : []
  } catch {
    return []
  }
}

const rememberAnnouncement = (announcement: Announcement) => {
  if (!announcement.id) return readAnnouncementHistory()
  const next = [
    announcement,
    ...readAnnouncementHistory().filter((item) => item.id !== announcement.id),
  ].slice(0, 20)
  try {
    localStorage.setItem(ANNOUNCEMENT_HISTORY_KEY, JSON.stringify(next))
  } catch {
    /* ignore */
  }
  return next
}

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
    readAnnouncementHistory(),
  )
  const [dismissedId, setDismissedId] = useState<string | null>(() => {
    try {
      return localStorage.getItem(DISMISSED_ANNOUNCEMENT_KEY)
    } catch {
      return null
    }
  })
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const loadLatest = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const latest = await api.announcements.latest()
      setAnnouncement(latest)
      if (latest) {
        setHistory(rememberAnnouncement(latest))
      } else {
        setHistory(readAnnouncementHistory())
      }
    } catch (err) {
      console.error('[AnnouncementCenter] failed to load latest', err)
      setError('公告加载失败，请稍后重试。')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void loadLatest()
  }, [loadLatest])

  const handleDismiss = () => {
    if (!announcement?.id) return
    try {
      localStorage.setItem(DISMISSED_ANNOUNCEMENT_KEY, announcement.id)
    } catch {
      /* ignore */
    }
    setDismissedId(announcement.id)
  }

  const isDismissed = Boolean(
    announcement?.id && dismissedId === announcement.id,
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
          onClick={loadLatest}
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
                最新公告会在启动时弹出；关闭后直到下一条公告才会再次提醒。
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
                    color={announcement.level ?? 'info'}
                    label={announcement.level ?? 'info'}
                  />
                  {isDismissed && (
                    <Chip
                      size="small"
                      color="success"
                      icon={<CheckRounded />}
                      label="已关闭提醒"
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
                    onClick={() => void open(announcement.actionUrl!)}
                    sx={{ borderRadius: 999, fontWeight: 900 }}
                  >
                    {announcement.actionLabel ?? '打开链接'}
                  </Button>
                )}
                <Button
                  variant={isDismissed ? 'outlined' : 'contained'}
                  color={isDismissed ? 'success' : 'primary'}
                  onClick={handleDismiss}
                  disabled={isDismissed}
                  sx={{ borderRadius: 999, fontWeight: 900 }}
                >
                  {isDismissed ? '已关闭此公告提醒' : '不再弹出此公告'}
                </Button>
              </Stack>
            </Stack>
          </Paper>
        ) : (
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
              有新公告时会自动显示在这里。
            </Typography>
          </Paper>
        )}

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
                本机公告历史
              </Typography>
              <Typography variant="body2" color="text.secondary">
                记录本机已收到的最近公告，便于稍后回看。
              </Typography>
            </Box>
            {history.map((item) => (
              <Box
                key={item.id}
                sx={{
                  px: 2.5,
                  py: 1.6,
                  borderTop: `1px solid ${alpha(theme.palette.divider, 0.55)}`,
                }}
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
                    color={item.level ?? 'info'}
                    label={item.level ?? 'info'}
                  />
                </Stack>
              </Box>
            ))}
          </Paper>
        )}
      </Stack>
    </BasePage>
  )
}

export default AnnouncementCenterPage
