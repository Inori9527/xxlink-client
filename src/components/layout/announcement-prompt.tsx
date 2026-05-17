import CampaignRoundedIcon from '@mui/icons-material/CampaignRounded'
import OpenInNewRoundedIcon from '@mui/icons-material/OpenInNewRounded'
import {
  Alert,
  Box,
  Button,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  Stack,
  Typography,
  alpha,
  useTheme,
} from '@mui/material'
import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'

import { api, type Announcement } from '@/services/api'
import {
  getDismissedAnnouncementId,
  migrateLegacyBroadcastHistory,
  normalizeAnnouncementLevel,
  openAnnouncementAction,
  rememberAnnouncementHistory,
  setDismissedAnnouncementId,
} from '@/utils/announcements'

export const AnnouncementPrompt = () => {
  const { t } = useTranslation()
  const theme = useTheme()
  const [announcement, setAnnouncement] = useState<Announcement | null>(null)
  const [openDialog, setOpenDialog] = useState(false)

  useEffect(() => {
    let cancelled = false
    migrateLegacyBroadcastHistory()

    api.announcements
      .latestBroadcast()
      .then((latest) => {
        if (cancelled || !latest?.id) return
        rememberAnnouncementHistory('BROADCAST', [latest])
        if (getDismissedAnnouncementId('BROADCAST') === latest.id) {
          return
        }
        setAnnouncement(latest)
        setOpenDialog(true)
      })
      .catch(() => {
        // Announcements are nice-to-have and should never block startup.
      })

    return () => {
      cancelled = true
    }
  }, [])

  const handleDismissForever = () => {
    if (announcement?.id) {
      setDismissedAnnouncementId('BROADCAST', announcement.id)
    }
    setOpenDialog(false)
  }

  const handleOpenAction = () => {
    if (!announcement?.actionUrl) return
    void openAnnouncementAction(announcement.actionUrl)
  }

  if (!announcement) return null

  return (
    <Dialog
      open={openDialog}
      onClose={handleDismissForever}
      maxWidth="sm"
      fullWidth
    >
      <DialogTitle>
        <Stack direction="row" spacing={1.2} alignItems="center">
          <Box
            sx={{
              width: 38,
              height: 38,
              borderRadius: 2,
              display: 'grid',
              placeItems: 'center',
              color: theme.palette.primary.main,
              bgcolor: alpha(theme.palette.primary.main, 0.12),
            }}
          >
            <CampaignRoundedIcon />
          </Box>
          <Box>
            <Typography variant="h6" fontWeight={900}>
              {announcement.title}
            </Typography>
            <Typography variant="caption" color="text.secondary">
              {t('layout.components.announcement.label')}
            </Typography>
          </Box>
        </Stack>
      </DialogTitle>

      <DialogContent>
        <Alert
          severity={normalizeAnnouncementLevel(announcement.level)}
          sx={{ mb: 2, borderRadius: 2 }}
        >
          {announcement.body}
        </Alert>
        <Typography variant="body2" color="text.secondary">
          {t('layout.components.announcement.dismissHint')}
        </Typography>
      </DialogContent>

      <DialogActions sx={{ px: 3, pb: 2.5 }}>
        {announcement.actionUrl && (
          <Button
            variant="outlined"
            startIcon={<OpenInNewRoundedIcon />}
            onClick={handleOpenAction}
          >
            {announcement.actionLabel ||
              t('layout.components.announcement.viewDetails')}
          </Button>
        )}
        <Button variant="contained" onClick={handleDismissForever}>
          {t('layout.components.announcement.dismiss')}
        </Button>
      </DialogActions>
    </Dialog>
  )
}
