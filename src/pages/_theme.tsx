import getSystem from '@/utils/get-system'
const OS = getSystem()

// default theme setting
export const defaultTheme = {
  primary_color: '#1D5FD1',
  secondary_color: '#10A37F',
  primary_text: '#172033',
  secondary_text: '#657084',
  info_color: '#1D5FD1',
  error_color: '#DC2626',
  warning_color: '#D97706',
  success_color: '#10A37F',
  background_color: '#F4F7FB',
  font_family: `-apple-system, BlinkMacSystemFont,"Microsoft YaHei UI", "Microsoft YaHei", Roboto, "Helvetica Neue", Arial, sans-serif, "Apple Color Emoji"${
    OS === 'windows' ? ', twemoji mozilla' : ''
  }`,
}

// dark mode
export const defaultDarkTheme = {
  ...defaultTheme,
  primary_color: '#8B5CF6',
  secondary_color: '#34D399',
  primary_text: '#F4F4F5',
  background_color: '#0B0C0F',
  secondary_text: '#A1A1AA',
  info_color: '#A78BFA',
  error_color: '#F87171',
  warning_color: '#FCD34D',
  success_color: '#34D399',
}
