import {
  cacheLanguage,
  getCachedLanguage,
  initializeLanguage,
  resolveLanguage,
} from './i18n'
import { runtimeActionController } from './runtime-action-controller'
import type { RuntimePreferencesView } from './runtime-action-controller'
import { reportSafeClientFailure } from './safe-client-error'

let vergeConfigCache: RuntimePreferencesView | null | undefined

const getThemeModeFromWindow = ():
  | RuntimePreferencesView['theme_mode']
  | undefined => {
  if (typeof window === 'undefined') return undefined
  const mode = (
    window as typeof window & {
      __VERGE_INITIAL_THEME_MODE?: unknown
    }
  ).__VERGE_INITIAL_THEME_MODE
  if (mode === 'light' || mode === 'dark' || mode === 'system') {
    return mode
  }
  return undefined
}

export const resolveThemeMode = (
  vergeConfig?: RuntimePreferencesView | null,
): 'light' | 'dark' => {
  const initialMode = vergeConfig?.theme_mode ?? getThemeModeFromWindow()
  if (initialMode === 'dark' || initialMode === 'light') {
    return initialMode
  }
  return 'light'
}

export const setPreloadConfig = (config: RuntimePreferencesView | null) => {
  vergeConfigCache = config
}

export const getPreloadConfig = () => vergeConfigCache

export const preloadConfig = async () => {
  try {
    const config = await runtimeActionController.getPreferences()
    setPreloadConfig(config)
    return config
  } catch (error) {
    reportSafeClientFailure('preload-config', error)
    setPreloadConfig(null)
    return null
  }
}

export const preloadLanguage = async (
  vergeConfig?: RuntimePreferencesView | null,
  loadConfig: () => Promise<RuntimePreferencesView | null> = preloadConfig,
) => {
  const cachedLanguage = getCachedLanguage()
  if (cachedLanguage) {
    return cachedLanguage
  }

  let resolvedConfig = vergeConfig

  if (resolvedConfig === undefined) {
    try {
      resolvedConfig = await loadConfig()
    } catch (error) {
      reportSafeClientFailure('preload-language', error)
      resolvedConfig = null
    }
  }

  const languageFromConfig = resolvedConfig?.language
  if (languageFromConfig) {
    const resolved = resolveLanguage(languageFromConfig)
    cacheLanguage(resolved)
    return resolved
  }

  const browserLanguage = resolveLanguage(
    typeof navigator !== 'undefined' ? navigator.language : undefined,
  )
  cacheLanguage(browserLanguage)
  return browserLanguage
}

export const preloadAppData = async () => {
  const configPromise = preloadConfig()
  const initialLanguage = await preloadLanguage(undefined, () => configPromise)
  const [config] = await Promise.all([
    configPromise,
    initializeLanguage(initialLanguage),
  ])
  const initialThemeMode = resolveThemeMode(config)
  return { initialThemeMode }
}
