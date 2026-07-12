import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import test from 'node:test'
import vm from 'node:vm'

import ts from 'typescript'

const repoRoot = resolve(import.meta.dirname, '..')

class ApiError extends Error {
  constructor(message, status, code) {
    super(message)
    this.name = 'ApiError'
    this.status = status
    this.code = code
  }
}

function loadSafeClientErrorModule(consoleImpl = console) {
  const sourcePath = resolve(repoRoot, 'src/services/safe-client-error.ts')
  const source = readFileSync(sourcePath, 'utf8')
  const { outputText } = ts.transpileModule(source, {
    compilerOptions: {
      esModuleInterop: true,
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
    },
    fileName: sourcePath,
  })
  const module = { exports: {} }

  vm.runInNewContext(outputText, {
    console: consoleImpl,
    exports: module.exports,
    module,
    require: (specifier) => {
      if (specifier === '@/services/api') return { ApiError }
      throw new Error(`Unexpected runtime import in focused test: ${specifier}`)
    },
  })

  return module.exports
}

function asPlainValue(value) {
  return JSON.parse(JSON.stringify(value))
}

test('classifies ApiError status and transport code-like shapes without exposing details', () => {
  const { classifyClientError } = loadSafeClientErrorModule()

  assert.deepEqual(
    asPlainValue(
      classifyClientError(
        new ApiError('account fixture', 401, 'AUTH_REQUIRED'),
      ),
    ),
    { kind: 'auth', retryable: false },
  )
  assert.deepEqual(
    asPlainValue(
      classifyClientError(
        new ApiError('account fixture', 403, 'ACCESS_DENIED'),
      ),
    ),
    { kind: 'auth', retryable: false },
  )
  assert.deepEqual(
    asPlainValue(
      classifyClientError(new ApiError('busy fixture', 429, 'RATE_LIMITED')),
    ),
    { kind: 'service', retryable: true },
  )
  assert.deepEqual(
    asPlainValue(
      classifyClientError(new ApiError('server fixture', 503, 'UPSTREAM_BUSY')),
    ),
    { kind: 'service', retryable: true },
  )
  assert.deepEqual(
    asPlainValue(
      classifyClientError(
        new ApiError('invalid fixture', 400, 'INVALID_PROMO'),
      ),
    ),
    { kind: 'service', retryable: false },
  )
  assert.deepEqual(asPlainValue(classifyClientError({ name: 'AbortError' })), {
    kind: 'network',
    retryable: true,
  })
  assert.deepEqual(asPlainValue(classifyClientError({ code: 'ETIMEDOUT' })), {
    kind: 'network',
    retryable: true,
  })
  assert.deepEqual(asPlainValue(classifyClientError(new Error('fixture'))), {
    kind: 'unknown',
    retryable: false,
  })
})

test('safe messages and reports contain only localized copy and classification', () => {
  const calls = []
  const consoleImpl = {
    warn: (...args) => calls.push(args),
  }
  const { reportSafeClientFailure, toSafeClientErrorMessage } =
    loadSafeClientErrorModule(consoleImpl)
  const translatedKeys = []
  const translate = (key) => {
    translatedKeys.push(key)
    return `translated:${key}`
  }

  assert.equal(
    toSafeClientErrorMessage('network', translate),
    'translated:shared.feedback.errors.safeClient.network',
  )
  assert.equal(
    toSafeClientErrorMessage('auth', translate),
    'translated:shared.feedback.errors.safeClient.auth',
  )
  assert.equal(
    toSafeClientErrorMessage('service', translate),
    'translated:shared.feedback.errors.safeClient.service',
  )
  assert.equal(
    toSafeClientErrorMessage('unknown', translate),
    'translated:shared.feedback.errors.safeClient.unknown',
  )
  assert.deepEqual(translatedKeys, [
    'shared.feedback.errors.safeClient.network',
    'shared.feedback.errors.safeClient.auth',
    'shared.feedback.errors.safeClient.service',
    'shared.feedback.errors.safeClient.unknown',
  ])

  const rawFixture =
    'https://example.invalid/subscription/[REDACTED_TEST_TOKEN]?token=[REDACTED_TEST_TOKEN]'
  reportSafeClientFailure('promo-redeem', new Error(rawFixture))

  assert.equal(calls.length, 1)
  assert.equal(calls[0].length, 1)
  assert.deepEqual(Object.keys(calls[0][0]).sort(), [
    'kind',
    'retryable',
    'scope',
  ])
  assert.deepEqual(asPlainValue(calls[0][0]), {
    scope: 'promo-redeem',
    kind: 'unknown',
    retryable: false,
  })
  assert.equal(JSON.stringify(calls[0]).includes(rawFixture), false)
})

test('subscription and promo paths do not send caught errors to console or notices', () => {
  const sourcePaths = [
    'src/services/subscription-sync.ts',
    'src/services/subscription-auto-sync.ts',
    'src/pages/promo-code.tsx',
  ]
  const sources = sourcePaths.map((relativePath) => [
    relativePath,
    readFileSync(resolve(repoRoot, relativePath), 'utf8'),
  ])

  for (const [relativePath, source] of sources) {
    assert.match(source, /reportSafeClientFailure/)
    assert.doesNotMatch(
      source,
      /console\.(?:warn|error)\s*\([^)]*\b(?:err|error|syncError|redeemError)\b/,
    )
    assert.doesNotMatch(
      source,
      /showNotice\.(?:error|info|success)\s*\([^)]*\b(?:err|error|syncError|redeemError)\b/,
    )
    assert.doesNotMatch(
      source,
      /\b(?:err|error|syncError|redeemError)\.message/,
    )
    assert.equal(
      source.includes('catch(console.error)'),
      false,
      `${relativePath} retains a raw fire-and-forget error logger`,
    )
  }
})

test('deep-link scheme keeps its existing redaction and masking guards', () => {
  const source = readFileSync(
    resolve(repoRoot, 'src-tauri/src/utils/resolve/scheme.rs'),
    'utf8',
  )

  assert.match(source, /redacted_deep_link_for_log/)
  assert.match(source, /redacted_deep_link_url_summary/)
  assert.match(source, /redacted_subscription_path/)
  assert.match(source, /\[query-redacted\]/)
  assert.match(source, /help::mask_err/)
})
