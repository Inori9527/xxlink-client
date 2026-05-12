import getSystem from '@/utils/get-system'
const OS = getSystem()

// default theme setting
export const defaultTheme = {
  primary_color: '#2F80ED',
  secondary_color: '#0FEDD2',
  primary_text: '#172033',
  secondary_text: '#657084',
  info_color: '#2F80ED',
  error_color: '#DC2626',
  warning_color: '#D97706',
  success_color: '#10A37F',
  background_color: '#F4FAFF',
  font_family: `-apple-system, BlinkMacSystemFont,"Microsoft YaHei UI", "Microsoft YaHei", Roboto, "Helvetica Neue", Arial, sans-serif, "Apple Color Emoji"${
    OS === 'windows' ? ', twemoji mozilla' : ''
  }`,
}

// dark mode
export const defaultDarkTheme = {
  ...defaultTheme,
  primary_color: '#2F80ED',
  secondary_color: '#0FEDD2',
  primary_text: '#F4F4F5',
  background_color: '#071018',
  secondary_text: '#9AA7B8',
  info_color: '#38BDF8',
  error_color: '#F87171',
  warning_color: '#FCD34D',
  success_color: '#0FEDD2',
}
