import getSystem from '@/utils/get-system'
const OS = getSystem()

// default theme setting
export const defaultTheme = {
  primary_color: '#4f46e5',
  secondary_color: '#818cf8',
  primary_text: '#000000',
  secondary_text: '#3C3C4399',
  info_color: '#4f46e5',
  error_color: '#FF3B30',
  warning_color: '#FF9500',
  success_color: '#06943D',
  background_color: '#F5F5F5',
  font_family: `-apple-system, BlinkMacSystemFont,"Microsoft YaHei UI", "Microsoft YaHei", Roboto, "Helvetica Neue", Arial, sans-serif, "Apple Color Emoji"${
    OS === 'windows' ? ', twemoji mozilla' : ''
  }`,
}

// dark mode
export const defaultDarkTheme = {
  ...defaultTheme,
  primary_color: '#6366f1',
  secondary_color: '#a5b4fc',
  primary_text: '#FFFFFF',
  background_color: '#2E303D',
  secondary_text: '#EBEBF599',
  info_color: '#6366f1',
  error_color: '#FF453A',
  warning_color: '#FF9F0A',
  success_color: '#30D158',
}
