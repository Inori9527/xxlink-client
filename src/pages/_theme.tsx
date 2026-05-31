import getSystem from '@/utils/get-system'
const OS = getSystem()

// default theme setting
export const defaultTheme = {
  primary_color: '#111111',
  secondary_color: '#4B5563',
  primary_text: '#171717',
  secondary_text: '#666666',
  info_color: '#111111',
  error_color: '#DC2626',
  warning_color: '#D97706',
  success_color: '#059669',
  background_color: '#FFFFFF',
  font_family: `-apple-system, BlinkMacSystemFont,"Microsoft YaHei UI", "Microsoft YaHei", Roboto, "Helvetica Neue", Arial, sans-serif, "Apple Color Emoji"${
    OS === 'windows' ? ', twemoji mozilla' : ''
  }`,
}

// dark mode
export const defaultDarkTheme = {
  ...defaultTheme,
  primary_color: '#111111',
  secondary_color: '#4B5563',
  primary_text: '#171717',
  background_color: '#FFFFFF',
  secondary_text: '#666666',
  info_color: '#111111',
  error_color: '#DC2626',
  warning_color: '#D97706',
  success_color: '#059669',
}
