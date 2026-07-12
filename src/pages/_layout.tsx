import KeyboardDoubleArrowLeftRoundedIcon from '@mui/icons-material/KeyboardDoubleArrowLeftRounded'
import KeyboardDoubleArrowRightRoundedIcon from '@mui/icons-material/KeyboardDoubleArrowRightRounded'
import { Box, IconButton, List, Paper, ThemeProvider } from '@mui/material'
import dayjs from 'dayjs'
import relativeTime from 'dayjs/plugin/relativeTime'
import { useCallback, useEffect, useMemo, useRef } from 'react'
import { useTranslation } from 'react-i18next'
import { Outlet, useNavigate } from 'react-router'

import brandIcon from '@/assets/image/brand-icon.png'
import { BaseErrorBoundary } from '@/components/base'
import { AnnouncementPrompt } from '@/components/layout/announcement-prompt'
import { LayoutItem } from '@/components/layout/layout-item'
import { LayoutTraffic } from '@/components/layout/layout-traffic'
import { NoticeManager } from '@/components/layout/notice-manager'
import { UpdateButton } from '@/components/layout/update-button'
import { UpdatePrompt } from '@/components/layout/update-prompt'
import { WindowControls } from '@/components/layout/window-controller'
import { useI18n } from '@/hooks/use-i18n'
import { useVerge } from '@/hooks/use-verge'
import { useWindowDecorations } from '@/hooks/use-window'
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

const Layout = () => {
  const mode = useThemeMode()
  const { t } = useTranslation()
  const { theme } = useCustomTheme()
  const { verge, patchVerge } = useVerge()
  const { language } = verge ?? {}
  const navCollapsed = verge?.collapse_navbar ?? false
  const navToggleLabel = navCollapsed
    ? t('layout.components.navigation.menu.expandNavBar')
    : t('layout.components.navigation.menu.collapseNavBar')
  const { switchLanguage } = useI18n()
  const navigate = useNavigate()
  const themeReady = useMemo(() => Boolean(theme), [theme])

  const windowControlsRef = useRef<any>(null)
  const { decorated } = useWindowDecorations()

  const handleToggleNavCollapsed = useCallback(() => {
    void patchVerge({ collapse_navbar: !navCollapsed })
  }, [navCollapsed, patchVerge])

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
        console.error('[通知处理] 失败:', error)
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
      {/* 左侧底部窗口控制按钮 */}
      <NoticeManager position={verge?.notice_position} />
      <UpdatePrompt />
      <AnnouncementPrompt />
      <Paper
        square
        elevation={0}
        className={`${OS} layout${navCollapsed ? ' layout--nav-collapsed' : ''}`}
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
          <div className="layout-content__left">
            <div className="the-logo" data-tauri-drag-region="false">
              <div
                data-tauri-drag-region="true"
                style={{
                  height: '27px',
                  display: 'flex',
                  justifyContent: 'space-between',
                }}
              >
                <Box
                  component="img"
                  src={brandIcon}
                  alt="XXLink"
                  sx={{
                    width: 38,
                    height: 38,
                    mt: '-5px',
                    mr: 1,
                    ml: '-4px',
                    objectFit: 'contain',
                  }}
                />
                <Box
                  component="span"
                  sx={{
                    color: 'text.primary',
                    fontSize: 28,
                    fontWeight: 800,
                    lineHeight: '28px',
                    letterSpacing: '-0.03em',
                  }}
                >
                  XXLink
                </Box>
              </div>
              <UpdateButton className="the-newbtn" />
              <IconButton
                size="small"
                data-tauri-drag-region="false"
                title={navToggleLabel}
                aria-label={navToggleLabel}
                onClick={handleToggleNavCollapsed}
                sx={{ alignSelf: 'center', ml: 'auto' }}
              >
                {navCollapsed ? (
                  <KeyboardDoubleArrowRightRoundedIcon />
                ) : (
                  <KeyboardDoubleArrowLeftRoundedIcon />
                )}
              </IconButton>
            </div>

            <List className="the-menu">
              {navItems.map((item) => (
                <LayoutItem key={item.path} to={item.path} icon={item.icon}>
                  {t(item.label)}
                </LayoutItem>
              ))}
            </List>

            <div className="the-traffic">
              <LayoutTraffic />
            </div>
          </div>

          <div className="layout-content__right">
            <div className="the-bar"></div>
            <div className="the-content">
              <BaseErrorBoundary>
                <Outlet />
              </BaseErrorBoundary>
            </div>
          </div>
        </div>
      </Paper>
    </ThemeProvider>
  )
}

export default Layout
