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
  replaceAnnouncementHistory,
} from '@/utils/announcements'

const formatDate = (date?: string | null) => {
  if (!date) return '最新公告'
  const parsed = new Date(date)
  if (Number.isNaN(parsed.getTime())) return '最新公告'
  return parsed.toLocaleDateString()
}

const getLevelLabel = (
  level: ReturnType<typeof normalizeAnnouncementLevel>,
) => {
  switch (level) {
    case 'success':
      return '已完成'
    case 'warning':
      return '重要'
    case 'error':
      return '异常'
    case 'info':
    default:
      return '通知'
  }
}

const AnnouncementCenterPage = () => {
  const theme = useTheme()
  const [selected, setSelected] = useState<Announcement | null>(null)
  const [updates, setUpdates] = useState<Announcement[]>(() =>
    readAnnouncementHistory('UPDATE'),
  )
  const [readIds, setReadIds] = useState<Set<string>>(() =>
    readAnnouncementIds('UPDATE', 'read'),
  )
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const selectAnnouncement = useCallback((item: Announcement) => {
    setSelected(item)
    setReadIds(markAnnouncementRead('UPDATE', item.id))
  }, [])

  const loadUpdates = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const list = await api.announcements.listUpdates(20)
      const next = replaceAnnouncementHistory('UPDATE', list)
      setUpdates(next)
      if (next[0]) selectAnnouncement(next[0])
      else setSelected(null)
    } catch (err) {
      console.error('[AnnouncementCenter] failed to load updates', err)
      setError('公告加载失败，请稍后重试。')
      const cached = readAnnouncementHistory('UPDATE')
      setUpdates(cached)
      if (cached[0]) setSelected(cached[0])
    } finally {
      setLoading(false)
    }
  }, [selectAnnouncement])

  useEffect(() => {
    void loadUpdates()
  }, [loadUpdates])

  const selectedLevel = normalizeAnnouncementLevel(selected?.level)

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
          maxWidth: 940,
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
                查看版本更新和服务通知。
              </Typography>
            </Box>
          </Stack>
        </Paper>

        {error && <Alert severity="warning">{error}</Alert>}

        {selected?.id ? (
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
                    {formatDate(selected.publishedAt)}
                  </Typography>
                  <Typography variant="h5" fontWeight={950}>
                    {selected.title}
                  </Typography>
                </Box>
                <Stack direction="row" spacing={1}>
                  <Chip
                    size="small"
                    color={selectedLevel}
                    label={getLevelLabel(selectedLevel)}
                  />
                  {readIds.has(selected.id) && (
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
                {selected.body}
              </Typography>
              {selected.actionUrl && (
                <Box>
                  <Button
                    variant="contained"
                    startIcon={<OpenInNewRounded />}
                    onClick={() =>
                      void openAnnouncementAction(selected.actionUrl)
                    }
                    sx={{ borderRadius: 999, fontWeight: 900 }}
                  >
                    {selected.actionLabel ?? '打开链接'}
                  </Button>
                </Box>
              )}
            </Stack>
          </Paper>
        ) : !loading && !error ? (
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

        {updates.length > 0 && (
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
                最近公告
              </Typography>
            </Box>
            {updates.map((item) => {
              const level = normalizeAnnouncementLevel(item.level)
              const isSelected = selected?.id === item.id
              const isRead = readIds.has(item.id)

              return (
                <Box
                  key={item.id}
                  onClick={() => selectAnnouncement(item)}
                  sx={{
                    px: 2.5,
                    py: 1.6,
                    cursor: 'pointer',
                    borderTop: `1px solid ${alpha(theme.palette.divider, 0.55)}`,
                    bgcolor: isSelected
                      ? alpha(theme.palette.primary.main, 0.1)
                      : 'transparent',
                    '&:hover': {
                      bgcolor: alpha(theme.palette.primary.main, 0.08),
                    },
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
                    <Stack direction="row" spacing={0.8}>
                      {isRead && (
                        <Chip size="small" color="success" label="已读" />
                      )}
                      <Chip
                        size="small"
                        color={level}
                        label={getLevelLabel(level)}
                      />
                    </Stack>
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
