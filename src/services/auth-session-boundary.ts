import { isAuthFatalCode, isRefreshTerminalCode } from './auth-errors'

export interface AuthBoundaryResponseInput {
  status: number
  code?: string
  path?: string
}

const IDENTITY_NOT_FOUND_CODES = new Set([
  'ACCOUNT_NOT_FOUND',
  'USER_NOT_FOUND',
])

const isRefreshPath = (path?: string): boolean => path === '/auth/refresh'

const isIdentityPath = (path?: string): boolean =>
  path?.startsWith('/user/') === true

export function isServiceAccessBlockedResponse({
  status,
  code,
  path,
}: AuthBoundaryResponseInput): boolean {
  if (isAuthFatalCode(code)) return true
  if (isRefreshTerminalCode(code)) return true

  if (isRefreshPath(path)) {
    return status === 401 && !code
  }

  if (
    isIdentityPath(path) &&
    status === 404 &&
    code &&
    IDENTITY_NOT_FOUND_CODES.has(code)
  ) {
    return true
  }

  return false
}

export function isLocalLogoutResponse(
  _input: AuthBoundaryResponseInput,
): boolean {
  return false
}
