/**
 * Global auth state store.
 *
 * Tokens are persisted in localStorage (the Tauri WebView's localStorage,
 * which is sandboxed per app identifier and never exposed to the network).
 *
 * Exposes a React context + hook for components, and a plain singleton
 * `authStore` for non-component code (e.g. the API refresh interceptor).
 */
import {
  createContext,
  use,
  useState,
  useEffect,
  useCallback,
  createElement,
  type ReactNode,
} from 'react'

import type { AuthUser } from './auth'

// ---------------------------------------------------------------------------
// localStorage keys
// ---------------------------------------------------------------------------

const LS_ACCESS_TOKEN = 'xxlink_access_token'
const LS_REFRESH_TOKEN = 'xxlink_refresh_token'
const LS_USER = 'xxlink_user'

// ---------------------------------------------------------------------------
// In-memory singleton (shared between context and non-React code)
// ---------------------------------------------------------------------------

interface AuthState {
  user: AuthUser | null
  accessToken: string | null
  refreshToken: string | null
  isAuthenticated: boolean
}

function loadFromStorage(): AuthState {
  try {
    const accessToken = localStorage.getItem(LS_ACCESS_TOKEN)
    const refreshToken = localStorage.getItem(LS_REFRESH_TOKEN)
    const userRaw = localStorage.getItem(LS_USER)
    const user: AuthUser | null = userRaw
      ? (JSON.parse(userRaw) as AuthUser)
      : null
    const isAuthenticated = Boolean(accessToken && user)
    return { user, accessToken, refreshToken, isAuthenticated }
  } catch {
    return {
      user: null,
      accessToken: null,
      refreshToken: null,
      isAuthenticated: false,
    }
  }
}

function saveToStorage(
  user: AuthUser,
  accessToken: string,
  refreshToken: string,
): void {
  localStorage.setItem(LS_ACCESS_TOKEN, accessToken)
  localStorage.setItem(LS_REFRESH_TOKEN, refreshToken)
  localStorage.setItem(LS_USER, JSON.stringify(user))
}

function clearStorage(): void {
  localStorage.removeItem(LS_ACCESS_TOKEN)
  localStorage.removeItem(LS_REFRESH_TOKEN)
  localStorage.removeItem(LS_USER)
}

// ---------------------------------------------------------------------------
// Plain singleton for non-React callers
// ---------------------------------------------------------------------------

type Listener = () => void

class AuthStoreSingleton {
  private state: AuthState = loadFromStorage()
  private listeners: Set<Listener> = new Set()

  getState(): AuthState {
    return this.state
  }

  setAuth(user: AuthUser, accessToken: string, refreshToken: string): void {
    saveToStorage(user, accessToken, refreshToken)
    this.state = { user, accessToken, refreshToken, isAuthenticated: true }
    this.notify()
  }

  clearAuth(): void {
    clearStorage()
    this.state = {
      user: null,
      accessToken: null,
      refreshToken: null,
      isAuthenticated: false,
    }
    this.notify()
  }

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  private notify(): void {
    this.listeners.forEach((l) => l())
  }
}

export const authStore = new AuthStoreSingleton()

// ---------------------------------------------------------------------------
// React context
// ---------------------------------------------------------------------------

interface AuthContextValue extends AuthState {
  setAuth: (user: AuthUser, accessToken: string, refreshToken: string) => void
  clearAuth: () => void
}

const AuthContext = createContext<AuthContextValue | null>(null)

interface AuthProviderProps {
  children: ReactNode
}

export function AuthProvider({ children }: AuthProviderProps): ReactNode {
  const [state, setState] = useState<AuthState>(() => authStore.getState())

  useEffect(() => {
    // Keep context state in sync with singleton (e.g. when token refresh
    // updates the singleton from outside a React render cycle)
    return authStore.subscribe(() => {
      setState(authStore.getState())
    })
  }, [])

  const setAuth = useCallback(
    (user: AuthUser, accessToken: string, refreshToken: string) => {
      authStore.setAuth(user, accessToken, refreshToken)
      // listener above will fire, but we also set locally for immediate render
      setState(authStore.getState())
    },
    [],
  )

  const clearAuth = useCallback(() => {
    authStore.clearAuth()
    setState(authStore.getState())
  }, [])

  return createElement(
    AuthContext.Provider,
    {
      value: {
        ...state,
        setAuth,
        clearAuth,
      },
    },
    children,
  )
}

export function useAuth(): AuthContextValue {
  const ctx = use(AuthContext)
  if (!ctx) {
    throw new Error('useAuth must be used inside <AuthProvider>')
  }
  return ctx
}
