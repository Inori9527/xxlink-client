import { alpha, createTheme, Theme as MuiTheme, Shadows } from '@mui/material'
import {
  getCurrentWebviewWindow,
  WebviewWindow,
} from '@tauri-apps/api/webviewWindow'
import { Theme as TauriOsTheme } from '@tauri-apps/api/window'
import { useEffect, useMemo } from 'react'

import { useVerge } from '@/hooks/use-verge'
import {
  defaultDarkTheme,
  defaultTheme,
  designTokens,
  modeTokens,
} from '@/pages/_theme'
import { reportSafeClientFailure } from '@/services/safe-client-error'
import { useSetThemeMode, useThemeMode } from '@/services/states'

declare module '@mui/material/Paper' {
  interface PaperPropsVariantOverrides {
    surface: true
    hero: true
  }
}

/** Mode-aware shadow scale: index 0 none, low indices for cards, high for dialogs. */
const buildShadows = (mode: 'light' | 'dark'): Shadows => {
  const ink = mode === 'dark' ? '4, 10, 22' : '23, 42, 77'
  const scale = Array(25).fill('none') as Shadows
  for (let i = 1; i < 25; i += 1) {
    const y = Math.min(2 + i * 1.5, 32)
    const blur = Math.min(8 + i * 3, 72)
    const a =
      mode === 'dark'
        ? Math.min(0.32 + i * 0.012, 0.55)
        : Math.min(0.06 + (i - 1) * 0.004, 0.14)
    scale[i] = `0 ${y}px ${blur}px rgba(${ink}, ${a})`
  }
  return scale
}

const buildTheme = (mode: 'light' | 'dark'): MuiTheme => {
  const dt = mode === 'light' ? defaultTheme : defaultDarkTheme
  const mt = modeTokens(mode)
  const { radius } = designTokens

  return createTheme({
    breakpoints: {
      values: { xs: 0, sm: 650, md: 900, lg: 1200, xl: 1536 },
    },
    palette: {
      mode,
      primary: { main: dt.primary_color },
      secondary: { main: dt.secondary_color },
      info: { main: dt.info_color },
      error: { main: dt.error_color },
      warning: { main: dt.warning_color },
      success: { main: dt.success_color },
      text: {
        primary: dt.primary_text,
        secondary: dt.secondary_text,
      },
      divider: mt.outline,
      background: {
        paper: mt.surface,
        default: dt.background_color,
      },
    },
    shadows: buildShadows(mode),
    shape: { borderRadius: radius.sm },
    typography: {
      fontFamily: dt.font_family,
      h4: { fontWeight: 900, letterSpacing: '-0.02em' },
      h5: { fontWeight: 900, letterSpacing: '-0.02em' },
      h6: { fontWeight: 850 },
      overline: { fontWeight: 900, letterSpacing: '0.14em' },
      button: { fontWeight: 800 },
    },
    components: {
      MuiPaper: {
        defaultProps: { elevation: 0 },
        variants: [
          {
            props: { variant: 'surface' },
            style: {
              backgroundColor: mt.surface,
              backgroundImage: 'none',
              border: `1px solid ${mt.outline}`,
              borderRadius: radius.lg,
            },
          },
          {
            props: { variant: 'hero' },
            style: {
              background: mt.heroMesh,
              border: `1px solid ${mt.outline}`,
              borderRadius: radius.xl,
            },
          },
        ],
      },
      MuiButton: {
        styleOverrides: {
          root: {
            textTransform: 'none',
            fontWeight: 800,
            borderRadius: radius.pill,
          },
        },
      },
      MuiButtonGroup: {
        styleOverrides: {
          root: { borderRadius: radius.pill },
        },
      },
      MuiChip: {
        styleOverrides: {
          root: { borderRadius: radius.pill, fontWeight: 750 },
        },
      },
      MuiAlert: {
        styleOverrides: {
          root: { borderRadius: radius.md },
        },
      },
      MuiDialog: {
        styleOverrides: {
          paper: {
            backgroundColor: mt.dialogPaper,
            backgroundImage: 'none',
            borderRadius: radius.lg,
            border: `1px solid ${mt.outline}`,
          },
        },
      },
      MuiTooltip: {
        styleOverrides: {
          tooltip: {
            backgroundColor: mt.surfaceRaised,
            border: `1px solid ${mt.outline}`,
            color: dt.primary_text,
            borderRadius: radius.sm,
            fontWeight: 600,
          },
        },
      },
    },
  })
}

/**
 * custom theme
 */
export const useCustomTheme = () => {
  const appWindow: WebviewWindow = useMemo(() => getCurrentWebviewWindow(), [])
  const { verge } = useVerge()
  const { theme_mode } = verge ?? {}
  const mode = useThemeMode()
  const setMode = useSetThemeMode()

  useEffect(() => {
    if (theme_mode === 'light' || theme_mode === 'dark') {
      setMode(theme_mode)
    } else {
      // Light is the primary brand surface (direction two).
      setMode('light')
    }
  }, [theme_mode, setMode])

  useEffect(() => {
    if (theme_mode !== 'system') {
      return
    }

    setMode('light')
  }, [theme_mode, appWindow, setMode])

  useEffect(() => {
    if (theme_mode === undefined || theme_mode === 'system') {
      appWindow.setTheme('light' as TauriOsTheme).catch((err) => {
        reportSafeClientFailure('theme-window-set', err)
      })
    } else if (mode) {
      appWindow.setTheme(mode as TauriOsTheme).catch((err) => {
        reportSafeClientFailure('theme-window-set', err)
      })
    }
  }, [mode, appWindow, theme_mode])

  const theme = useMemo(() => {
    const dt = mode === 'light' ? defaultTheme : defaultDarkTheme
    const mt = modeTokens(mode)
    let muiTheme: MuiTheme

    try {
      muiTheme = buildTheme(mode)
    } catch (error) {
      reportSafeClientFailure('theme-create', error)
      muiTheme = createTheme({
        palette: {
          mode,
          primary: { main: dt.primary_color },
          background: {
            paper: mt.surface,
            default: dt.background_color,
          },
        },
        typography: { fontFamily: dt.font_family },
      })
    }

    const rootEle = document.documentElement
    if (rootEle) {
      const backgroundColor = dt.background_color
      const selectColor = mode === 'light' ? '#EAF1FF' : '#1B2A44'
      const scrollColor = mt.scrollbarThumb
      rootEle.style.setProperty('--divider-color', mt.outline)
      rootEle.style.setProperty('--background-color', backgroundColor)
      rootEle.style.setProperty('--selection-color', selectColor)
      rootEle.style.setProperty('--scroller-color', scrollColor)
      rootEle.style.setProperty('--primary-main', muiTheme.palette.primary.main)
      rootEle.style.setProperty(
        '--background-color-alpha',
        alpha(muiTheme.palette.primary.main, 0.1),
      )
      rootEle.style.setProperty('--window-border-color', mt.outline)
      rootEle.style.setProperty('--scrollbar-bg', mt.scrollbarBg)
      rootEle.style.setProperty('--scrollbar-thumb', mt.scrollbarThumb)
      rootEle.style.setProperty('--surface-color', mt.surface)
      rootEle.style.setProperty('--surface-raised-color', mt.surfaceRaised)
      rootEle.style.setProperty('--outline-color', mt.outline)
    }

    let styleElement = document.querySelector('style#verge-theme')
    if (!styleElement) {
      styleElement = document.createElement('style')
      styleElement.id = 'verge-theme'
      document.head.appendChild(styleElement!)
    }

    if (styleElement) {
      const globalStyles = `
        /* Scrollbars are hidden app-wide (owner directive 2026-08-21):
           scrolling stays functional, the chrome disappears. */
        ::-webkit-scrollbar {
          width: 0;
          height: 0;
          display: none;
        }
        * {
          scrollbar-width: none;
        }

        /* page ground */
        body {
          background-color: var(--background-color);
        }

        *:focus {
          outline: none;
        }
        ::selection {
          background: var(--selection-color);
        }
      `

      styleElement.innerHTML = globalStyles
    }

    const { palette } = muiTheme
    setTimeout(() => {
      const dom = document.querySelector('#Gradient2')
      if (dom) {
        dom.innerHTML = `
        <stop offset="0%" stop-color="${palette.primary.main}" />
        <stop offset="80%" stop-color="${palette.primary.dark}" />
        <stop offset="100%" stop-color="${palette.primary.dark}" />
        `
      }
    }, 0)

    return muiTheme
  }, [mode])

  return { theme }
}
