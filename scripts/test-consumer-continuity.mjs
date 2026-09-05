import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import test from 'node:test'
import ts from 'typescript'
import vm from 'node:vm'

// PROVES:         Part executed, part source text. Split roughly down the middle
//                 between real execution and text matching.
// DOES NOT PROVE: Nothing about the React pages: main.tsx, connect.tsx, plans.tsx and
//                 mine.tsx are never compiled, rendered, or run.

const repoRoot = resolve(import.meta.dirname, '..')

function loadTsModule(relativePath, stubs = {}, cache = new Map()) {
  const absolutePath = resolve(repoRoot, relativePath)
  if (cache.has(absolutePath)) return cache.get(absolutePath).exports
  if (!existsSync(absolutePath))
    throw new Error(`Missing module: ${relativePath}`)

  const source = readFileSync(absolutePath, 'utf8')
  const { outputText } = ts.transpileModule(source, {
    compilerOptions: {
      esModuleInterop: true,
      module: ts.ModuleKind.CommonJS,
      moduleResolution: ts.ModuleResolutionKind.Node10,
      target: ts.ScriptTarget.ES2022,
    },
    fileName: absolutePath,
  })
  const module = { exports: {} }
  cache.set(absolutePath, module)

  const requireForModule = (specifier) => {
    if (Object.hasOwn(stubs, specifier)) return stubs[specifier]
    if (specifier.startsWith('@/')) {
      return loadTsModule(`src/${specifier.slice(2)}.ts`, stubs, cache)
    }
    if (specifier.startsWith('./') || specifier.startsWith('../')) {
      const resolved = resolve(dirname(absolutePath), specifier)
      const relative = resolved
        .replace(`${repoRoot}\\`, '')
        .replace(`${repoRoot}/`, '')
      return loadTsModule(`${relative}.ts`, stubs, cache)
    }
    throw new Error(`Unexpected runtime import in focused test: ${specifier}`)
  }

  const wrapped = `(function (exports, require, module) {\n${outputText}\n})`
  const runtimeGlobals = stubs.__globals ?? {}
  const fn = vm.runInNewContext(
    wrapped,
    {
      console,
      localStorage: globalThis.localStorage,
      setTimeout: runtimeGlobals.setTimeout ?? setTimeout,
      clearTimeout: runtimeGlobals.clearTimeout ?? clearTimeout,
      window: runtimeGlobals.window,
      Event: runtimeGlobals.Event ?? Event,
      CustomEvent: runtimeGlobals.CustomEvent,
    },
    { filename: absolutePath },
  )
  fn(module.exports, requireForModule, module)
  return module.exports
}

function installMemoryLocalStorage() {
  const store = new Map()
  globalThis.localStorage = {
    get length() {
      return store.size
    },
    clear() {
      store.clear()
    },
    getItem(key) {
      return store.has(key) ? store.get(key) : null
    },
    key(index) {
      return Array.from(store.keys())[index] ?? null
    },
    removeItem(key) {
      store.delete(key)
    },
    setItem(key, value) {
      store.set(key, String(value))
    },
  }
}

const plan = {
  id: 'synthetic-plan',
  name: 'Synthetic plan',
  description: null,
  price: 100,
  duration: 30,
  trafficLimit: 4096,
  speedLimit: 150,
  maxDevices: 3,
}

const usage = {
  trafficUsed: '1024',
  trafficLimit: '4096',
  trafficRemaining: '3072',
  percentUsed: 25,
  plan: { id: plan.id, name: plan.name, duration: plan.duration },
  entitlement: {
    speedLimitMbps: '150',
    maxDevices: 3,
    accessTier: 'paid',
    nodeTier: 'paid',
  },
  status: 'ACTIVE',
  startAt: '2026-07-01T00:00:00Z',
  expireAt: '2026-08-01T00:00:00Z',
}

test('authoritative account validators reject malformed zero-like data', () => {
  const validation = loadTsModule('src/services/account-state-validation.ts')

  assert.equal(validation.parseAuthoritativeBytes('0'), 0)
  assert.equal(validation.parseAuthoritativeBytes('001'), null)
  assert.equal(validation.parseAuthoritativeBytes('-1'), null)
  assert.equal(validation.parseAuthoritativeBytes('1.5'), null)
  assert.equal(
    validation.isRecognizedUsageSnapshot({ ...usage, percentUsed: 101 }),
    false,
  )
  assert.equal(
    validation.isRecognizedUsageSnapshot({ ...usage, status: 'UNKNOWN' }),
    false,
  )
  assert.equal(
    validation.isRecognizedUsageSnapshot({ ...usage, expireAt: 'not-a-date' }),
    false,
  )
  assert.equal(
    validation.isRecognizedPlanSnapshot({
      ...plan,
      trafficLimit: '4096',
    }),
    false,
  )
})

test('account refresh commits are serialized in request order', async () => {
  const coordinator = loadTsModule(
    'src/services/account-refresh-coordinator.ts',
  )
  const order = []
  let releaseFirst
  const first = coordinator.runAccountRefreshExclusive(
    () =>
      new Promise((resolveFirst) => {
        order.push('first-start')
        releaseFirst = () => {
          order.push('first-end')
          resolveFirst()
        }
      }),
  )
  const second = coordinator.runAccountRefreshExclusive(async () => {
    order.push('second')
  })

  await Promise.resolve()
  await Promise.resolve()
  assert.deepEqual(order, ['first-start'])
  releaseFirst()
  await Promise.all([first, second])
  assert.deepEqual(order, ['first-start', 'first-end', 'second'])
})

test('authoritative account denial is enforced globally and idempotently', async () => {
  let userId = 'synthetic-runtime-user'
  let decision = 'quota_exhausted'
  let disableAttempts = 0
  const dispatched = []
  const windowStub = {
    addEventListener() {},
    dispatchEvent(event) {
      dispatched.push(event.type)
      return true
    },
  }
  const enforcement = loadTsModule(
    'src/services/account-runtime-enforcement.ts',
    {
      '@/services/account-lkg-cache': {
        ACCOUNT_LKG_CHANGED_EVENT: 'synthetic-lkg-changed',
        readInMemoryAccountAccessDecision: () => null,
        readAccountLkgCache: () => ({ accessDecision: decision }),
      },
      '@/services/account-state-validation': {
        isAccountAccessDenied: (value) =>
          value === 'quota_exhausted' || value === 'entitlement_unavailable',
      },
      '@/services/auth-store': {
        authStore: {
          getState: () => ({
            isOperational: true,
            user: { id: userId },
          }),
          subscribe() {
            return () => {}
          },
        },
      },
      '@/services/runtime-action-controller': {
        runtimeActionController: {
          async disableConnection() {
            disableAttempts += 1
          },
        },
      },
      '@/services/safe-client-error': {
        reportSafeClientFailure() {},
      },
      __globals: { window: windowStub },
    },
  )

  await enforcement.enforceAuthoritativeAccountRuntime()
  await enforcement.enforceAuthoritativeAccountRuntime()
  assert.equal(disableAttempts, 1)
  assert.deepEqual(dispatched, ['xxlink:account-runtime-disabled'])

  decision = 'allowed'
  await enforcement.enforceAuthoritativeAccountRuntime()
  decision = 'entitlement_unavailable'
  await enforcement.enforceAuthoritativeAccountRuntime()
  assert.equal(disableAttempts, 2)

  userId = 'synthetic-other-user'
  await enforcement.enforceAuthoritativeAccountRuntime()
  assert.equal(disableAttempts, 3)
})

test('account runtime enforcement retry remains bound to its subject', async () => {
  let userId = 'synthetic-retry-owner'
  let disableAttempts = 0
  const reports = []
  const timers = []
  const windowStub = {
    addEventListener() {},
    dispatchEvent() {
      return true
    },
  }
  const enforcement = loadTsModule(
    'src/services/account-runtime-enforcement.ts',
    {
      '@/services/account-lkg-cache': {
        ACCOUNT_LKG_CHANGED_EVENT: 'synthetic-lkg-changed',
        readInMemoryAccountAccessDecision: () => null,
        readAccountLkgCache: () => ({ accessDecision: 'quota_exhausted' }),
      },
      '@/services/account-state-validation': {
        isAccountAccessDenied: (value) => value === 'quota_exhausted',
      },
      '@/services/auth-store': {
        authStore: {
          getState: () => ({
            isOperational: true,
            user: { id: userId },
          }),
          subscribe() {
            return () => {}
          },
        },
      },
      '@/services/runtime-action-controller': {
        runtimeActionController: {
          async disableConnection() {
            disableAttempts += 1
            throw new Error('synthetic-disable-failure')
          },
        },
      },
      '@/services/safe-client-error': {
        reportSafeClientFailure(scope) {
          reports.push(scope)
        },
      },
      __globals: {
        window: windowStub,
        setTimeout(callback) {
          const timer = { callback, unref() {} }
          timers.push(timer)
          return timer
        },
        clearTimeout() {},
      },
    },
  )

  await enforcement.enforceAuthoritativeAccountRuntime()
  await enforcement.enforceAuthoritativeAccountRuntime()
  assert.equal(disableAttempts, 1)
  assert.deepEqual(reports, ['account-runtime-enforcement'])
  assert.equal(timers.length, 1)

  userId = 'synthetic-replacement-owner'
  timers[0].callback()
  await Promise.resolve()
  assert.equal(disableAttempts, 1)
})

test('account runtime enforcement retry budget is finite per denied target', async () => {
  let decision = 'quota_exhausted'
  let disableAttempts = 0
  const timers = []
  const enforcement = loadTsModule(
    'src/services/account-runtime-enforcement.ts',
    {
      '@/services/account-lkg-cache': {
        ACCOUNT_LKG_CHANGED_EVENT: 'synthetic-lkg-changed',
        readInMemoryAccountAccessDecision: () => null,
        readAccountLkgCache: () => ({ accessDecision: decision }),
      },
      '@/services/account-state-validation': {
        isAccountAccessDenied: (value) => value === 'quota_exhausted',
      },
      '@/services/auth-store': {
        authStore: {
          getState: () => ({
            isOperational: true,
            user: { id: 'synthetic-bounded-retry-user' },
          }),
          subscribe() {
            return () => {}
          },
        },
      },
      '@/services/runtime-action-controller': {
        runtimeActionController: {
          async disableConnection() {
            disableAttempts += 1
            throw new Error('synthetic-disable-failure')
          },
        },
      },
      '@/services/safe-client-error': {
        reportSafeClientFailure() {},
      },
      __globals: {
        window: { addEventListener() {} },
        setTimeout(callback) {
          const timer = { callback, unref() {} }
          timers.push(timer)
          return timer
        },
        clearTimeout() {},
      },
    },
  )

  await enforcement.enforceAuthoritativeAccountRuntime()
  assert.equal(disableAttempts, 1)
  assert.equal(timers.length, 1)

  timers[0].callback()
  await new Promise((resolveTick) => setImmediate(resolveTick))
  assert.equal(disableAttempts, 2)
  assert.equal(timers.length, 2)

  timers[1].callback()
  await new Promise((resolveTick) => setImmediate(resolveTick))
  assert.equal(disableAttempts, 3)
  assert.equal(timers.length, 2, 'the terminal failure must not schedule again')

  await enforcement.enforceAuthoritativeAccountRuntime()
  assert.equal(
    disableAttempts,
    3,
    'later events must respect the exhausted budget',
  )

  decision = 'allowed'
  await enforcement.enforceAuthoritativeAccountRuntime()
  decision = 'quota_exhausted'
  await enforcement.enforceAuthoritativeAccountRuntime()
  assert.equal(disableAttempts, 4, 'a real target reset starts a fresh budget')
})

test('storage failure cannot suppress authoritative runtime enforcement', async () => {
  const previousStorage = globalThis.localStorage
  const dispatched = []
  globalThis.localStorage = {
    get length() {
      return 0
    },
    getItem() {
      return null
    },
    key() {
      return null
    },
    removeItem() {},
    setItem() {
      throw new Error('synthetic-storage-full')
    },
  }

  try {
    class SyntheticCustomEvent {
      constructor(type) {
        this.type = type
      }
    }
    const windowStub = {
      addEventListener() {},
      dispatchEvent(event) {
        dispatched.push(event.type)
        return true
      },
    }
    const lkg = loadTsModule('src/services/account-lkg-cache.ts', {
      __globals: {
        window: windowStub,
        CustomEvent: SyntheticCustomEvent,
      },
    })
    const userId = 'synthetic-storage-failure-user'
    assert.equal(
      lkg.writeAccountLkgCache(userId, {
        accessDecision: 'quota_exhausted',
      }),
      null,
    )
    assert.equal(
      lkg.readInMemoryAccountAccessDecision(userId),
      'quota_exhausted',
    )
    assert.deepEqual(dispatched, ['xxlink:account-lkg-changed'])

    let disableAttempts = 0
    const enforcement = loadTsModule(
      'src/services/account-runtime-enforcement.ts',
      {
        '@/services/account-lkg-cache': lkg,
        '@/services/account-state-validation': {
          isAccountAccessDenied: (value) => value === 'quota_exhausted',
        },
        '@/services/auth-store': {
          authStore: {
            getState: () => ({
              isOperational: true,
              user: { id: userId },
            }),
            subscribe() {
              return () => {}
            },
          },
        },
        '@/services/runtime-action-controller': {
          runtimeActionController: {
            async disableConnection() {
              disableAttempts += 1
            },
          },
        },
        '@/services/safe-client-error': {
          reportSafeClientFailure() {},
        },
        __globals: { window: windowStub },
      },
    )

    await enforcement.enforceAuthoritativeAccountRuntime()
    assert.equal(disableAttempts, 1)
  } finally {
    globalThis.localStorage = previousStorage
  }
})

test('root startup owns authoritative runtime enforcement', () => {
  const mainSource = readFileSync(resolve(repoRoot, 'src/main.tsx'), 'utf8')
  const connectSource = readFileSync(
    resolve(repoRoot, 'src/pages/connect.tsx'),
    'utf8',
  )
  const controllerSource = readFileSync(
    resolve(repoRoot, 'src/services/runtime-action-controller.ts'),
    'utf8',
  )

  assert.match(mainSource, /startAccountRuntimeEnforcement\(\)/)
  assert.match(connectSource, /ACCOUNT_RUNTIME_DISABLED_EVENT/)
  assert.doesNotMatch(connectSource, /authoritativeDisconnectInFlightRef/)
  assert.match(controllerSource, /async disableConnection\(\)/)
  assert.match(
    controllerSource,
    /runtime_set_tun_enabled'[\s\S]*?enabled: false/,
  )
  assert.match(
    controllerSource,
    /runtime_set_system_proxy_enabled'[\s\S]*?enabled: false/,
  )
})

test('Connect runtime-disabled handling reads the current subject decision', () => {
  const source = readFileSync(
    resolve(repoRoot, 'src/pages/connect.tsx'),
    'utf8',
  )
  const handlerStart = source.indexOf('const handleRuntimeDisabled = () =>')
  const handlerEnd = source.indexOf(
    'window.addEventListener(\n      ACCOUNT_RUNTIME_DISABLED_EVENT',
    handlerStart,
  )
  assert.ok(handlerStart >= 0 && handlerEnd > handlerStart)
  const handler = source.slice(handlerStart, handlerEnd)
  assert.match(handler, /const subjectId = captureBackendSubject\(\)/)
  assert.match(
    handler,
    /const currentDecision = readLatestAccountAccessDecision\(subjectId\)/,
  )
  assert.match(
    handler,
    /commitAccountAccessDecision\(subjectId, currentDecision\)/,
  )
  assert.doesNotMatch(handler, /isAccountAccessDenied\(accountAccessDecision\)/)
})

test('account decisions distinguish live, cached-unknown, and authoritative denial', () => {
  const validation = loadTsModule('src/services/account-state-validation.ts')
  const decide = validation.resolveAccountAccessDecision

  assert.equal(
    decide({
      subscriptionKnown: true,
      subscriptionActive: false,
      publicBenefitKnown: true,
      activeBenefitBytes: 0,
      usageKnown: true,
      usageAuthorizationKnown: true,
      usageAuthorized: true,
      trafficRemaining: 1024,
    }),
    'allowed',
    'effective Trial/Promo usage must override an expired base subscription',
  )
  assert.equal(
    decide({
      subscriptionKnown: true,
      subscriptionActive: true,
      publicBenefitKnown: true,
      activeBenefitBytes: 0,
      usageKnown: true,
      usageAuthorizationKnown: true,
      usageAuthorized: true,
      trafficRemaining: 0,
    }),
    'quota_exhausted',
  )
  assert.equal(
    decide({
      subscriptionKnown: true,
      subscriptionActive: false,
      publicBenefitKnown: true,
      activeBenefitBytes: 0,
      usageKnown: false,
      usageAuthorizationKnown: false,
      usageAuthorized: false,
      trafficRemaining: 0,
    }),
    'entitlement_unavailable',
  )
  assert.equal(
    decide({
      subscriptionKnown: false,
      subscriptionActive: false,
      publicBenefitKnown: false,
      activeBenefitBytes: 0,
      usageKnown: false,
      usageAuthorizationKnown: false,
      usageAuthorized: false,
      trafficRemaining: 0,
    }),
    'unknown',
  )
  assert.equal(validation.isAccountAccessDenied('unknown'), false)
  assert.equal(validation.isAccountAccessDenied('allowed'), false)
  assert.equal(validation.isAccountAccessDenied('quota_exhausted'), true)
})

test('partial refresh preserves denial until usage authoritatively restores access', () => {
  const validation = loadTsModule('src/services/account-state-validation.ts')
  const decide = validation.resolveAccountAccessDecision

  assert.equal(
    decide({
      previousDecision: 'quota_exhausted',
      subscriptionKnown: true,
      subscriptionActive: true,
      publicBenefitKnown: false,
      activeBenefitBytes: 0,
      usageKnown: false,
      usageAuthorizationKnown: false,
      usageAuthorized: false,
      trafficRemaining: 0,
    }),
    'quota_exhausted',
  )
  assert.equal(
    decide({
      previousDecision: 'entitlement_unavailable',
      subscriptionKnown: false,
      subscriptionActive: false,
      publicBenefitKnown: true,
      activeBenefitBytes: 1024,
      usageKnown: false,
      usageAuthorizationKnown: false,
      usageAuthorized: false,
      trafficRemaining: 0,
    }),
    'entitlement_unavailable',
  )
  assert.equal(
    decide({
      previousDecision: 'quota_exhausted',
      subscriptionKnown: false,
      subscriptionActive: false,
      publicBenefitKnown: false,
      activeBenefitBytes: 0,
      usageKnown: true,
      usageAuthorizationKnown: true,
      usageAuthorized: true,
      trafficRemaining: 2048,
    }),
    'allowed',
  )

  for (const relativePath of [
    'src/pages/connect.tsx',
    'src/pages/plans.tsx',
    'src/services/resume-recovery.ts',
  ]) {
    const source = readFileSync(resolve(repoRoot, relativePath), 'utf8')
    assert.match(
      source,
      /previousDecision:\s*readLatestAccountAccessDecision\(/,
      `${relativePath} must preserve the current decision on partial refresh`,
    )
  }
})

test('plan metadata or node responses cannot revive expired access', () => {
  const validation = loadTsModule('src/services/account-state-validation.ts')

  const evidence = validation.getUsageAuthorizationEvidence({
    ...usage,
    status: 'EXPIRED',
    entitlement: null,
  })
  assert.equal(evidence.known, true)
  assert.equal(evidence.authorized, false)
  assert.equal(
    validation.resolveAccountAccessDecision({
      subscriptionKnown: true,
      subscriptionActive: false,
      publicBenefitKnown: true,
      activeBenefitBytes: 0,
      usageKnown: true,
      usageAuthorizationKnown: true,
      usageAuthorized: false,
      trafficRemaining: 3072,
    }),
    'entitlement_unavailable',
  )
  assert.equal(
    validation.resolveAccountAccessDecision({
      subscriptionKnown: false,
      subscriptionActive: false,
      publicBenefitKnown: false,
      activeBenefitBytes: 0,
      usageKnown: false,
      usageAuthorizationKnown: false,
      usageAuthorized: false,
      trafficRemaining: 0,
    }),
    'unknown',
    'a weak nodes-only refresh must not upgrade a cached explicit denial',
  )
  const validationSource = readFileSync(
    resolve(repoRoot, 'src/services/account-state-validation.ts'),
    'utf8',
  )
  assert.equal(validationSource.includes('nodesAuthorized'), false)
})

test('malformed refresh data cannot replace a valid account LKG', () => {
  installMemoryLocalStorage()
  const lkg = loadTsModule('src/services/account-lkg-cache.ts')
  const userId = 'synthetic-user'

  lkg.writeAccountLkgCache(userId, {
    plans: [{ ...plan, unexpectedSecretField: 'synthetic-plan-secret' }],
    subscription: {
      id: 'synthetic-subscription',
      planId: plan.id,
      trafficUsed: 1024,
      startAt: usage.startAt,
      expireAt: usage.expireAt,
      status: 'ACTIVE',
      plan: {
        ...plan,
        unexpectedSecretField: 'synthetic-subscription-plan-secret',
      },
      unexpectedSecretField: 'synthetic-subscription-secret',
    },
    usage: {
      ...usage,
      unexpectedSecretField: 'synthetic-usage-secret',
      plan: {
        ...usage.plan,
        unexpectedSecretField: 'synthetic-nested-secret',
      },
      entitlement: {
        ...usage.entitlement,
        unexpectedSecretField: 'synthetic-entitlement-secret',
      },
    },
  })
  lkg.writeAccountLkgCache(userId, {
    plans: [{ ...plan, trafficLimit: '-1' }],
    usage: { ...usage, trafficRemaining: '--' },
  })

  const preserved = lkg.readAccountLkgCache(userId)
  assert.equal(preserved.plans[0].id, plan.id)
  assert.equal(preserved.usage.trafficRemaining, '3072')
  const serialized = localStorage.getItem(lkg.getAccountLkgStorageKey(userId))
  assert.equal(serialized.includes('synthetic-plan-secret'), false)
  assert.equal(serialized.includes('synthetic-usage-secret'), false)
  assert.equal(serialized.includes('synthetic-nested-secret'), false)
  assert.equal(serialized.includes('synthetic-entitlement-secret'), false)
  assert.equal(serialized.includes('synthetic-subscription-secret'), false)
  assert.equal(serialized.includes('synthetic-subscription-plan-secret'), false)

  const storageKey = lkg.getAccountLkgStorageKey(userId)
  const legacy = JSON.parse(localStorage.getItem(storageKey))
  delete legacy.accessDecision
  legacy.usage.unexpectedSecretField = 'synthetic-legacy-secret'
  localStorage.setItem(storageKey, JSON.stringify(legacy))
  const migrated = lkg.readAccountLkgCache(userId)
  const migratedRaw = localStorage.getItem(storageKey)
  assert.equal(migrated.accessDecision, 'unknown')
  assert.equal(migratedRaw.includes('synthetic-legacy-secret'), false)
  assert.equal(JSON.parse(migratedRaw).accessDecision, 'unknown')

  const corrupt = JSON.parse(localStorage.getItem(storageKey))
  corrupt.usage.trafficRemaining = '--'
  localStorage.setItem(storageKey, JSON.stringify(corrupt))
  assert.equal(lkg.readAccountLkgCache(userId), null)
  assert.equal(localStorage.getItem(storageKey), null)

  localStorage.setItem(storageKey, '{"version":1,"truncatedSecret":"fixture')
  assert.equal(lkg.readAccountLkgCache(userId), null)
  assert.equal(localStorage.getItem(storageKey), null)
})

test('connect refresh is race-safe and only confirmed denial blocks service', () => {
  const source = readFileSync(
    resolve(repoRoot, 'src/pages/connect.tsx'),
    'utf8',
  )

  assert.match(source, /accountRefreshGenerationRef/)
  assert.match(source, /generation !== accountRefreshGenerationRef\.current/)
  assert.match(source, /runAccountRefreshExclusive/)
  assert.match(source, /isRecognizedSubscriptionSnapshot/)
  assert.match(source, /isRecognizedUsageSnapshot/)
  assert.match(source, /isRecognizedNodesSnapshot/)
  assert.match(source, /isAccountAccessDenied\(decision\)/)
  assert.match(source, /isAccountAccessDenied\(currentDecision\)/)
  assert.equal(source.includes("decision === 'unknown'"), true)
  assert.equal(source.includes('shouldAutoSelectNode'), false)
  assert.equal(source.includes('nodeEntries[0]'), false)
})

test('traffic reporting and authoritative usage refresh have separate failure paths', () => {
  const source = readFileSync(
    resolve(repoRoot, 'src/pages/connect.tsx'),
    'utf8',
  )
  const start = source.indexOf('const reportHeartbeat = async () =>')
  const end = source.indexOf('\n    void reportHeartbeat()', start)
  const block = source.slice(start, end)
  const usageStart = block.indexOf(
    'const usage = await backendController.usage()',
  )
  const reportRestore = block.indexOf(
    'heartbeatTrafficRef.current.up + bytesUp',
  )

  assert.ok(start >= 0 && end > start)
  assert.ok(reportRestore >= 0 && reportRestore < usageStart)
  assert.equal(
    block
      .slice(usageStart)
      .includes('heartbeatTrafficRef.current.up + bytesUp'),
    false,
  )
  assert.match(block, /isRecognizedUsageSnapshot\(usage\)/)
  assert.match(block, /getUsageAuthorizationEvidence\(usage\)/)
  assert.match(block, /heartbeatInFlightRef\.current/)
  assert.match(block, /writeAccountLkgCache\(subjectId, \{/)
  assert.match(block, /accessDecision:/)
})

test('resume recovery keeps partial LKG but retains a retryable failure state', () => {
  const source = readFileSync(
    resolve(repoRoot, 'src/services/resume-recovery.ts'),
    'utf8',
  )
  const syncIndex = source.indexOf('await syncSubscription')
  const partialIndex = source.indexOf("accountRefresh === 'partial'")

  assert.ok(syncIndex >= 0 && partialIndex > syncIndex)
  assert.match(source, /throw new Error\('account_state_refresh_failed'\)/)
  assert.match(source, /isRecognizedPlansSnapshot/)
  assert.match(source, /isRecognizedUsageSnapshot/)
  assert.match(source, /scheduleRecoveryRetry\(userId\)/)
  assert.match(source, /runResumeRecovery\('retry', \{ force: true \}\)/)
})

test('resume recovery retries after backoff and accepts later success', async () => {
  installMemoryLocalStorage()
  let failProfile = true
  let profileCalls = 0
  let scheduledRetry
  let completeRetry
  const retryCompleted = new Promise((resolveRetry) => {
    completeRetry = resolveRetry
  })
  const subjectId = 'synthetic-retry-user'
  const authStore = {
    getState: () => ({
      isOperational: true,
      user: { id: subjectId, email: 'synthetic@example.test', role: 'USER' },
    }),
  }
  const recovery = loadTsModule('src/services/resume-recovery.ts', {
    __globals: {
      setTimeout: (callback) => {
        scheduledRetry = callback
        return { unref() {} }
      },
      clearTimeout: () => {},
    },
    '@/services/auth-store': { authStore },
    '@/services/backend-controller': {
      isBackendSubjectCurrent: (value) => value === subjectId,
      isSubscriptionActiveNow: () => false,
      backendController: {
        userProfile: async () => {
          profileCalls += 1
          if (failProfile) throw new Error('synthetic_network_failure')
          return {
            id: subjectId,
            email: 'synthetic@example.test',
            role: 'USER',
          }
        },
        plans: async () => [],
        subscription: async () => null,
        usage: async () => usage,
        publicBenefit: async () => ({
          visible: false,
          isTrial: false,
          hasPaidPlan: true,
          canClaim: false,
          emailVerified: true,
          claimBytes: '0',
          activeBonusBytes: '0',
        }),
        nodes: async () => [],
      },
    },
    '@/services/safe-client-error': {
      toSafeClientFailureRecord: () => ({
        scope: 'resume-recovery',
        kind: 'network',
        retryable: true,
      }),
    },
    '@/services/subscription-sync': {
      syncSubscription: async () => completeRetry(),
    },
  })

  await recovery.runResumeRecovery('test', { force: true })
  assert.equal(profileCalls, 1)
  assert.equal(typeof scheduledRetry, 'function')
  assert.ok(localStorage.getItem('xxlink:last-sync-error'))

  failProfile = false
  scheduledRetry()
  await retryCompleted
  await new Promise((resolveRetryTurn) => setImmediate(resolveRetryTurn))
  assert.equal(profileCalls, 2)
  assert.equal(localStorage.getItem('xxlink:last-sync-error'), null)
})

test('resume recovery queues a fresh run when the active account changes', async () => {
  installMemoryLocalStorage()
  let subjectId = 'subject-a'
  let releaseFirstProfile
  const profileCalls = []
  const syncCalls = []
  const firstProfile = new Promise((resolveProfile) => {
    releaseFirstProfile = resolveProfile
  })
  const authStore = {
    getState: () => ({
      isOperational: true,
      user: { id: subjectId, email: `${subjectId}@example.test`, role: 'USER' },
    }),
  }
  const recovery = loadTsModule('src/services/resume-recovery.ts', {
    '@/services/auth-store': { authStore },
    '@/services/backend-controller': {
      isBackendSubjectCurrent: (value) => value === subjectId,
      isSubscriptionActiveNow: () => false,
      backendController: {
        userProfile: async () => {
          const requestedSubject = subjectId
          profileCalls.push(requestedSubject)
          if (requestedSubject === 'subject-a') await firstProfile
          return {
            id: requestedSubject,
            email: `${requestedSubject}@example.test`,
            role: 'USER',
          }
        },
        plans: async () => [],
        subscription: async () => null,
        usage: async () => usage,
        publicBenefit: async () => ({
          visible: false,
          isTrial: false,
          hasPaidPlan: true,
          canClaim: false,
          emailVerified: true,
          claimBytes: '0',
          activeBonusBytes: '0',
        }),
        nodes: async () => [],
      },
    },
    '@/services/subscription-sync': {
      syncSubscription: async () => syncCalls.push(subjectId),
    },
    '@/services/safe-client-error': {
      toSafeClientFailureRecord: () => ({
        scope: 'resume-recovery',
        kind: 'network',
        retryable: true,
      }),
    },
  })

  const firstRun = recovery.runResumeRecovery('test', { force: true })
  subjectId = 'subject-b'
  const secondRun = recovery.runResumeRecovery('test', { force: true })
  releaseFirstProfile()
  await Promise.all([firstRun, secondRun])

  assert.deepEqual(profileCalls, ['subject-a', 'subject-b'])
  assert.deepEqual(syncCalls, ['subject-b'])
})

test('resume retry ownership follows the current account', async () => {
  installMemoryLocalStorage()
  let subjectId = 'subject-a'
  const failingSubjects = new Set(['subject-a', 'subject-b'])
  const profileCalls = []
  const timers = []
  const clearedTimers = new Set()
  let completeRetry
  const retryCompleted = new Promise((resolveRetry) => {
    completeRetry = resolveRetry
  })
  const authStore = {
    getState: () => ({
      isOperational: true,
      user: { id: subjectId, email: `${subjectId}@example.test`, role: 'USER' },
    }),
  }
  const recovery = loadTsModule('src/services/resume-recovery.ts', {
    __globals: {
      setTimeout: (callback) => {
        const timer = { callback, unref() {} }
        timers.push(timer)
        return timer
      },
      clearTimeout: (timer) => clearedTimers.add(timer),
    },
    '@/services/auth-store': { authStore },
    '@/services/backend-controller': {
      isBackendSubjectCurrent: (value) => value === subjectId,
      isSubscriptionActiveNow: () => false,
      backendController: {
        userProfile: async () => {
          profileCalls.push(subjectId)
          if (failingSubjects.has(subjectId)) {
            throw new Error('synthetic_network_failure')
          }
          return {
            id: subjectId,
            email: `${subjectId}@example.test`,
            role: 'USER',
          }
        },
        plans: async () => [],
        subscription: async () => null,
        usage: async () => usage,
        publicBenefit: async () => ({
          visible: false,
          isTrial: false,
          hasPaidPlan: true,
          canClaim: false,
          emailVerified: true,
          claimBytes: '0',
          activeBonusBytes: '0',
        }),
        nodes: async () => [],
      },
    },
    '@/services/safe-client-error': {
      toSafeClientFailureRecord: () => ({
        scope: 'resume-recovery',
        kind: 'network',
        retryable: true,
      }),
    },
    '@/services/subscription-sync': {
      syncSubscription: async () => completeRetry(),
    },
  })

  await recovery.runResumeRecovery('test', { force: true })
  subjectId = 'subject-b'
  await recovery.runResumeRecovery('test', { force: true })

  assert.equal(timers.length, 2)
  assert.equal(clearedTimers.has(timers[0]), true)

  timers[0].callback()
  await new Promise((resolveTurn) => setImmediate(resolveTurn))
  assert.deepEqual(profileCalls, ['subject-a', 'subject-b'])

  failingSubjects.delete('subject-b')
  timers[1].callback()
  await retryCompleted
  await new Promise((resolveTurn) => setImmediate(resolveTurn))
  assert.deepEqual(profileCalls, ['subject-a', 'subject-b', 'subject-b'])
})

test('Plans and Mine validate authority before replacing visible account state', () => {
  const plansSource = readFileSync(
    resolve(repoRoot, 'src/pages/plans.tsx'),
    'utf8',
  )
  const mineSource = readFileSync(
    resolve(repoRoot, 'src/pages/mine.tsx'),
    'utf8',
  )

  assert.match(plansSource, /loadGenerationRef/)
  assert.match(plansSource, /isRecognizedPlansSnapshot/)
  assert.match(plansSource, /isRecognizedSubscriptionSnapshot/)
  assert.match(plansSource, /isRecognizedUsageSnapshot/)
  assert.match(plansSource, /accessDecision:/)
  assert.match(mineSource, /isRecognizedUsageSnapshot/)
  assert.match(mineSource, /accessDecision:/)
  assert.equal(mineSource.includes('setUsage(null)'), false)
  const mineQueueStart = mineSource.indexOf(
    'runAccountRefreshExclusive(async () =>',
  )
  const mineQueueEnd = mineSource.indexOf('}).catch(', mineQueueStart)
  const mineCacheCommit = mineSource.indexOf(
    'writeAccountLkgCache(user.id, {',
    mineQueueStart,
  )
  assert.ok(mineQueueStart >= 0)
  assert.ok(mineCacheCommit > mineQueueStart && mineCacheCommit < mineQueueEnd)
})
