import { GitHub, HelpOutlineRounded, Telegram } from '@mui/icons-material'
import {
  Box,
  Button,
  ButtonGroup,
  IconButton,
  Grid,
  Typography,
} from '@mui/material'
import { useLockFn } from 'ahooks'
import { useTranslation } from 'react-i18next'
import { useNavigate } from 'react-router'

import { BasePage } from '@/components/base'
import SettingClash from '@/components/setting/setting-clash'
import SettingSystem from '@/components/setting/setting-system'
import SettingVergeAdvanced from '@/components/setting/setting-verge-advanced'
import SettingVergeBasic from '@/components/setting/setting-verge-basic'
import { apiLogout } from '@/services/auth'
import { useAuth } from '@/services/auth-store'
import { openWebUrl } from '@/services/cmds'
import { showNotice } from '@/services/notice-service'
import { useThemeMode } from '@/services/states'

const SettingPage = () => {
  const { t } = useTranslation()
  const navigate = useNavigate()
  const { user, refreshToken, clearAuth } = useAuth()

  const onError = (err: unknown) => {
    showNotice.error(err)
  }

  const toGithubRepo = useLockFn(() => {
    return openWebUrl('https://github.com/xxlink')
  })

  const toGithubDoc = useLockFn(() => {
    return openWebUrl('https://xxlink.dev/docs')
  })

  const toTelegramChannel = useLockFn(() => {
    return openWebUrl('https://t.me/xxlink_official')
  })

  const handleLogout = useLockFn(async () => {
    try {
      if (refreshToken) {
        await apiLogout(refreshToken)
      }
    } catch {
      // Ignore API errors on logout — clear local state regardless
    } finally {
      clearAuth()
      navigate('/login')
    }
  })

  const mode = useThemeMode()
  const isDark = mode === 'light' ? false : true

  return (
    <BasePage
      title={t('settings.page.title')}
      header={
        <ButtonGroup variant="contained" aria-label="Basic button group">
          <IconButton
            size="medium"
            color="inherit"
            title={t('settings.page.actions.manual')}
            onClick={toGithubDoc}
          >
            <HelpOutlineRounded fontSize="inherit" />
          </IconButton>
          <IconButton
            size="medium"
            color="inherit"
            title={t('settings.page.actions.telegram')}
            onClick={toTelegramChannel}
          >
            <Telegram fontSize="inherit" />
          </IconButton>

          <IconButton
            size="medium"
            color="inherit"
            title={t('settings.page.actions.github')}
            onClick={toGithubRepo}
          >
            <GitHub fontSize="inherit" />
          </IconButton>
        </ButtonGroup>
      }
    >
      <Grid container spacing={1.5} columns={{ xs: 6, sm: 6, md: 12 }}>
        <Grid size={6}>
          <Box
            sx={{
              borderRadius: 2,
              marginBottom: 1.5,
              backgroundColor: isDark ? '#282a36' : '#ffffff',
            }}
          >
            <SettingSystem onError={onError} />
          </Box>
          <Box
            sx={{
              borderRadius: 2,
              backgroundColor: isDark ? '#282a36' : '#ffffff',
            }}
          >
            <SettingClash onError={onError} />
          </Box>
        </Grid>
        <Grid size={6}>
          <Box
            sx={{
              borderRadius: 2,
              marginBottom: 1.5,
              backgroundColor: isDark ? '#282a36' : '#ffffff',
            }}
          >
            <SettingVergeBasic onError={onError} />
          </Box>
          <Box
            sx={{
              borderRadius: 2,
              backgroundColor: isDark ? '#282a36' : '#ffffff',
            }}
          >
            <SettingVergeAdvanced onError={onError} />
          </Box>
        </Grid>
      </Grid>

      {/* Logout section */}
      <Box
        sx={{
          mt: 2,
          px: 1,
          py: 1.5,
          borderRadius: 2,
          backgroundColor: isDark ? '#282a36' : '#ffffff',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
        }}
      >
        <Typography variant="body2" color="text.secondary" sx={{ ml: 1 }}>
          {user?.email ?? ''}
        </Typography>
        <Button
          variant="outlined"
          color="error"
          size="small"
          onClick={handleLogout}
          sx={{ mr: 1 }}
        >
          退出登录
        </Button>
      </Box>
    </BasePage>
  )
}

export default SettingPage
