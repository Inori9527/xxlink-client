import assert from 'node:assert/strict'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { resolve } from 'node:path'
import test from 'node:test'
import vm from 'node:vm'

import ts from 'typescript'

const repoRoot = resolve(import.meta.dirname, '..')

// PROVES:         Part executed, part source text. Transpiles
//                 src/services/safe-client-error.ts and runs it in a vm against
//                 hostile fixtures, then asserts the EXACT shape of what comes
//                 back -- key sets, enum values, no free-form string fields --
//                 plus one canary that the serialised output does not contain a
//                 fixture secret. The sink-inventory tests from roughly the
//                 midpoint of the file onward match source text across src/ and
//                 src-tauri/, and execute nothing.
// DOES NOT PROVE: that the app own build produces this module, or that the real
//                 sinks behave as the mocks here do -- clipboard, notice and
//                 persistence calls are recorded, not performed. It no longer
//                 traverses values looking for secrets, and makes no claim about
//                 what a Map, a Proxy or a WeakMap might hold. What it pins is an
//                 exact JSON-VISIBLE PROJECTION, not an exact object: asPlainValue
//                 is JSON.parse(JSON.stringify(...)), so a symbol-keyed property, an
//                 undefined- or function-valued own property, an inherited property,
//                 a toJSON returning something innocuous, and a secret on a
//                 non-enumerable property all survive it and satisfy the deepEqual.
//                 Production itself relies on that: notice-service.ts builds
//                 { key, params: undefined }, which projects to { key }. None of
//                 those routes is reachable from the three producers these tests
//                 drive, which build literals of fixed enums and primitives -- that
//                 is why the projection suffices HERE, and it is not a general
//                 property of JSON round-trips.
//                 Nothing here runs in CI -- of the four guard steps in
//                 frontend-check.yml this file is in none of them.

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

// The oracle is the exact-shape assertion beside each call site. It is not a
// search for secrets, and two rounds of review are the reason.
//
// The first walker enumerated with Object.values, which returns [] for an
// Error, a Map and a Set. The second dispatched on `instanceof`, which is
// realm-bound and answers false for every value built inside the vm this file
// loads the module into. The third dispatched on Object.prototype.toString,
// which an object sets for itself with Symbol.toStringTag, and which answers
// "[object Object]" for a Proxy over an Error that `instanceof` would have
// caught. Every classifier asks the object what it is, and the object is the
// one answering.
//
// So there is no classifier. The sanitizer under test discards its input and
// emits a closed shape, and the assertion is that shape: an exact key set,
// enum-valued fields, and no free-form string field for a secret to sit in.
// `asPlainValue` is JSON.parse(JSON.stringify(...)), so an Error, Map, Set or
// Proxy anywhere in the output collapses to {} and breaks the deepEqual. A
// closed shape has nowhere to hide one, and nothing here traverses looking.
//
// The canary below is the second line of defence, for the day a shape
// assertion is loosened.
function assertSecretAbsent(label, output) {
  const serialised = JSON.stringify(output) ?? ''
  for (const fragment of HOSTILE_ERROR_FRAGMENTS) {
    // Encode the fixture the way JSON.stringify encoded the output. Comparing
    // a RAW fixture against serialised output is exactly how three checks in
    // this file passed on nothing: JSON escapes the newline in the multi-line
    // fixture, so the needle could never appear in the haystack.
    const encoded = JSON.stringify(fragment).slice(1, -1)
    assert.ok(
      !serialised.includes(encoded),
      `${label} serialised a fixture secret: ${JSON.stringify(fragment.slice(0, 40))}`,
    )
  }
}

// The control those dead checks never had. It has to cover the multi-line
// fixture by name, because that is the one the old comparison could not match
// and therefore the one a repair is most likely to get wrong again.
test('the secret canary can fail, including for the fixture containing a newline', () => {
  for (const fragment of HOSTILE_ERROR_FRAGMENTS) {
    assert.throws(
      () => assertSecretAbsent('control', { detail: fragment }),
      /serialised a fixture secret/,
      `the canary misses ${JSON.stringify(fragment.slice(0, 30))}`,
    )
  }

  const multiline = HOSTILE_ERROR_FRAGMENTS.find((f) => f.includes('\n'))
  assert.ok(
    multiline,
    'no fixture contains a newline, so this control proves nothing',
  )
  assert.throws(
    () => assertSecretAbsent('control', { detail: multiline }),
    /serialised a fixture secret/,
    'the canary misses the multi-line fixture, which is the one the old check could not see',
  )
  // The old mistake itself, kept executable rather than described: the raw
  // fixture does NOT appear in the serialised output, which is why comparing
  // against it found nothing for years.
  assert.ok(
    !JSON.stringify({ detail: multiline }).includes(multiline),
    'the raw multi-line fixture now survives JSON.stringify; the encoding step above is no longer needed',
  )
})

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
  assertSecretAbsent('debug log', calls)
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
  assertSecretAbsent('debug log', calls)
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
    // The positive shape of the whole notice, not just its i18n field: the
    // deepEqual above pins notice.i18n, and the retired walker was the only
    // thing looking at the rest of it. Every field here is a number or an
    // enum; there is no free-form string for a secret to occupy.
    assert.deepEqual(Object.keys(notice).sort(), [
      'duration',
      'i18n',
      'id',
      'timerId',
      'type',
    ])
    assert.ok(
      // Equality, not an allowlist. All three fixtures call showNotice.error, and
      // copyNoticeToClipboard only returns generic text for type 'error', so an
      // allowlist here could lose 'info' or 'success' and stay green -- a
      // membership test nothing exercises is a membership test that cannot fail.
      // NoticeType is success|error|info (notice-service.ts:11); covering the
      // other two needs fixtures that reach their shortcuts, not a wider list.
      notice.type === 'error',
      'the notice on this path is not an error notice',
    )
    assert.equal(typeof notice.id, 'number')
    assert.equal(typeof notice.timerId, 'number')
    assert.equal(typeof notice.duration, 'number')
    assertSecretAbsent('legacy notice', notice)
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
  // here after both were closed.
  //
  // Scoped to the function body, not matched against the whole file. A
  // whole-file `/help::mask_url/` is satisfied by any mention anywhere --
  // including this test's own subject line in a comment -- so it stayed green
  // when the call was replaced by a raw pass-through. And a name denylist only
  // catches a second redactor that keeps the old name.
  const summaryBody = source.match(
    /fn redacted_deep_link_url_summary\([\s\S]*?\n\}/,
  )?.[0]
  assert.ok(summaryBody, 'redacted_deep_link_url_summary must still exist')
  assert.match(
    summaryBody,
    /\.map\(help::mask_url\)/,
    'the deep-link summary must mask its subscription URL through help::mask_url',
  )
  // Anchored at column zero so it counts the module's own helpers and not the
  // test functions, whose names also contain "redact" -- written unanchored
  // first, it reported four and failed on the correct file.
  assert.deepEqual(
    source.match(/^fn\s+\w*redact\w*/gm) ?? [],
    ['fn redacted_deep_link_for_log', 'fn redacted_deep_link_url_summary'],
    'exactly two redaction helpers belong in this file; a third is a second ' +
      'implementation of a predicate that has already drifted once',
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
  // Comments name both buffers and would otherwise count as uses, so they are
  // dropped -- but only when the WHOLE line is a comment. Truncating at the
  // first "//" outside a string was tried and is not safe: Rust also has raw
  // strings, byte strings, char literals and lifetimes, and every one of those
  // is a way to make the scanner cut early and hide the rest of a line from
  // this sweep. Three mutations that added a real stderr-to-log leak passed
  // that version.
  //
  // Dropping whole comment lines only is the fail-closed choice. A trailing
  // comment that happens to say "stderr" now trips the sweep and costs one
  // review; the other direction ships the leak. Where a real trailing comment
  // needs to mention a buffer, reword it or give its shape an ALLOWED entry --
  // deliberately, not by accident of a lexer this file has no business owning.
  const source = raw
    .split('\n')
    .filter((line) => !/^\s*(?:\/\/|\/\*|\*)/.test(line))
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
