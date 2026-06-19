export const AUTH_FATAL_CODES = new Set([
  'ACCOUNT_DISABLED',
  'ACCOUNT_NOT_FOUND',
  'ACCOUNT_BLOCKED',
  'ACCOUNT_SUSPENDED',
  'INVALID_REFRESH_TOKEN',
  'REFRESH_TOKEN_INVALID',
  'SESSION_REVOKED',
  'SESSION_EXPIRED',
  'TOKEN_REVOKED',
  'USER_DELETED',
  'USER_DISABLED',
  'USER_NOT_FOUND',
])

export const REFRESH_TERMINAL_CODES = new Set([
  'ACCOUNT_DISABLED',
  'ACCOUNT_NOT_FOUND',
  'ACCOUNT_BLOCKED',
  'ACCOUNT_SUSPENDED',
  'INVALID_REFRESH_TOKEN',
  'REFRESH_TOKEN_INVALID',
  'SESSION_REVOKED',
  'SESSION_EXPIRED',
  'TOKEN_REVOKED',
  'USER_DELETED',
  'USER_DISABLED',
  'USER_NOT_FOUND',
])

export function isAuthFatalCode(code?: string): boolean {
  return Boolean(code && AUTH_FATAL_CODES.has(code))
}

export function isRefreshTerminalCode(code?: string): boolean {
  return Boolean(code && REFRESH_TERMINAL_CODES.has(code))
}
