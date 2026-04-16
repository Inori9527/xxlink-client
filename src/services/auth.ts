/**
 * Auth service — all API calls go through @tauri-apps/plugin-http fetch
 * to avoid WebView cross-origin restrictions.
 */
import { fetch } from '@tauri-apps/plugin-http'

import { BASE_URL } from '@/services/config'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

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
  error?: string
}

export class AuthError extends Error {
  constructor(
    message: string,
    public readonly status?: number,
  ) {
    super(message)
    this.name = 'AuthError'
  }
}

// ---------------------------------------------------------------------------
// Internal helper
// ---------------------------------------------------------------------------

async function post<T>(path: string, body: unknown): Promise<T> {
  const url = `${BASE_URL}${path}`

  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })

  let json: ApiResponse<T>
  try {
    json = (await res.json()) as ApiResponse<T>
  } catch {
    throw new AuthError(`服务器返回了非 JSON 响应 (${res.status})`, res.status)
  }

  if (!res.ok || !json.success) {
    throw new AuthError(json.error ?? '请求失败', res.status)
  }

  if (json.data === undefined) {
    throw new AuthError('响应数据为空', res.status)
  }

  return json.data
}

// ---------------------------------------------------------------------------
// Auth API calls
// ---------------------------------------------------------------------------

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
