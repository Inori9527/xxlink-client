import assert from 'node:assert/strict'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
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

class BackendControllerError extends Error {
  constructor(kind) {
    super('Backend operation failed')
    this.name = 'BackendControllerError'
    this.kind = kind
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
      if (specifier === '@/services/backend-controller') {
        return { BackendControllerError }
      }
      throw new Error(`Unexpected runtime import in focused test: ${specifier}`)
    },
  })

  return module.exports
}

function loadNoticeServiceModule(consoleImpl = console) {
  const sourcePath = resolve(repoRoot, 'src/services/notice-service.ts')
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
      if (specifier === 'i18next') {
        return {
          __esModule: true,
          default: { exists: () => false, isInitialized: false },
        }
      }
      if (specifier === 'react') return { isValidElement: () => false }
      if (specifier === '@/services/safe-client-error') {
        return loadSafeClientErrorModule(consoleImpl)
      }
      throw new Error(`Unexpected runtime import in notice test: ${specifier}`)
    },
    setTimeout: () => 1,
    clearTimeout: () => {},
  })

  return module.exports
}

function loadDebugModule(consoleImpl = console) {
  const sourcePath = resolve(repoRoot, 'src/utils/debug.ts')
  const source = readFileSync(sourcePath, 'utf8')
    .replaceAll('import.meta.env.DEV', 'false')
    .replaceAll('import.meta.env.VITE_ENABLE_DEBUG_LOGS', "'true'")
  const { outputText } = ts.transpileModule(source, {
    compilerOptions: {
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
  })

  return module.exports
}

function loadNotificationHandlersModule(consoleImpl, noticeService) {
  const sourcePath = resolve(
    repoRoot,
    'src/pages/_layout/utils/notification-handlers.ts',
  )
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
      if (specifier === '@/services/notice-service') return noticeService
      if (specifier === '@/services/safe-client-error') {
        return loadSafeClientErrorModule(consoleImpl)
      }
      throw new Error(
        `Unexpected runtime import in notification test: ${specifier}`,
      )
    },
  })

  return module.exports
}

function listTypeScriptSources(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = resolve(directory, entry.name)
    if (entry.isDirectory()) return listTypeScriptSources(path)
    return /\.tsx?$/.test(entry.name) ? [path] : []
  })
}

function collectCalls(sourcePath) {
  const source = readFileSync(sourcePath, 'utf8')
  const sourceFile = ts.createSourceFile(
    sourcePath,
    source,
    ts.ScriptTarget.Latest,
    true,
    sourcePath.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  )
  const calls = []

  function visit(node, caughtNames = new Set()) {
    let names = caughtNames
    if (ts.isCatchClause(node) && node.variableDeclaration?.name) {
      names = new Set(caughtNames)
      names.add(node.variableDeclaration.name.getText(sourceFile))
    }

    if (ts.isCallExpression(node)) {
      calls.push({
        caughtNames: names,
        expression: node.expression.getText(sourceFile),
        arguments: node.arguments.map((argument) =>
          argument.getText(sourceFile),
        ),
        line:
          sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile))
            .line + 1,
      })
    }

    ts.forEachChild(node, (child) => visit(child, names))
  }

  visit(sourceFile)
  return calls
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
  assert.deepEqual(
    asPlainValue(
      classifyClientError(new BackendControllerError('service_blocked')),
    ),
    { kind: 'service', retryable: false },
  )
  assert.deepEqual(
    asPlainValue(classifyClientError(new BackendControllerError('network'))),
    { kind: 'network', retryable: true },
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

test('production-enableable debug wrapper emits only allowlisted categorical metadata', () => {
  const calls = []
  const debug = loadDebugModule({ info: (...args) => calls.push(args) })
  const raw = HOSTILE_ERROR_FRAGMENTS.join('\n')

  assert.deepEqual(
    asPlainValue(
      debug.toSafeDebugRecord('delay-test-complete', {
        count: 3,
        enabled: true,
        proxyName: raw,
        result: { url: raw },
        [raw]: 7,
      }),
    ),
    { event: 'delay-test-complete', count: 3, enabled: true },
  )
  assert.deepEqual(asPlainValue(debug.toSafeDebugRecord(raw, { url: raw })), {
    event: 'client-debug',
  })

  debug.debugLog(raw, { url: raw })
  assert.deepEqual(asPlainValue(calls), [[{ event: 'client-debug' }]])
  assert.equal(JSON.stringify(calls).includes(raw), false)
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
    const record = toSafeClientFailureRecord('resume-recovery', hostileError)

    assert.deepEqual(Object.keys(record).sort(), ['kind', 'retryable', 'scope'])
    assert.deepEqual(asPlainValue(record), {
      scope: 'resume-recovery',
      kind: 'unknown',
      retryable: false,
    })
    assert.equal(JSON.stringify(record).includes(fragment), false)

    reportSafeClientFailure('resume-recovery', hostileError)
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

test('global browser failure handlers suppress raw WebView defaults after safe reporting', () => {
  const calls = []
  const consoleImpl = { warn: (...args) => calls.push(args) }
  const { handleGlobalErrorEvent, handleGlobalPromiseRejection } =
    loadSafeClientErrorModule(consoleImpl)
  const raw = HOSTILE_ERROR_FRAGMENTS.join('\n')
  let errorPrevented = 0
  let rejectionPrevented = 0

  handleGlobalErrorEvent({
    error: new Error(raw),
    preventDefault: () => {
      errorPrevented += 1
    },
  })
  handleGlobalPromiseRejection({
    reason: new Error(raw),
    preventDefault: () => {
      rejectionPrevented += 1
    },
  })

  assert.equal(errorPrevented, 1)
  assert.equal(rejectionPrevented, 1)
  assert.deepEqual(
    calls.map(([record]) => asPlainValue(record)),
    [
      {
        scope: 'global-window-error',
        kind: 'unknown',
        retryable: false,
      },
      {
        scope: 'unhandled-rejection',
        kind: 'unknown',
        retryable: false,
      },
    ],
  )
  assert.equal(JSON.stringify(calls).includes(raw), false)
})

test('safe clipboard and notice sinks receive generic material only', async () => {
  const calls = []
  const consoleImpl = { warn: (...args) => calls.push(args) }
  const safe = loadSafeClientErrorModule(consoleImpl)
  const notices = loadNoticeServiceModule(consoleImpl)
  const raw = HOSTILE_ERROR_FRAGMENTS.join('\n')
  let failureClipboardText = ''
  let noticeClipboardText = ''

  await safe.writeSafeClientFailureToClipboard(
    'base-error-copy',
    new Error(raw),
    async (text) => {
      failureClipboardText = text
    },
  )
  notices.showSafeClientFailureNotice('service-install', new Error(raw))
  const [notice] = notices.getSnapshotNotices()
  const copied = await notices.copyNoticeToClipboard(
    notice,
    'Something went wrong. Please try again.',
    'Something went wrong. Please try again.',
    async (text) => {
      noticeClipboardText = text
    },
  )

  assert.equal(copied, true)
  assert.deepEqual(asPlainValue(notice.i18n), {
    key: 'shared.feedback.errors.safeClient.unknown',
  })
  assert.equal(notice.message, undefined)
  assert.equal(noticeClipboardText, 'Something went wrong. Please try again.')
  for (const fragment of HOSTILE_ERROR_FRAGMENTS) {
    assert.equal(failureClipboardText.includes(fragment), false)
    assert.equal(JSON.stringify(notice).includes(fragment), false)
    assert.equal(noticeClipboardText.includes(fragment), false)
  }
})

test('legacy error notices map unknown values to generic copy without extracting raw text', async () => {
  const notices = loadNoticeServiceModule({ warn: () => {} })
  const raw = HOSTILE_ERROR_FRAGMENTS.join('\n')

  notices.showNotice.error(new Error(raw))
  notices.showNotice.error(
    'shared.feedback.notifications.common.refreshFailed',
    new Error(raw),
  )
  notices.showNotice.error({
    key: 'shared.feedback.notifications.common.refreshFailed',
    params: { detail: { message: raw } },
  })

  const snapshot = notices.getSnapshotNotices()
  assert.equal(snapshot.length, 3)
  for (const notice of snapshot) {
    assert.deepEqual(asPlainValue(notice.i18n), {
      key: 'shared.feedback.errors.safeClient.unknown',
    })
    let copied = ''
    await notices.copyNoticeToClipboard(
      notice,
      raw,
      'Something went wrong. Please try again.',
      async (text) => {
        copied = text
      },
    )
    assert.equal(copied, 'Something went wrong. Please try again.')
    assert.equal(JSON.stringify(notice).includes(raw), false)
  }
})

test('backend notification errors preserve actions without forwarding raw message payloads', () => {
  const calls = []
  const consoleImpl = { warn: (...args) => calls.push(args) }
  const notices = loadNoticeServiceModule(consoleImpl)
  const { handleNoticeMessage } = loadNotificationHandlersModule(
    consoleImpl,
    notices,
  )
  const navigations = []
  const raw = HOSTILE_ERROR_FRAGMENTS.join('\n')
  const navigate = (...args) => navigations.push(args)

  handleNoticeMessage('import_sub_url::error', raw, (key) => key, navigate)
  handleNoticeMessage(
    'config_validate::yaml_error',
    raw,
    (key) => key,
    navigate,
  )

  assert.deepEqual(navigations, [['/profile']])
  const snapshot = notices.getSnapshotNotices()
  assert.equal(snapshot.length, 2)
  assert.equal(
    snapshot[0].i18n.key,
    'shared.feedback.errors.safeClient.unknown',
  )
  assert.equal(
    snapshot[1].i18n.key,
    'shared.feedback.validation.yaml.generalError',
  )
  const serialized = JSON.stringify({ calls, snapshot })
  for (const fragment of HOSTILE_ERROR_FRAGMENTS) {
    assert.equal(serialized.includes(fragment), false)
  }
})

test('reporter scopes are a closed runtime allowlist covering every literal call site', () => {
  const calls = []
  const consoleImpl = { warn: (...args) => calls.push(args) }
  const { SAFE_CLIENT_FAILURE_SCOPES, reportSafeClientFailure } =
    loadSafeClientErrorModule(consoleImpl)
  const allowlist = new Set(SAFE_CLIENT_FAILURE_SCOPES)
  const sourceRoot = resolve(repoRoot, 'src')
  const sourcePaths = readdirSync(sourceRoot, { recursive: true })
    .map(String)
    .filter((path) => /\.(?:ts|tsx)$/.test(path))
  const usedScopes = new Set()

  for (const relativePath of sourcePaths) {
    const source = readFileSync(resolve(sourceRoot, relativePath), 'utf8')
    for (const match of source.matchAll(
      /(?:reportSafeClientFailure|showSafeClientFailureNotice)\(\s*['"]([^'"]+)['"]/g,
    )) {
      usedScopes.add(match[1])
    }
  }

  assert.equal(usedScopes.size > 0, true)
  for (const scope of usedScopes) {
    assert.equal(allowlist.has(scope), true, `missing safe scope: ${scope}`)
  }

  reportSafeClientFailure('attacker-controlled-scope', new Error('fixture'))
  assert.equal(calls.at(-1)[0].scope, 'client-failure')
})

test('repo-wide TypeScript sink inventory rejects raw console, debug, and caught-error notices', () => {
  const sourceRoot = resolve(repoRoot, 'src')
  const sourcePaths = listTypeScriptSources(sourceRoot)
  const consoleAllowlist = new Set([
    resolve(sourceRoot, 'services/safe-client-error.ts'),
    resolve(sourceRoot, 'utils/debug.ts'),
  ])

  assert.equal(sourcePaths.length > 0, true)
  for (const sourcePath of sourcePaths) {
    const relativePath = sourcePath.slice(repoRoot.length + 1)
    for (const call of collectCalls(sourcePath)) {
      if (/^console\.(?:log|debug|info|warn|error)$/.test(call.expression)) {
        assert.equal(
          consoleAllowlist.has(sourcePath),
          true,
          `${relativePath}:${call.line} uses console outside a safe reporter`,
        )
      }

      if (call.expression === 'debugLog') {
        const event = call.arguments[0]
        assert.match(
          event ?? '',
          /^['"][a-z0-9-]+['"]$/,
          `${relativePath}:${call.line} uses a nonliteral debug event`,
        )
        assert.doesNotMatch(
          call.arguments.slice(1).join(' '),
          /\b(?:err(?:or)?|result|url|name|proxy|group|profile|host|worker|message)\b/i,
          `${relativePath}:${call.line} passes sensitive-shaped debug metadata`,
        )
      }

      if (call.expression === 'showNotice.error') {
        const caughtValue = [...call.caughtNames].find((name) =>
          call.arguments.some(
            (argument) =>
              new RegExp(`\\b${name}\\b`).test(argument) &&
              !argument.includes('toSafeClientErrorMessage'),
          ),
        )
        assert.equal(
          caughtValue,
          undefined,
          `${relativePath}:${call.line} forwards caught value ${caughtValue} to a notice`,
        )
      }
    }
  }
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
    'src/hooks/use-service-installer.ts',
    'src/services/preload.ts',
    'src/hooks/use-system-state.ts',
    'src/pages/_layout/hooks/use-app-initialization.ts',
    'src/pages/_layout/hooks/use-layout-events.ts',
    'src/pages/_layout/utils/initial-loading-overlay.ts',
    'src/pages/_layout/utils/notification-handlers.ts',
    'src/hooks/use-listen.ts',
    'src/hooks/use-i18n.ts',
    'src/hooks/use-editor-document.ts',
    'src/providers/window/window-provider.tsx',
    'src/pages/_layout.tsx',
    'src/pages/_layout/hooks/use-custom-theme.ts',
    'src/services/i18n.ts',
    'src/services/cmds.ts',
    'src/components/layout/notice-manager.tsx',
    'src/services/account-runtime-enforcement.ts',
  ]

  for (const relativePath of paths) {
    const source = readFileSync(resolve(repoRoot, relativePath), 'utf8')
    assert.match(
      source,
      /safe-client-error|showSafeClientFailureNotice/,
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
  assert.match(resumeSource, /lastFailure = \{ userId, at: Date\.now\(\) \}/)
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
  // The subscription URL goes through the one redactor. This file used to
  // carry its own -- `redacted_subscription_url_for_log` with a `> 8` path
  // threshold -- and neither of the two rulings that corrected `mask_url`
  // ever reached it, so a vmess payload and an eight-byte token came through
  // here after both were closed. Assert there is no second implementation.
  assert.match(source, /help::mask_url/)
  assert.doesNotMatch(
    source,
    /fn redacted_subscription_(url_for_log|path)/,
    'a second subscription redactor is back; there must be exactly one',
  )
  assert.doesNotMatch(
    source,
    /mask_err/,
    'mask_err is retired; call sites log typed facts instead',
  )
})

// The config validator quotes the offending fragment back, which for a proxy
// config means server hosts, UUIDs and passwords. That text used to be logged
// at info level and returned to the caller, reaching the UI. Masking it was the
// smaller half of the job: mask_err redacts URL shapes, and the validator also
// emits bare config fields -- `password: x`, a UUID on its own line -- that
// nothing URL-shaped can see. A masked line that still carries the secret is
// indistinguishable from a redacted one, so this is a boundary rather than a
// filter: only the byte count and the exit status leave the function.
//
// Written as an enumeration of what the two buffers may be used for, not as a
// search for the leak that was there. A guard that matches one known bad string
// stays green for the next path out.
test('config validator output never reaches a log line or the UI', () => {
  const raw = readFileSync(
    resolve(repoRoot, 'src-tauri/src/core/validate.rs'),
    'utf8',
  )
  // Comments name both buffers and would otherwise count as uses. The cut has
  // to know about string literals: Rust source is full of "https://..." and a
  // plain indexOf('//') truncates such a line at the scheme separator, hiding
  // whatever follows. A mutation that added a stderr leak to a line carrying a
  // URL literal passed this guard for exactly that reason.
  const source = raw
    .split('\n')
    .map((line) => {
      let quote = null
      for (let i = 0; i < line.length; i += 1) {
        const c = line[i]
        if (quote) {
          if (c === '\\') i += 1
          else if (c === quote) quote = null
        } else if (c === '"' || c === "'") {
          quote = c
        } else if (c === '/' && line[i + 1] === '/') {
          return line.slice(0, i)
        }
      }
      return line
    })
    .join('\n')

  assert.doesNotMatch(
    source,
    /from_utf8/,
    'validator output is being decoded again; only its length may leave this function',
  )

  const ALLOWED = [
    /^let (?:stdout|stderr) = &output\.(?:stdout|stderr);$/,
    /^if !(?:stdout|stderr)\.is_empty\(\) \{$/,
    /^(?:stdout|stderr)\.len\(\)$/,
    /^"验证器 (?:stdout|stderr) \{\} 字节（内容不记录）",$/,
    /^let has_error = !status\.success\(\) \|\| contains_any_keyword\(stderr, &error_keywords\);$/,
  ]
  const unexpected = source
    .split('\n')
    .map((line, index) => `${index + 1}: ${line.trim()}`)
    .filter((line) => /\bstdout\b|\bstderr\b/.test(line))
    .filter((line) => !ALLOWED.some((shape) => shape.test(line.split(': ')[1])))

  assert.deepEqual(
    unexpected,
    [],
    `validate.rs uses the validator's output in a way this guard has not \
approved -- if the new use is safe, add its shape to ALLOWED and say why:\n  ${unexpected.join('\n  ')}`,
  )
})
