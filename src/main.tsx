import './assets/styles/index.scss'

import createCache from '@emotion/cache'
import { CacheProvider } from '@emotion/react'
import { ResizeObserver } from '@juggle/resize-observer'
import { QueryClientProvider } from '@tanstack/react-query'
import { ComposeContextProvider } from 'foxact/compose-context-provider'
import React from 'react'
import { createRoot } from 'react-dom/client'
import { RouterProvider } from 'react-router'
import { MihomoWebSocket } from 'tauri-plugin-mihomo-api'

import { BaseErrorBoundary } from './components/base'
import {
  STARTUP_TIMEOUT_NOTICE_KEY,
  StartupTimeoutNotice,
} from './components/layout/startup-timeout-notice'
import { hideInitialOverlay } from './pages/_layout/utils'
import { router } from './pages/_routers'
import { WindowProvider } from './providers/window'
import { startAccountRuntimeEnforcement } from './services/account-runtime-enforcement'
import { AuthProvider, authStore } from './services/auth-store'
import { FALLBACK_LANGUAGE, initializeLanguage } from './services/i18n'
import {
  getPreloadConfig,
  preloadAppData,
  resolveThemeMode,
} from './services/preload'
import { queryClient } from './services/query-client'
import {
  runResumeRecovery,
  startResumeRecoveryListeners,
} from './services/resume-recovery'
import {
  handleGlobalErrorEvent,
  handleGlobalPromiseRejection,
  reportSafeClientFailure,
  toSafeClientFailureRecord,
  writeSafeClientFailureToClipboard,
} from './services/safe-client-error'
import { initializeSecureSession } from './services/secure-session-controller'
import { SESSION_EXPIRED_EVENT } from './services/session'
import {
  LoadingCacheProvider,
  ThemeModeProvider,
  UpdateStateProvider,
} from './services/states'
import { startSubscriptionAutoSync } from './services/subscription-auto-sync'
import { disableWebViewShortcuts } from './utils/disable-webview-shortcuts'

if (!window.ResizeObserver) {
  window.ResizeObserver = ResizeObserver
}

const mainElementId = 'root'
const container = document.getElementById(mainElementId)

if (!container) {
  throw new Error(`No container '${mainElementId}' found to render application`)
}

disableWebViewShortcuts()

const getCspNonce = (): string | undefined => {
  const metaNonce = document.querySelector<HTMLMetaElement>(
    'meta[property="csp-nonce"]',
  )?.content
  if (metaNonce) return metaNonce

  // Tauri injects the production style nonce into the bundled inline style.
  // Read the DOM property because browsers hide nonce values from getAttribute.
  const nonceElement = document.querySelector<HTMLElement>(
    'style[nonce], script[nonce]',
  )
  return nonceElement?.nonce || undefined
}

const emotionCache = createCache({
  key: 'mui',
  nonce: getCspNonce(),
  prepend: true,
})

const removeSplashSoon = () => {
  window.requestAnimationFrame(() => {
    hideInitialOverlay({ assumeMissingAsRemoved: true })
  })
}

const BOOT_TIMEOUT_MS = 2500

const initializeApp = (
  initialThemeMode: 'light' | 'dark',
  options: { removeSplash?: boolean } = {},
) => {
  const contexts = [
    <ThemeModeProvider key="theme" initialState={initialThemeMode} />,
    <LoadingCacheProvider key="loading" />,
    <UpdateStateProvider key="update" />,
  ]

  const root = createRoot(container)
  root.render(
    <React.StrictMode>
      <CacheProvider value={emotionCache}>
        <ComposeContextProvider contexts={contexts}>
          <BaseErrorBoundary>
            <QueryClientProvider client={queryClient}>
              <AuthProvider>
                <WindowProvider>
                  <StartupTimeoutNotice />
                  <RouterProvider router={router} />
                </WindowProvider>
              </AuthProvider>
            </QueryClientProvider>
          </BaseErrorBoundary>
        </ComposeContextProvider>
      </CacheProvider>
    </React.StrictMode>,
  )

  if (options.removeSplash !== false) {
    removeSplashSoon()
  }
}

const renderSplashTimeoutFallback = (error: unknown) => {
  const overlay = document.getElementById('initial-loading-overlay')
  if (!overlay) return
  overlay.innerHTML = ''

  const wrap = document.createElement('div')
  wrap.style.cssText =
    'display:flex;flex-direction:column;align-items:center;gap:16px;padding:24px;text-align:center;max-width:420px;'

  const title = document.createElement('div')
  title.style.cssText = 'font-size:16px;font-weight:600;line-height:1.4;'
  title.textContent = 'App startup timed out'
  wrap.appendChild(title)

  const btnRow = document.createElement('div')
  btnRow.style.cssText = 'display:flex;gap:12px;margin-top:8px;'

  const reloadBtn = document.createElement('button')
  reloadBtn.textContent = 'Restart app'
  reloadBtn.style.cssText =
    'padding:8px 16px;border-radius:6px;border:none;background:#4f46e5;color:#fff;font-size:14px;cursor:pointer;'
  reloadBtn.addEventListener('click', () => {
    window.location.reload()
  })

  const continueBtn = document.createElement('button')
  continueBtn.textContent = 'Continue'
  continueBtn.style.cssText =
    'padding:8px 16px;border-radius:6px;border:1px solid #d1d5db;background:transparent;color:inherit;font-size:14px;cursor:pointer;'
  continueBtn.addEventListener('click', () => {
    hideInitialOverlay({ assumeMissingAsRemoved: true })
  })

  const exportBtn = document.createElement('button')
  exportBtn.textContent = 'Copy log'
  exportBtn.style.cssText =
    'padding:8px 16px;border-radius:6px;border:1px solid #d1d5db;background:transparent;color:inherit;font-size:14px;cursor:pointer;'
  exportBtn.addEventListener('click', () => {
    if (!navigator.clipboard) return
    void writeSafeClientFailureToClipboard('startup-timeout', error, (text) =>
      navigator.clipboard.writeText(text),
    ).catch((clipboardError) =>
      reportSafeClientFailure('startup-timeout-copy', clipboardError),
    )
  })

  btnRow.appendChild(reloadBtn)
  btnRow.appendChild(continueBtn)
  btnRow.appendChild(exportBtn)
  wrap.appendChild(btnRow)
  overlay.appendChild(wrap)
}

const rememberStartupTimeout = (error: unknown) => {
  try {
    localStorage.setItem(
      STARTUP_TIMEOUT_NOTICE_KEY,
      JSON.stringify({
        ...toSafeClientFailureRecord('startup-timeout', error),
        ts: Date.now(),
      }),
    )
  } catch {
    /* ignore */
  }
}

const startBackgroundStartupTasks = () => {
  startAccountRuntimeEnforcement()
  startSubscriptionAutoSync()
  startResumeRecoveryListeners()

  if (!authStore.getState().isOperational) return
  void runResumeRecovery('startup', { force: true })
}

const bootstrap = async () => {
  await initializeSecureSession()
  const timeoutSymbol = Symbol('preload-timeout')
  const result = await Promise.race([
    preloadAppData(),
    new Promise<typeof timeoutSymbol>((resolve) =>
      setTimeout(() => resolve(timeoutSymbol), BOOT_TIMEOUT_MS),
    ),
  ])

  if (result === timeoutSymbol) {
    const timeoutError = new Error('App startup timed out')
    reportSafeClientFailure('startup-timeout', timeoutError)
    rememberStartupTimeout(timeoutError)
    renderSplashTimeoutFallback(timeoutError)
    initializeApp(resolveThemeMode(getPreloadConfig()))
    startBackgroundStartupTasks()
    return
  }

  initializeApp(result.initialThemeMode)
  startBackgroundStartupTasks()
}

window.addEventListener(SESSION_EXPIRED_EVENT, () => {
  queryClient.clear()
  removeSplashSoon()
})

bootstrap().catch((error) => {
  reportSafeClientFailure('app-bootstrap', error)
  initializeLanguage(FALLBACK_LANGUAGE)
    .catch((fallbackError) => {
      reportSafeClientFailure('fallback-language-init', fallbackError)
    })
    .finally(() => {
      initializeApp(resolveThemeMode(getPreloadConfig()))
      startBackgroundStartupTasks()
    })
})

window.addEventListener('error', handleGlobalErrorEvent)

window.addEventListener('unhandledrejection', handleGlobalPromiseRejection)

window.addEventListener('beforeunload', () => {
  MihomoWebSocket.cleanupAll()
})

window.addEventListener('DOMContentLoaded', () => {
  MihomoWebSocket.cleanupAll()
})
