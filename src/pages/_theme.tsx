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
  background_color: '#F6F6F7',
  font_family: `-apple-system, BlinkMacSystemFont,"Microsoft YaHei UI", "Microsoft YaHei", Roboto, "Helvetica Neue", Arial, sans-serif, "Apple Color Emoji"${
    OS === 'windows' ? ', twemoji mozilla' : ''
  }`,
}

// dark mode
export const defaultDarkTheme = {
  ...defaultTheme,
  primary_color: '#F5F5F5',
  secondary_color: '#A3A3A3',
  primary_text: '#F4F4F5',
  background_color: '#0B0B0D',
  secondary_text: '#A1A1AA',
  info_color: '#F5F5F5',
  error_color: '#F87171',
  warning_color: '#FCD34D',
  success_color: '#34D399',
}
