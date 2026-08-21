import getSystem from '@/utils/get-system'
const OS = getSystem()

/**
 * XXLink design tokens — light-first premium ("direction two").
 *
 * The light set is the primary brand surface: soft blue-white ground,
 * brand blue (#2F80ED), and deepened teal accent (#0FD3BF). Dark remains
 * available as a secondary mode and shares the same structure.
 */

const fontFamily = `-apple-system, BlinkMacSystemFont,"Microsoft YaHei UI", "Microsoft YaHei", Roboto, "Helvetica Neue", Arial, sans-serif, "Apple Color Emoji"${
  OS === 'windows' ? ', twemoji mozilla' : ''
}`

// default theme setting (light — primary brand surface)
export const defaultTheme = {
  primary_color: '#2F80ED',
  secondary_color: '#0FD3BF',
  primary_text: '#16233B',
  secondary_text: '#5D6B84',
  info_color: '#2F80ED',
  error_color: '#DC2626',
  warning_color: '#D97706',
  success_color: '#0FA678',
  background_color: '#F2F6FC',
  font_family: fontFamily,
}

// dark mode (secondary brand surface)
export const defaultDarkTheme = {
  ...defaultTheme,
  primary_color: '#3E8EF7',
  secondary_color: '#0FEDD2',
  primary_text: '#EDF3FC',
  secondary_text: '#93A5C1',
  info_color: '#4D9DFF',
  error_color: '#FF6070',
  warning_color: '#FFB454',
  success_color: '#2FD8A0',
  background_color: '#0A111F',
}

/**
 * Structural tokens shared by every page. Pages must consume these
 * (directly or through the theme's component variants) instead of
 * hand-rolling per-card borders, radii, and gradients.
 */
export const designTokens = {
  radius: { sm: 10, md: 16, lg: 24, xl: 32, pill: 999 },
  dark: {
    surface: '#101A2E',
    surfaceRaised: '#152238',
    outline: 'rgba(146, 178, 224, 0.12)',
    outlineStrong: 'rgba(146, 178, 224, 0.24)',
    heroMesh:
      'radial-gradient(circle at 85% 0%, rgba(15, 237, 210, 0.14), transparent 34%),' +
      ' radial-gradient(circle at 0% 100%, rgba(62, 142, 247, 0.16), transparent 30%),' +
      ' linear-gradient(180deg, #101A2E 0%, #0C1526 100%)',
    glowPrimary: 'rgba(62, 142, 247, 0.45)',
    glowAccent: 'rgba(15, 237, 210, 0.35)',
    glowSuccess: 'rgba(47, 216, 160, 0.45)',
    glowError: 'rgba(255, 96, 112, 0.40)',
    scrollbarBg: '#0B1322',
    scrollbarThumb: '#2A3B58',
    dialogPaper: '#152238',
  },
  light: {
    surface: '#FFFFFF',
    surfaceRaised: '#FFFFFF',
    outline: 'rgba(23, 42, 77, 0.08)',
    outlineStrong: 'rgba(23, 42, 77, 0.16)',
    heroMesh:
      'radial-gradient(circle at 50% 0%, rgba(47, 128, 237, 0.10), transparent 42%),' +
      ' linear-gradient(180deg, #FFFFFF 0%, #F2F8FF 100%)',
    glowPrimary: 'rgba(47, 128, 237, 0.28)',
    glowAccent: 'rgba(15, 211, 191, 0.22)',
    glowSuccess: 'rgba(15, 166, 120, 0.28)',
    glowError: 'rgba(220, 38, 38, 0.22)',
    scrollbarBg: '#EDF2F9',
    scrollbarThumb: '#C3CEDD',
    dialogPaper: '#FFFFFF',
  },
}

export type ModeTokens = (typeof designTokens)['dark']

export const modeTokens = (mode: 'light' | 'dark'): ModeTokens =>
  mode === 'light' ? designTokens.light : designTokens.dark
