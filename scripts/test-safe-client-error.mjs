import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
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

const HOSTILE_ERROR_FRAGMENTS = [
  'https://api.example.invalid/subscription/profile?token=query-token-fixture',
  'Authorization: Bearer bearer-token-fixture',
  '11111111-2222-4333-8444-555555555555',
  'http://proxy-user:proxy-password@127.0.0.1:7890',
  'proxies:\n  - name: private-profile\n    password: profile-password-fixture',
]

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
  assert.deepEqual(
    asPlainValue(classifyClientError({ code: 'NETWORK_TIMEOUT' })),
    {
      kind: 'network',
      retryable: true,
    },
  )
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

test('safe failure records exclude hostile client material from logs, copies, and persistence payloads', () => {
  const calls = []
  const consoleImpl = {
    warn: (...args) => calls.push(args),
  }
  const { reportSafeClientFailure, toSafeClientFailureRecord } =
    loadSafeClientErrorModule(consoleImpl)

  for (const fragment of HOSTILE_ERROR_FRAGMENTS) {
    const hostileError = Object.assign(new Error(fragment), {
      code: fragment,
      config: { headers: { Authorization: fragment } },
      response: { data: fragment },
    })
    const record = toSafeClientFailureRecord('startup-recovery', hostileError)

    assert.deepEqual(Object.keys(record).sort(), ['kind', 'retryable', 'scope'])
    assert.deepEqual(asPlainValue(record), {
      scope: 'startup-recovery',
      kind: 'unknown',
      retryable: false,
    })
    assert.equal(JSON.stringify(record).includes(fragment), false)

    reportSafeClientFailure('startup-recovery', hostileError)
  }

  assert.equal(calls.length, HOSTILE_ERROR_FRAGMENTS.length)
  const serializedCalls = JSON.stringify(calls)
  for (const fragment of HOSTILE_ERROR_FRAGMENTS) {
    assert.equal(serializedCalls.includes(fragment), false)
  }

  assert.equal(
    toSafeClientFailureRecord(HOSTILE_ERROR_FRAGMENTS[0], new Error('x')).scope,
    'client-failure',
    'dynamic or sensitive scope values must collapse to a stable fallback',
  )
})

test('reachable safety-tail sinks never display, persist, copy, or log raw errors', () => {
  const paths = [
    'src/pages/login.tsx',
    'src/pages/register.tsx',
    'src/services/resume-recovery.ts',
    'src/main.tsx',
    'src/components/base/base-error-boundary.tsx',
    'src/components/shared/traffic-error-boundary.tsx',
    'src/components/setting/mods/update-viewer.tsx',
    'src/components/setting/mods/tun-viewer.tsx',
    'src/providers/app-data-provider.tsx',
  ]

  for (const relativePath of paths) {
    const source = readFileSync(resolve(repoRoot, relativePath), 'utf8')
    assert.match(
      source,
      /safe-client-error/,
      `${relativePath} must use the shared client error boundary`,
    )
    assert.doesNotMatch(
      source,
      /\b(?:err|error|fallbackError|syncError|timeoutError)\.(?:message|stack)\b/,
      `${relativePath} reads raw error text`,
    )
    assert.doesNotMatch(
      source,
      /\bString\s*\(\s*(?:err|error|fallbackError|syncError|timeoutError)\s*\)/,
      `${relativePath} stringifies a raw error`,
    )
    assert.doesNotMatch(
      source,
      /showNotice\.error\s*\(\s*(?:err|error|fallbackError|syncError|timeoutError)\s*\)/,
      `${relativePath} displays a raw error notice`,
    )
    assert.equal(
      source.includes('catch(console.error)'),
      false,
      `${relativePath} retains a raw fire-and-forget logger`,
    )
  }

  const loginSource = readFileSync(resolve(repoRoot, paths[0]), 'utf8')
  assert.match(loginSource, /toSafeClientErrorMessage/)
  assert.doesNotMatch(loginSource, /return\s+message\s*\n/)
  assert.match(
    loginSource,
    /syncSubscription\(\{ force: true, timeoutMs: 10_000 \}\)/,
  )

  const registerSource = readFileSync(resolve(repoRoot, paths[1]), 'utf8')
  assert.match(registerSource, /toSafeClientErrorMessage/)
  assert.match(registerSource, /apiRegister\(email, password\)/)

  const resumeSource = readFileSync(resolve(repoRoot, paths[2]), 'utf8')
  assert.match(resumeSource, /toSafeClientFailureRecord/)
  assert.doesNotMatch(resumeSource, /message:\s*(?:error|String\()/)
  assert.match(resumeSource, /lastFailureAt = Date\.now\(\)/)
  assert.doesNotMatch(resumeSource, /clearAuth\(/)

  const mainSource = readFileSync(resolve(repoRoot, paths[3]), 'utf8')
  assert.match(mainSource, /toSafeClientFailureRecord/)
  assert.doesNotMatch(mainSource, /navigator\.userAgent|window\.location\.href/)
  assert.match(mainSource, /navigator\.clipboard[\s\S]*?writeText/)
  assert.match(mainSource, /window\.location\.reload\(\)/)

  const baseBoundarySource = readFileSync(resolve(repoRoot, paths[4]), 'utf8')
  assert.match(baseBoundarySource, /toSafeClientErrorMessage/)
  assert.match(
    baseBoundarySource,
    /navigator\.clipboard[\s\S]{0,40}?\.writeText/,
  )
  assert.match(baseBoundarySource, /window\.location\.reload\(\)/)

  const trafficBoundarySource = readFileSync(
    resolve(repoRoot, paths[5]),
    'utf8',
  )
  assert.match(trafficBoundarySource, /toSafeClientErrorMessage/)
  assert.doesNotMatch(
    trafficBoundarySource,
    /navigator\.userAgent|window\.location\.href|\{error\?\.stack\}|\{errorInfo\.componentStack\}/,
  )
  assert.match(trafficBoundarySource, /this\.retryCount\+\+/)
  assert.match(
    trafficBoundarySource,
    /this\.props\.onError\(error, errorInfo\)/,
  )

  for (const relativePath of paths.slice(6, 8)) {
    const source = readFileSync(resolve(repoRoot, relativePath), 'utf8')
    assert.match(source, /toSafeClientErrorMessage/)
    assert.match(source, /showNotice\.error/)
  }

  const providerSource = readFileSync(resolve(repoRoot, paths[8]), 'utf8')
  assert.match(providerSource, /reportSafeClientFailure/)
  assert.doesNotMatch(
    providerSource,
    /console\.(?:warn|error)\s*\([\s\S]{0,160}?\b(?:err|error|errors)\b/,
  )
})

test('subscription and active promo paths do not send caught errors to console or notices', () => {
  const sourcePaths = [
    'src/services/subscription-sync.ts',
    'src/services/subscription-auto-sync.ts',
    'src/components/mine/promo-redeem-panel.tsx',
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

  const promoPanelSource = readFileSync(
    resolve(repoRoot, 'src/components/mine/promo-redeem-panel.tsx'),
    'utf8',
  )
  assert.match(promoPanelSource, /reportSafeClientFailure/)
  assert.match(promoPanelSource, /toSafeClientErrorMessage/)
  assert.equal(
    existsSync(resolve(repoRoot, 'src/pages/promo-code.tsx')),
    false,
    'retired promo page must not be reintroduced',
  )
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
