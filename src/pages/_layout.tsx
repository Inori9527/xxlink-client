import { Alert, Button, Paper, ThemeProvider } from '@mui/material'
import dayjs from 'dayjs'
import relativeTime from 'dayjs/plugin/relativeTime'
import { useCallback, useEffect, useMemo, useRef } from 'react'
import { useTranslation } from 'react-i18next'
import { Outlet, useNavigate } from 'react-router'

import { BaseErrorBoundary } from '@/components/base'
import { LayoutItem } from '@/components/layout/layout-item'
import { NoticeManager } from '@/components/layout/notice-manager'
import { UpdatePrompt } from '@/components/layout/update-prompt'
import { WindowControls } from '@/components/layout/window-controller'
import { useI18n } from '@/hooks/use-i18n'
import { useVerge } from '@/hooks/use-verge'
import { useWindowDecorations } from '@/hooks/use-window'
import { useAuth } from '@/services/auth-store'
import { reportSafeClientFailure } from '@/services/safe-client-error'
import { initializeSecureSession } from '@/services/secure-session-controller'
import { useThemeMode } from '@/services/states'
import getSystem from '@/utils/get-system'

import {
  useAppInitialization,
  useCustomTheme,
  useLayoutEvents,
  useLoadingOverlay,
} from './_layout/hooks'
import { handleNoticeMessage } from './_layout/utils'
import { navItems } from './_routers'

import 'dayjs/locale/ru'
import 'dayjs/locale/zh-cn'

dayjs.extend(relativeTime)

const OS = getSystem()
// Resolved lazily: _routers imports Layout back, so navItems is in the
// import cycle's temporal dead zone at module-evaluation time.
const getTabBarItems = () => navItems.filter((item) => item.showInTabBar)

const Layout = () => {
  const mode = useThemeMode()
  const { t } = useTranslation()
  const { theme } = useCustomTheme()
  const { sessionStatus } = useAuth()
  const { verge } = useVerge()
  const { language } = verge ?? {}
  const { switchLanguage } = useI18n()
  const navigate = useNavigate()
  const themeReady = useMemo(() => Boolean(theme), [theme])

  const windowControlsRef = useRef<any>(null)
  const { decorated } = useWindowDecorations()

  const customTitlebar = useMemo(
    () =>
      !decorated ? (
        <div className="the_titlebar" data-tauri-drag-region="true">
          <WindowControls ref={windowControlsRef} />
        </div>
      ) : null,
    [decorated],
  )

  useLoadingOverlay(themeReady)
  useAppInitialization()

  const handleNotice = useCallback(
    (payload: [string, string]) => {
      const [status, msg] = payload
      try {
        handleNoticeMessage(status, msg, t, navigate)
      } catch (error) {
        reportSafeClientFailure('layout-notice-handler', error)
      }
    },
    [t, navigate],
  )

  useLayoutEvents(handleNotice)

  useEffect(() => {
    if (language) {
      dayjs.locale(language === 'zh' ? 'zh-cn' : language)
      switchLanguage(language)
    }
  }, [language, switchLanguage])

  if (!themeReady) {
    return (
      <div
        style={{
          width: '100vw',
          height: '100vh',
          background: mode === 'light' ? '#fff' : '#181a1b',
          transition: 'background 0.2s',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          color: mode === 'light' ? '#333' : '#fff',
        }}
      ></div>
    )
  }

  return (
    <ThemeProvider theme={theme}>
      <NoticeManager position={verge?.notice_position} />
      <UpdatePrompt />
      <Paper
        square
        elevation={0}
        className={`${OS} layout`}
        style={{
          borderTopLeftRadius: '0px',
          borderTopRightRadius: '0px',
        }}
        onContextMenu={(e) => {
          if (
            OS === 'windows' &&
            !['input', 'textarea'].includes(
              e.currentTarget.tagName.toLowerCase(),
            ) &&
            !e.currentTarget.isContentEditable
          ) {
            e.preventDefault()
          }
        }}
        sx={[
          ({ palette }) => ({ bgcolor: palette.background.paper }),
          OS === 'linux'
            ? {
                borderRadius: '8px',
                width: '100vw',
                height: '100vh',
              }
            : {},
        ]}
      >
        {/* Custom titlebar - rendered only when decorated is false, memoized for performance */}
        {customTitlebar}

        <div className="layout-content">
          <main className="layout-content__right">
            <div className="the-content">
              {sessionStatus === 'recovery_required' && (
                <Alert
                  severity="warning"
                  action={
                    <Button
                      color="inherit"
                      size="small"
                      onClick={() => void initializeSecureSession()}
                    >
                      {t('layout.secureSession.retry')}
                    </Button>
                  }
                  sx={{ mx: 2, mt: 2 }}
                >
                  {t('layout.secureSession.recoveryRequired')}
                </Alert>
              )}
              {sessionStatus === 'service_blocked' && (
                <Alert severity="error" sx={{ mx: 2, mt: 2 }}>
                  {t('layout.secureSession.serviceBlocked')}
                </Alert>
              )}
              <BaseErrorBoundary>
                <Outlet />
              </BaseErrorBoundary>
            </div>
          </main>
        </div>

        <nav
          className="bottom-tab-bar"
          aria-label={t('layout.components.navigation.primaryAriaLabel')}
        >
          {getTabBarItems().map((item) => (
            <LayoutItem key={item.path} to={item.path} icon={item.icon}>
              {t(item.label)}
            </LayoutItem>
          ))}
        </nav>
      </Paper>
    </ThemeProvider>
  )
}

export default Layout
