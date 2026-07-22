import { invoke } from '@tauri-apps/api/core'

import { apiLogin, apiLogout, type AuthTokens, type AuthUser } from './auth'
import { authStore } from './auth-store'

type VaultSecret = AuthTokens & { version: number; subjectId: string }
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

function toVaultError(error: unknown): SecureSessionUnavailableError {
  const kind =
    typeof error === 'string' &&
    [
      'unavailable',
      'corrupted',
      'write_failed',
      'read_failed',
      'delete_failed',
    ].includes(error)
      ? (error as SecureSessionUnavailableError['kind'])
      : 'unavailable'
  return new SecureSessionUnavailableError(kind)
}

function isValidSecret(value: VaultSecret | null): value is VaultSecret {
  return Boolean(
    value &&
    value.version === 1 &&
    typeof value.subjectId === 'string' &&
    value.subjectId.length > 0 &&
    typeof value.accessToken === 'string' &&
    value.accessToken.length > 0 &&
    typeof value.refreshToken === 'string' &&
    value.refreshToken.length > 0,
  )
}

function readLegacySession(): AuthTokens | null {
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
    // A later startup can retry cleanup after the secure vault is confirmed.
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

async function readVault(): Promise<VaultSecret | null> {
  try {
    const value = await withVaultTimeout(
      invoke<VaultSecret | null>('secure_session_read'),
    )
    if (value === null) return null
    if (!isValidSecret(value))
      throw new SecureSessionUnavailableError('corrupted')
    return value
  } catch (error) {
    if (error instanceof SecureSessionUnavailableError) throw error
    throw toVaultError(error)
  }
}

async function writeAndVerify(
  tokens: AuthTokens,
  subjectId: string,
): Promise<void> {
  try {
    await withVaultTimeout(
      invoke('secure_session_write', {
        subjectId,
        accessToken: tokens.accessToken,
        refreshToken: tokens.refreshToken,
      }),
    )
    const confirmed = await readVault()
    if (
      !confirmed ||
      confirmed.subjectId !== subjectId ||
      confirmed.accessToken !== tokens.accessToken ||
      confirmed.refreshToken !== tokens.refreshToken
    ) {
      throw new SecureSessionUnavailableError('read_failed')
    }
  } catch (error) {
    if (error instanceof SecureSessionUnavailableError) throw error
    throw toVaultError(error)
  }
}

export async function initializeSecureSession(): Promise<void> {
  const { user } = authStore.getState()
  if (!user) {
    authStore.setSessionStatus('signed_out')
    return
  }

  try {
    const stored = await readVault()
    if (stored) {
      if (stored.subjectId !== user.id) {
        authStore.preserveCachedShell()
        return
      }
      clearLegacySession()
      authStore.setSessionStatus('operational')
      return
    }

    const legacy = readLegacySession()
    if (!legacy) {
      authStore.preserveCachedShell()
      return
    }

    await writeAndVerify(legacy, user.id)
    clearLegacySession()
    authStore.setSessionStatus('operational')
  } catch {
    // Preserve legacy credentials for a later retry, but never return them to
    // React or use the legacy transport after migration has failed.
    authStore.preserveCachedShell()
  }
}

export async function requireSecureSession(): Promise<AuthTokens> {
  if (authStore.getState().sessionStatus !== 'operational') {
    throw new SecureSessionUnavailableError()
  }
  try {
    const secret = await readVault()
    const userId = authStore.getState().user?.id
    if (!secret || !userId || secret.subjectId !== userId) {
      authStore.preserveCachedShell()
      throw new SecureSessionUnavailableError('read_failed')
    }
    return {
      accessToken: secret.accessToken,
      refreshToken: secret.refreshToken,
    }
  } catch (error) {
    authStore.preserveCachedShell()
    if (error instanceof SecureSessionUnavailableError) throw error
    throw toVaultError(error)
  }
}

export async function replaceSecureSession(tokens: AuthTokens): Promise<void> {
  const subjectId = authStore.getState().user?.id
  if (!subjectId) throw new SecureSessionUnavailableError('write_failed')
  try {
    await writeAndVerify(tokens, subjectId)
    authStore.setSessionStatus('operational')
  } catch (error) {
    authStore.preserveCachedShell()
    throw error
  }
}

export async function signInWithSecureSession(
  email: string,
  password: string,
): Promise<AuthUser> {
  const result = await apiLogin(email, password)
  try {
    await writeAndVerify(result, result.user.id)
    clearLegacySession()
    authStore.setAuthenticatedUser(result.user)
  } catch (error) {
    authStore.preserveCachedShell(result.user)
    throw error
  }
  return result.user
}

export async function manualLogout(): Promise<void> {
  try {
    const secret = await readVault()
    if (secret) await apiLogout(secret.refreshToken)
  } catch {
    // Explicit local logout must still complete when the server or vault fails.
  }

  await withVaultTimeout(invoke('secure_session_delete'))
  authStore.clearAuth()
}
