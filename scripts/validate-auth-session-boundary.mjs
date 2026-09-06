import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

// PROVES:         Part executed, part source text, and the executed half is a
//                 DUPLICATE rather than shipped code: the file defines its own
//                 isServiceAccessBlockedResponse and runs it against inline
//                 expectations, so changing only that copy fails the guard while
//                 every scanned production file is unchanged. The rest is source
//                 text.
// DOES NOT PROVE: That any shipped auth code behaves as claimed.

const AUTH_FATAL_CODES = new Set([
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

const REFRESH_TERMINAL_CODES = new Set(AUTH_FATAL_CODES)
const IDENTITY_NOT_FOUND_CODES = new Set([
  'ACCOUNT_NOT_FOUND',
  'USER_NOT_FOUND',
])

function isServiceAccessBlockedResponse({ status, code, path }) {
  if (code && AUTH_FATAL_CODES.has(code)) return true
  if (code && REFRESH_TERMINAL_CODES.has(code)) return true
  if (path === '/auth/refresh') return status === 401 && !code
  if (
    path?.startsWith('/user/') &&
    status === 404 &&
    code &&
    IDENTITY_NOT_FOUND_CODES.has(code)
  ) {
    return true
  }
  return false
}

function isLocalLogoutResponse() {
  return false
}

const cases = [
  {
    name: 'plain protected-api 401 is not itself a logout decision',
    input: { status: 401, code: 'UNAUTHORIZED', path: '/user/profile' },
    serviceBlocked: false,
  },
  {
    name: 'refresh session revoked blocks service without local logout',
    input: { status: 401, code: 'SESSION_REVOKED', path: '/auth/refresh' },
    serviceBlocked: true,
  },
  {
    name: 'refresh token revoked blocks service without local logout',
    input: { status: 401, code: 'TOKEN_REVOKED', path: '/auth/refresh' },
    serviceBlocked: true,
  },
  {
    name: 'invalid refresh token blocks service without local logout',
    input: {
      status: 401,
      code: 'INVALID_REFRESH_TOKEN',
      path: '/auth/refresh',
    },
    serviceBlocked: true,
  },
  {
    name: 'blocked account from middleware blocks service without local logout',
    input: { status: 403, code: 'ACCOUNT_BLOCKED', path: '/nodes' },
    serviceBlocked: true,
  },
  {
    name: 'missing current user from identity endpoint blocks service without local logout',
    input: { status: 404, code: 'USER_NOT_FOUND', path: '/user/profile' },
    serviceBlocked: true,
  },
  {
    name: 'business subscription failure must not clear login state',
    input: { status: 403, code: 'NO_ACTIVE_SUB', path: '/traffic/report' },
    serviceBlocked: false,
  },
]

for (const testCase of cases) {
  assert.equal(
    isServiceAccessBlockedResponse(testCase.input),
    testCase.serviceBlocked,
    `${testCase.name}: service-blocked classification`,
  )
  assert.equal(
    isLocalLogoutResponse(testCase.input),
    false,
    `${testCase.name}: automatic local logout must never be allowed`,
  )
}

const readSource = (path) =>
  readFileSync(new URL(`../${path}`, import.meta.url), 'utf8')

const boundarySource = readSource('src/services/auth-session-boundary.ts')
assert.match(
  boundarySource,
  /export function isLocalLogoutResponse\([\s\S]*?return false/,
  'automatic responses must not be classified as local logout',
)
assert.match(
  boundarySource,
  /isAuthFatalCode\(code\)/,
  'v2.4.12 auth fatal codes should block service only',
)

const apiSource = readSource('src/services/api.ts')
assert.equal(
  apiSource.includes('expireSession('),
  false,
  'api request helper must not expire/clear local auth state',
)
assert.equal(
  apiSource.includes('clearAuth('),
  false,
  'api request helper must not clear local auth state',
)
assert.doesNotMatch(
  apiSource,
  /getServiceBlockedMessage\(code\?: string, message\?: string\)/,
  'account-state mapping must not accept raw backend messages',
)
assert.doesNotMatch(
  apiSource,
  /handleAuthFatal\([\s\S]{0,180}?error\.message/,
  'refresh failures must not forward raw exception messages',
)

const sessionSource = readSource('src/services/session.ts')
assert.equal(
  sessionSource.includes('authStore.clearAuth('),
  false,
  'session warning helper must not clear local auth state',
)

const resumeRecoverySource = readSource('src/services/resume-recovery.ts')
assert.equal(
  resumeRecoverySource.includes('if (!isAuthFatalError(error))'),
  false,
  'resume recovery must not hide service/account rejection warnings',
)

const mineSource = readSource('src/pages/mine.tsx')
assert.equal(
  mineSource.includes('clearAuth()'),
  false,
  'React pages must not directly clear local auth state',
)
assert.match(
  mineSource,
  /await manualLogout\(\)/,
  'Mine should delegate explicit logout to the trusted session controller',
)
const secureSessionSource = readSource('src/services/secure-session-vault.ts')
assert.match(
  secureSessionSource,
  /export async function manualLogout\([\s\S]*?authStore\.clearAuth\(\)/,
  'manual logout controller should clear local auth state',
)

console.log(`auth session boundary cases passed: ${cases.length}`)
console.log('auth session boundary source checks passed')
