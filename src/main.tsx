import './assets/styles/index.scss'
import './services/monaco'

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
import { router } from './pages/_routers'
import { AppDataProvider } from './providers/app-data-provider'
import { WindowProvider } from './providers/window'
import { AuthProvider, authStore } from './services/auth-store'
import { FALLBACK_LANGUAGE, initializeLanguage } from './services/i18n'
import {
  preloadAppData,
  resolveThemeMode,
  getPreloadConfig,
} from './services/preload'
import { queryClient } from './services/query-client'
import {
  LoadingCacheProvider,
  ThemeModeProvider,
  UpdateStateProvider,
} from './services/states'
import { syncSubscription } from './services/subscription-sync'
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

// Tauri 2 auto-injects a nonce into the CSP style-src directive at runtime.
// Per CSP spec, when a nonce is present, `'unsafe-inline'` is ignored — so
// any inline styles emotion (MUI's style engine) injects without a matching
// nonce get blocked. Read the Tauri-supplied nonce from the runtime CSP and
// thread it through emotion's cache so its <style> tags pass the policy.
const getCspNonce = (): string | undefined => {
  const metaNonce = document.querySelector<HTMLMetaElement>(
    'meta[property="csp-nonce"]',
  )?.content
  if (metaNonce) return metaNonce
  // Tauri exposes the nonce on a script element with [data-tauri-nonce]
  const scriptNonce = document
    .querySelector<HTMLScriptElement>('script[nonce]')
    ?.getAttribute('nonce')
  return scriptNonce ?? undefined
}

const emotionCache = createCache({
  key: 'mui',
  nonce: getCspNonce(),
  prepend: true,
})

const initializeApp = (initialThemeMode: 'light' | 'dark') => {
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
                  <AppDataProvider>
                    <RouterProvider router={router} />
                  </AppDataProvider>
                </WindowProvider>
              </AuthProvider>
            </QueryClientProvider>
          </BaseErrorBoundary>
        </ComposeContextProvider>
      </CacheProvider>
    </React.StrictMode>,
  )
}

const BOOT_TIMEOUT_MS = 8000

const renderSplashTimeoutFallback = (error: unknown) => {
  const overlay = document.getElementById('initial-loading-overlay')
  if (!overlay) return
  // Swap innerHTML — React has not mounted yet, so we build plain DOM.
  overlay.innerHTML = ''

  const wrap = document.createElement('div')
  wrap.style.cssText =
    'display:flex;flex-direction:column;align-items:center;gap:16px;padding:24px;text-align:center;max-width:420px;'

  const title = document.createElement('div')
  title.style.cssText = 'font-size:16px;font-weight:600;line-height:1.4;'
  title.textContent = '应用启动超时 / App startup timed out'
  wrap.appendChild(title)

  const btnRow = document.createElement('div')
  btnRow.style.cssText = 'display:flex;gap:12px;margin-top:8px;'

  const reloadBtn = document.createElement('button')
  reloadBtn.textContent = '重启应用'
  reloadBtn.style.cssText =
    'padding:8px 16px;border-radius:6px;border:none;background:#4f46e5;color:#fff;font-size:14px;cursor:pointer;'
  reloadBtn.addEventListener('click', () => {
    window.location.reload()
  })

  const exportBtn = document.createElement('button')
  exportBtn.textContent = '导出日志'
  exportBtn.style.cssText =
    'padding:8px 16px;border-radius:6px;border:1px solid #d1d5db;background:transparent;color:inherit;font-size:14px;cursor:pointer;'
  exportBtn.addEventListener('click', () => {
    const payload = {
      error: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack : undefined,
      ua: navigator.userAgent,
      time: new Date().toISOString(),
    }
    void navigator.clipboard
      ?.writeText(JSON.stringify(payload, null, 2))
      .catch(console.error)
  })

  btnRow.appendChild(reloadBtn)
  btnRow.appendChild(exportBtn)
  wrap.appendChild(btnRow)
  overlay.appendChild(wrap)
}

const bootstrap = async () => {
  const timeoutSymbol = Symbol('preload-timeout')
  const result = await Promise.race([
    preloadAppData(),
    new Promise<typeof timeoutSymbol>((resolve) =>
      setTimeout(() => resolve(timeoutSymbol), BOOT_TIMEOUT_MS),
    ),
  ])

  if (result === timeoutSymbol) {
    const timeoutError = new Error('App startup timed out')
    console.error('[main.tsx]', timeoutError)
    renderSplashTimeoutFallback(timeoutError)
    // Still attempt to render the app so the user can proceed if they dismiss.
    initializeApp(resolveThemeMode(getPreloadConfig()))
    return
  }

  initializeApp(result.initialThemeMode)

  // Sync subscription in the background if the user is already logged in
  if (authStore.getState().isAuthenticated) {
    // Non-blocking — must never freeze the UI
    Promise.race([
      syncSubscription(),
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error('syncSubscription timeout')), 10000),
      ),
    ])
      .then(() => {
        // Clear any stale error flag from a previous failed startup
        try {
          localStorage.removeItem('xxlink:last-sync-error')
          window.dispatchEvent(
            new CustomEvent('xxlink:last-sync-error-changed'),
          )
        } catch {
          /* ignore */
        }
      })
      .catch((error) => {
        console.error(error)
        try {
          localStorage.setItem(
            'xxlink:last-sync-error',
            JSON.stringify({
              message: error instanceof Error ? error.message : String(error),
              ts: Date.now(),
            }),
          )
          window.dispatchEvent(
            new CustomEvent('xxlink:last-sync-error-changed'),
          )
        } catch {
          /* ignore */
        }
      })
  }
}

bootstrap().catch((error) => {
  console.error(
    '[main.tsx] App bootstrap failed, falling back to default language:',
    error,
  )
  initializeLanguage(FALLBACK_LANGUAGE)
    .catch((fallbackError) => {
      console.error(
        '[main.tsx] Fallback language initialization failed:',
        fallbackError,
      )
    })
    .finally(() => {
      initializeApp(resolveThemeMode(getPreloadConfig()))
    })
})

// Error handling
window.addEventListener('error', (event) => {
  console.error('[main.tsx] Global error:', event.error)
})

window.addEventListener('unhandledrejection', (event) => {
  console.error('[main.tsx] Unhandled promise rejection:', event.reason)
})

// Page close/refresh events
window.addEventListener('beforeunload', () => {
  // Clean up all WebSocket instances to prevent memory leaks
  MihomoWebSocket.cleanupAll()
})

// Page loaded event
window.addEventListener('DOMContentLoaded', () => {
  // Clean up all WebSocket instances to prevent memory leaks
  MihomoWebSocket.cleanupAll()
})
