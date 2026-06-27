import assert from 'node:assert/strict'
import fs from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'
import test from 'node:test'
import vm from 'node:vm'

import ts from 'typescript'

const repoRoot = path.resolve(import.meta.dirname, '..')
const require = createRequire(import.meta.url)

function loadTsModule(relativePath, extraContext = {}) {
  const sourcePath = path.join(repoRoot, relativePath)
  const source = fs.readFileSync(sourcePath, 'utf8')
  const { outputText } = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
      esModuleInterop: true,
    },
    fileName: sourcePath,
  })
  const module = { exports: {} }
  vm.runInNewContext(outputText, {
    AbortController,
    clearTimeout,
    exports: module.exports,
    module,
    require,
    setTimeout,
    ...extraContext,
  })
  return module.exports
}

test('auth refresh transport sends only the body token and omits credentials', () => {
  const { createRefreshRequestInit } = loadTsModule(
    'src/services/auth-refresh-transport.ts',
  )

  const init = createRefreshRequestInit('redacted-refresh-token')

  assert.equal(init.method, 'POST')
  assert.equal(init.credentials, 'omit')
  assert.equal(
    JSON.stringify(init.headers),
    JSON.stringify({ 'Content-Type': 'application/json' }),
  )
  assert.equal(JSON.parse(init.body).refreshToken, 'redacted-refresh-token')
  assert.equal(
    JSON.stringify(init.headers).toLowerCase().includes('cookie'),
    false,
  )
})

test('auth refresh transport executes through browser fetch without cookies', async () => {
  let observed = null
  const { fetchRefreshWithBodyToken } = loadTsModule(
    'src/services/auth-refresh-transport.ts',
    {
      fetch: async (url, init) => {
        observed = { url, init }
        return { ok: true, status: 200 }
      },
    },
  )

  await fetchRefreshWithBodyToken(
    'https://api.xxlink.net/api/v1/auth/refresh',
    'redacted-refresh-token',
    5000,
  )

  assert.equal(observed.url, 'https://api.xxlink.net/api/v1/auth/refresh')
  assert.equal(observed.init.credentials, 'omit')
  assert.equal(observed.init.cache, 'no-store')
  assert.equal(observed.init.headers.Cookie, undefined)
  assert.equal(
    JSON.parse(observed.init.body).refreshToken,
    'redacted-refresh-token',
  )
})

test('auth refresh transport classifies cookie csrf as a transport/session error', () => {
  const { isRefreshTransportSessionError } = loadTsModule(
    'src/services/auth-refresh-transport.ts',
  )

  assert.equal(
    isRefreshTransportSessionError({
      status: 403,
      code: 'CSRF_ORIGIN_FORBIDDEN',
    }),
    true,
  )
  assert.equal(
    isRefreshTransportSessionError({
      status: 401,
      code: 'INVALID_REFRESH_TOKEN',
    }),
    false,
  )
})

test('apiRefreshToken bypasses plugin fetch for body-only refresh transport', () => {
  const authSource = fs.readFileSync(
    path.join(repoRoot, 'src/services/auth.ts'),
    'utf8',
  )

  assert.match(authSource, /fetchRefreshWithBodyToken\(/)
  assert.doesNotMatch(
    authSource,
    /post<AuthTokens>\('\/auth\/refresh',\s*\{\s*refreshToken\s*\}\)/,
  )
  assert.doesNotMatch(
    authSource,
    /fetchWithTimeout\(\s*`\$\{BASE_URL\}\/auth\/refresh`/,
  )
})

test('api auto-refresh maps backend cookie csrf to auth refresh transport code', () => {
  const apiSource = fs.readFileSync(
    path.join(repoRoot, 'src/services/api.ts'),
    'utf8',
  )

  assert.match(apiSource, /isRefreshTransportSessionError\(error\)/)
  assert.match(apiSource, /AUTH_REFRESH_TRANSPORT_FORBIDDEN_CODE/)
})
