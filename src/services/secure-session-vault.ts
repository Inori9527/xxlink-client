import { invoke } from '@tauri-apps/api/core'

import { AuthError } from './auth'
import { authStore, type AuthUser } from './auth-store'

type SessionProbe = 'operational' | 'missing' | 'subject_mismatch'
const VAULT_OPERATION_TIMEOUT_MS = 5_000
const LEGACY_ACCESS_TOKEN_KEY = 'xxlink_access_token'
const LEGACY_REFRESH_TOKEN_KEY = 'xxlink_refresh_token'

export class SecureSessionUnavailableError extends Error {
  constructor(
    public readonly kind:
      | 'unavailable'
      | 'corrupted'
      | 'write_failed'
      | 'read_failed'
      | 'delete_failed' = 'unavailable',
  ) {
    super('Secure session is unavailable')
    this.name = 'SecureSessionUnavailableError'
  }
}

function readLegacySession(): {
  accessToken: string
  refreshToken: string
} | null {
  try {
    const accessToken = localStorage.getItem(LEGACY_ACCESS_TOKEN_KEY)
    const refreshToken = localStorage.getItem(LEGACY_REFRESH_TOKEN_KEY)
    return accessToken && refreshToken ? { accessToken, refreshToken } : null
  } catch {
    return null
  }
}

function clearLegacySession(): void {
  try {
    localStorage.removeItem(LEGACY_ACCESS_TOKEN_KEY)
    localStorage.removeItem(LEGACY_REFRESH_TOKEN_KEY)
  } catch {
    // A later startup can retry cleanup after migration is confirmed.
  }
}

async function withVaultTimeout<T>(operation: Promise<T>): Promise<T> {
  let timeoutId: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<never>((_, reject) => {
    timeoutId = setTimeout(
      () => reject(new SecureSessionUnavailableError('unavailable')),
      VAULT_OPERATION_TIMEOUT_MS,
    )
  })
  try {
    return await Promise.race([operation, timeout])
  } finally {
    if (timeoutId !== undefined) clearTimeout(timeoutId)
  }
}

function toLoginError(error: unknown): Error {
  if (error === 'auth') return new AuthError('Authentication failed', 401)
  if (error === 'network') {
    const networkError = new Error('Network request failed')
    networkError.name = 'NetworkError'
    return networkError
  }
  return new Error('Authentication service unavailable')
}

async function probeSession(subjectId: string): Promise<SessionProbe> {
  return withVaultTimeout(
    invoke<SessionProbe>('secure_session_probe', { subjectId }),
  )
}

export async function initializeSecureSession(): Promise<void> {
  try {
    const recovery = await withVaultTimeout(
      invoke<{ pending: boolean; cleaned: boolean }>(
        'secure_session_recover_pending_logout',
      ),
    )
    if (recovery.pending) {
      authStore.clearAuth()
      return
    }
  } catch {
    // A later startup can retry; no credential is returned to the renderer.
    authStore.preserveCachedShell()
    return
  }

  const { user } = authStore.getState()
  if (!user) {
    authStore.setSessionStatus('signed_out')
    return
  }

  try {
    const status = await probeSession(user.id)
    if (status === 'operational') {
      clearLegacySession()
      authStore.setSessionStatus('operational')
      return
    }
    if (status === 'subject_mismatch') {
      authStore.preserveCachedShell()
      return
    }

    const legacy = readLegacySession()
    if (!legacy) {
      authStore.preserveCachedShell()
      return
    }
    await withVaultTimeout(
      invoke('secure_session_migrate_legacy', {
        subjectId: user.id,
        accessToken: legacy.accessToken,
        refreshToken: legacy.refreshToken,
      }),
    )
    if ((await probeSession(user.id)) !== 'operational') {
      throw new SecureSessionUnavailableError('read_failed')
    }
    clearLegacySession()
    authStore.setSessionStatus('operational')
  } catch {
    // Preserve the cached account shell and retry migration on a later startup.
    authStore.preserveCachedShell()
  }
}

export async function signInWithSecureSession(
  email: string,
  password: string,
): Promise<AuthUser> {
  try {
    const user = await invoke<AuthUser>('secure_session_login', {
      email,
      password,
    })
    clearLegacySession()
    authStore.setAuthenticatedUser(user)
    return user
  } catch (error) {
    authStore.preserveCachedShell()
    throw toLoginError(error)
  }
}

export async function manualLogout(): Promise<boolean> {
  const cleanup = invoke('secure_session_logout')
  authStore.clearAuth()
  try {
    await cleanup
    return true
  } catch {
    return false
  }
}
