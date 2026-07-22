/**
 * Global account shell state.
 *
 * Credentials live behind SecureSessionVault. React receives only the
 * displayable account and a categorized secure-session state.
 */
import {
  createContext,
  use,
  useState,
  useEffect,
  createElement,
  type ReactNode,
} from 'react'

import { clearAccountLkgCache } from './account-lkg-cache'
export interface AuthUser {
  id: string
  email: string
  role: 'USER' | 'ADMIN'
}

const LEGACY_ACCESS_TOKEN_KEY = 'xxlink_access_token'
const LEGACY_REFRESH_TOKEN_KEY = 'xxlink_refresh_token'
const LS_USER = 'xxlink_user'

export type SecureSessionStatus =
  | 'initializing'
  | 'operational'
  | 'recovery_required'
  | 'service_blocked'
  | 'signed_out'

export interface AuthState {
  user: AuthUser | null
  sessionStatus: SecureSessionStatus
  isAuthenticated: boolean
  isOperational: boolean
}

function isAuthUser(value: unknown): value is AuthUser {
  if (!value || typeof value !== 'object') return false
  const record = value as Record<string, unknown>
  return (
    typeof record.id === 'string' &&
    record.id.length > 0 &&
    typeof record.email === 'string' &&
    (record.role === 'USER' || record.role === 'ADMIN')
  )
}

function loadUser(): AuthUser | null {
  try {
    const raw = localStorage.getItem(LS_USER)
    if (!raw) return null
    const value: unknown = JSON.parse(raw)
    return isAuthUser(value) ? value : null
  } catch {
    return null
  }
}

function toState(
  user: AuthUser | null,
  sessionStatus: SecureSessionStatus,
): AuthState {
  const isAuthenticated = user !== null && sessionStatus !== 'signed_out'
  return {
    user,
    sessionStatus,
    isAuthenticated,
    isOperational: isAuthenticated && sessionStatus === 'operational',
  }
}

function loadFromStorage(): AuthState {
  const user = loadUser()
  return toState(user, user ? 'initializing' : 'signed_out')
}

function saveUser(user: AuthUser): void {
  localStorage.setItem(LS_USER, JSON.stringify(user))
}

function clearStorage(): void {
  localStorage.removeItem(LEGACY_ACCESS_TOKEN_KEY)
  localStorage.removeItem(LEGACY_REFRESH_TOKEN_KEY)
  localStorage.removeItem(LS_USER)

  try {
    const keysToRemove: string[] = []
    for (let i = 0; i < localStorage.length; i += 1) {
      const key = localStorage.key(i)
      if (key?.startsWith('xxlink:')) keysToRemove.push(key)
    }
    keysToRemove.forEach((key) => localStorage.removeItem(key))
  } catch {
    // localStorage unavailable
  }
}

type Listener = () => void

class AuthStoreSingleton {
  private state: AuthState = loadFromStorage()
  private listeners: Set<Listener> = new Set()

  getState(): AuthState {
    return this.state
  }

  setAuthenticatedUser(user: AuthUser): void {
    const previousUserId = this.state.user?.id
    if (previousUserId && previousUserId !== user.id) {
      clearAccountLkgCache(previousUserId)
    }
    saveUser(user)
    this.state = toState(user, 'operational')
    this.notify()
  }

  setSessionStatus(sessionStatus: SecureSessionStatus): void {
    this.state = toState(this.state.user, sessionStatus)
    this.notify()
  }

  preserveCachedShell(user: AuthUser | null = this.state.user): void {
    if (user) saveUser(user)
    this.state = toState(user, user ? 'recovery_required' : 'signed_out')
    this.notify()
  }

  clearAuth(): void {
    clearAccountLkgCache(this.state.user?.id)
    clearStorage()
    this.state = toState(null, 'signed_out')
    this.notify()
  }

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  private notify(): void {
    this.listeners.forEach((listener) => listener())
  }
}

export const authStore = new AuthStoreSingleton()

const AuthContext = createContext<AuthState | null>(null)

export function AuthProvider({ children }: { children: ReactNode }): ReactNode {
  const [state, setState] = useState<AuthState>(() => authStore.getState())

  useEffect(() => authStore.subscribe(() => setState(authStore.getState())), [])

  return createElement(AuthContext.Provider, { value: state }, children)
}

export function useAuth(): AuthState {
  const context = use(AuthContext)
  if (!context) throw new Error('useAuth must be used inside <AuthProvider>')
  return context
}
