/**
 * Auth service. All API calls go through @tauri-apps/plugin-http so the
 * Tauri WebView is not blocked by browser CORS rules.
 */
import { BASE_URL } from '@/services/config'
import {
  DEFAULT_AUTH_TIMEOUT_MS,
  DEFAULT_REFRESH_TIMEOUT_MS,
  fetchWithTimeout,
} from '@/services/http'

export interface AuthUser {
  id: string
  email: string
  role: 'USER' | 'ADMIN'
}

export interface AuthTokens {
  accessToken: string
  refreshToken: string
}

export interface LoginResult extends AuthTokens {
  user: AuthUser
}

export interface ApiResponse<T> {
  success: boolean
  data?: T
  error?: string | { message?: string; code?: string }
}

export class AuthError extends Error {
  constructor(
    message: string,
    public readonly status?: number,
    public readonly code?: string,
  ) {
    super(message)
    this.name = 'AuthError'
  }
}

const getEnvelopeError = (error: ApiResponse<unknown>['error']) => {
  if (typeof error === 'string') {
    return { message: error, code: undefined }
  }
  return { message: error?.message || 'Request failed', code: error?.code }
}

async function post<T>(path: string, body: unknown): Promise<T> {
  const res = await fetchWithTimeout(
    `${BASE_URL}${path}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    },
    path === '/auth/refresh' ? DEFAULT_REFRESH_TIMEOUT_MS : DEFAULT_AUTH_TIMEOUT_MS,
  )

  let json: ApiResponse<T>
  try {
    json = (await res.json()) as ApiResponse<T>
  } catch {
    throw new AuthError(`Server returned non-JSON response (${res.status})`, res.status)
  }

  if (!res.ok || !json.success) {
    const { message, code } = getEnvelopeError(json.error)
    throw new AuthError(message, res.status, code)
  }

  if (json.data === undefined) {
    throw new AuthError('Server response missing data', res.status)
  }

  return json.data
}

export async function apiLogin(
  email: string,
  password: string,
): Promise<LoginResult> {
  return post<LoginResult>('/auth/login', { email, password })
}

export async function apiRegister(
  email: string,
  password: string,
): Promise<{ id: string; email: string }> {
  return post<{ id: string; email: string }>('/auth/register', {
    email,
    password,
  })
}

export async function apiLogout(refreshToken: string): Promise<void> {
  await post<unknown>('/auth/logout', { refreshToken })
}

export async function apiRefreshToken(
  refreshToken: string,
): Promise<AuthTokens> {
  return post<AuthTokens>('/auth/refresh', { refreshToken })
}

export async function apiGoogleOAuthCallback(
  code: string,
  redirectUri: string,
): Promise<LoginResult> {
  return post<LoginResult>('/auth/oauth/google', { code, redirectUri })
}
