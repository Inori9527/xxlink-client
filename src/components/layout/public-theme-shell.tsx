import { ThemeProvider } from '@mui/material'
import { Outlet } from 'react-router'

import { useCustomTheme } from '@/pages/_layout/hooks/use-custom-theme'

/**
 * Public routes render outside <Layout/>, so they need their own
 * ThemeProvider — without it, MUI falls back to its default theme and the
 * token system (palette, surface variant, pill buttons, CSS variables)
 * never reaches the auth screens.
 */
export const PublicThemeShell = () => {
  const { theme } = useCustomTheme()
  return (
    <ThemeProvider theme={theme}>
      <Outlet />
    </ThemeProvider>
  )
}
