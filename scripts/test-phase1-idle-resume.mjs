import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import test from 'node:test'
import ts from 'typescript'
import vm from 'node:vm'

// PROVES:         Part executed, part source text. Ten of the twelve tests genuinely
//                 EXECUTE the code under test.
// DOES NOT PROVE: Nothing about src/pages/plans.tsx or src/pages/mine.tsx beyond the
//                 presence of text: those two tests never render, mount, or import the
//                 components, so green means the characters are in the file -- not that
//                 the component renders them, or renders at all.

const repoRoot = resolve(import.meta.dirname, '..')

function loadTsModule(relativePath, stubs = {}, cache = new Map()) {
  const absolutePath = resolve(repoRoot, relativePath)
  if (cache.has(absolutePath)) return cache.get(absolutePath).exports
  if (!existsSync(absolutePath)) {
    throw new Error(`Missing module: ${relativePath}`)
  }

  const source = readFileSync(absolutePath, 'utf8')
  const { outputText } = ts.transpileModule(source, {
    compilerOptions: {
      esModuleInterop: true,
      jsx: ts.JsxEmit.ReactJSX,
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
    return awaitImportUnsupported(specifier)
  }

  const wrapped = `(function (exports, require, module) {\n${outputText}\n})`
  const fn = vm.runInNewContext(
    wrapped,
    {
      console,
      localStorage: globalThis.localStorage,
      URL,
      setTimeout,
      clearTimeout,
    },
    { filename: absolutePath },
  )
  fn(module.exports, requireForModule, module)
  return module.exports
}

function awaitImportUnsupported(specifier) {
  throw new Error(`Unexpected runtime import in focused test: ${specifier}`)
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

test('auth terminal codes include backend revoked and suspended states', () => {
  const authErrors = loadTsModule('src/services/auth-errors.ts')

  assert.equal(authErrors.isRefreshTerminalCode('TOKEN_REVOKED'), true)
  assert.equal(authErrors.isRefreshTerminalCode('ACCOUNT_SUSPENDED'), true)
  assert.equal(authErrors.isAuthFatalCode('TOKEN_REVOKED'), true)
  assert.equal(authErrors.isAuthFatalCode('ACCOUNT_SUSPENDED'), true)
  assert.equal(authErrors.isRefreshTerminalCode('NETWORK_TIMEOUT'), false)
})

test('typed backend replies and failures are rejected after account replacement', async () => {
  let userId = 'user-a'
  let statusMutationCount = 0
  let mode = 'success'
  const authStore = {
    getState: () => ({ user: { id: userId } }),
    preserveCachedShell: () => {
      statusMutationCount += 1
    },
    setSessionStatus: () => {
      statusMutationCount += 1
    },
  }
  const invoke = async () => {
    userId = 'user-b'
    if (mode === 'success') return { subjectId: 'user-a', data: [] }
    throw { subjectId: 'user-a', kind: 'service_blocked' }
  }
  const controller = loadTsModule('src/services/backend-controller.ts', {
    '@tauri-apps/api/core': { invoke },
    '@/services/auth-store': { authStore },
  })

  await assert.rejects(controller.backendController.plans())
  assert.equal(statusMutationCount, 0)

  userId = 'user-a'
  mode = 'failure'
  await assert.rejects(controller.backendController.plans())
  assert.equal(statusMutationCount, 0)
})

test('business forbidden errors do not mutate an operational session', async () => {
  let kind = 'unknown'
  let sessionStatus = 'operational'
  const authStore = {
    getState: () => ({ user: { id: 'user-a' } }),
    preserveCachedShell: () => {
      sessionStatus = 'recovery_required'
    },
    setSessionStatus: (nextStatus) => {
      sessionStatus = nextStatus
    },
  }
  const invoke = async () => {
    throw { subjectId: 'user-a', kind }
  }
  const controller = loadTsModule('src/services/backend-controller.ts', {
    '@tauri-apps/api/core': { invoke },
    '@/services/auth-store': { authStore },
  })

  await assert.rejects(controller.backendController.plans())
  assert.equal(sessionStatus, 'operational')

  kind = 'service_blocked'
  await assert.rejects(controller.backendController.plans())
  assert.equal(sessionStatus, 'service_blocked')
})

test('account LKG cache is user scoped and strips subscription URLs', () => {
  installMemoryLocalStorage()
  const lkg = loadTsModule('src/services/account-lkg-cache.ts')
  const userId = 'user@example.test'

  const storageKey = lkg.getAccountLkgStorageKey(userId)
  assert.equal(storageKey.includes(userId), false)
  assert.equal(storageKey.startsWith('xxlink:lkg:account:'), true)

  assert.equal(lkg.writeAccountLkgCache(userId, {}), null)
  assert.equal(localStorage.getItem(storageKey), null)

  lkg.writeAccountLkgCache(userId, {
    plans: [
      {
        id: 'plan_1',
        name: 'Flagship',
        description: null,
        price: 1000,
        duration: 30,
        trafficLimit: 1,
        speedLimit: 300,
        maxDevices: 5,
      },
    ],
    subscription: {
      id: 'sub_1',
      planId: 'plan_1',
      subUrl: 'fixture-sub-url-that-must-not-persist',
      trafficUsed: 0,
      startAt: '2026-06-01T00:00:00Z',
      expireAt: '2026-07-01T00:00:00Z',
      status: 'ACTIVE',
      plan: {
        id: 'plan_1',
        name: 'Flagship',
        description: null,
        price: 1000,
        duration: 30,
        trafficLimit: 1,
        speedLimit: 300,
        maxDevices: 5,
      },
    },
    usage: {
      trafficUsed: 123,
      trafficLimit: 456,
      trafficRemaining: 333,
      percentUsed: 27,
      plan: { id: 'plan_1', name: 'Flagship', duration: 30 },
      status: 'ACTIVE',
      expireAt: '2026-07-01T00:00:00Z',
      startAt: '2026-06-01T00:00:00Z',
    },
  })

  const raw = localStorage.getItem(storageKey)
  assert.ok(raw)
  assert.equal(raw.includes('fixture-sub-url-that-must-not-persist'), false)
  assert.equal(raw.includes('subUrl'), false)

  const cached = lkg.readAccountLkgCache(userId)
  assert.equal(cached.plans.length, 1)
  assert.equal(cached.subscription.status, 'ACTIVE')
  assert.equal(cached.usage.trafficLimit, 456)
})

test('account LKG cache clears only the requested account unless clearing all', () => {
  installMemoryLocalStorage()
  const lkg = loadTsModule('src/services/account-lkg-cache.ts')

  lkg.writeAccountLkgCache('user-a', { plans: [] })
  lkg.writeAccountLkgCache('user-b', { plans: [] })

  lkg.clearAccountLkgCache('user-a')
  assert.equal(lkg.readAccountLkgCache('user-a'), null)
  assert.notEqual(lkg.readAccountLkgCache('user-b'), null)

  lkg.clearAccountLkgCache()
  assert.equal(lkg.readAccountLkgCache('user-b'), null)
})

test('account LKG keeps fallback data on failed refresh and accepts later authoritative state', () => {
  installMemoryLocalStorage()
  const lkg = loadTsModule('src/services/account-lkg-cache.ts')
  const userId = 'state@example.test'

  lkg.writeAccountLkgCache(userId, {
    subscription: {
      id: 'sub_active',
      planId: 'plan_active',
      trafficUsed: 1024,
      startAt: '2026-06-01T00:00:00Z',
      expireAt: '2026-07-01T00:00:00Z',
      status: 'ACTIVE',
      plan: {
        id: 'plan_active',
        name: 'Flagship',
        description: null,
        price: 1000,
        duration: 30,
        trafficLimit: 1024,
        speedLimit: 300,
        maxDevices: 5,
      },
    },
    usage: {
      trafficUsed: 1024,
      trafficLimit: 4096,
      trafficRemaining: 3072,
      percentUsed: 25,
      plan: { id: 'plan_active', name: 'Flagship', duration: 30 },
      status: 'ACTIVE',
      expireAt: '2026-07-01T00:00:00Z',
      startAt: '2026-06-01T00:00:00Z',
    },
  })

  lkg.writeAccountLkgCache(userId, {
    subscription: undefined,
    usage: undefined,
  })
  const afterFailure = lkg.readAccountLkgCache(userId)
  assert.equal(afterFailure.subscription.status, 'ACTIVE')
  assert.equal(afterFailure.usage.trafficRemaining, 3072)

  lkg.writeAccountLkgCache(userId, {
    subscription: null,
    usage: {
      trafficUsed: 4096,
      trafficLimit: 4096,
      trafficRemaining: 0,
      percentUsed: 100,
      plan: null,
      status: 'EXPIRED',
      expireAt: '2026-06-15T00:00:00Z',
      startAt: '2026-05-15T00:00:00Z',
    },
  })
  const afterAuthoritativeInvalidation = lkg.readAccountLkgCache(userId)
  assert.equal(afterAuthoritativeInvalidation.subscription, null)
  assert.equal(afterAuthoritativeInvalidation.usage.status, 'EXPIRED')
  assert.equal(afterAuthoritativeInvalidation.usage.trafficRemaining, 0)
  assert.equal(afterAuthoritativeInvalidation.usage.plan, null)
})

test('resume recovery refreshes safe account state without exposing secrets', async () => {
  installMemoryLocalStorage()
  const calls = {
    profile: 0,
    plans: 0,
    current: 0,
    usage: 0,
    publicBenefit: 0,
    nodes: 0,
    sync: 0,
  }

  const authStore = {
    getState: () => ({
      isAuthenticated: true,
      isOperational: true,
      user: {
        id: 'user@example.test',
        email: 'user@example.test',
        role: 'USER',
      },
    }),
  }
  const stubs = {
    '@/services/auth-store': { authStore },
    '@/services/backend-controller': {
      isBackendSubjectCurrent: (subjectId) =>
        subjectId === authStore.getState().user?.id,
      isSubscriptionActiveNow: () => false,
      backendController: {
        userProfile: async () => {
          calls.profile += 1
          return {
            id: 'user@example.test',
            email: 'user@example.test',
            role: 'USER',
          }
        },
        usage: async () => {
          calls.usage += 1
          return {
            trafficUsed: 1,
            trafficLimit: 2,
            trafficRemaining: 1,
            percentUsed: 50,
            plan: { id: 'plan_1', name: 'Flagship', duration: 30 },
            status: 'ACTIVE',
            expireAt: '2026-07-01T00:00:00Z',
            startAt: '2026-06-01T00:00:00Z',
          }
        },
        publicBenefit: async () => {
          calls.publicBenefit += 1
          return {
            visible: false,
            isTrial: false,
            hasPaidPlan: true,
            canClaim: false,
            emailVerified: true,
            claimBytes: 0,
            activeBonusBytes: 0,
          }
        },
        plans: async () => {
          calls.plans += 1
          return []
        },
        subscription: async () => {
          calls.current += 1
          return null
        },
        nodes: async () => {
          calls.nodes += 1
          return [
            {
              id: 'node_1',
              name: 'Tokyo',
              protocol: 'vless',
              region: 'JP',
              isActive: true,
              host: 'hidden.example.test',
              port: 443,
              subscriptionUrl:
                'https://api.example.test/subscription/secret-fixture',
            },
          ]
        },
      },
    },
    '@/services/subscription-sync': {
      syncSubscription: async () => {
        calls.sync += 1
      },
    },
    '@/services/api': {
      ApiError: class ApiError extends Error {},
      isAuthFatalError: () => false,
    },
  }
  const recovery = loadTsModule('src/services/resume-recovery.ts', stubs)

  await recovery.runResumeRecovery('test')

  assert.deepEqual(calls, {
    profile: 1,
    plans: 1,
    current: 1,
    usage: 1,
    publicBenefit: 1,
    nodes: 1,
    sync: 1,
  })

  const lkg = loadTsModule('src/services/account-lkg-cache.ts')
  const cached = lkg.readAccountLkgCache('user@example.test')
  assert.equal(cached.nodes[0].host, undefined)
  assert.equal(cached.nodes[0].port, undefined)
  assert.equal(cached.nodes[0].subscriptionUrl, undefined)
  assert.equal(JSON.stringify(cached).includes('secret-fixture'), false)
  assert.equal(cached.usage.percentUsed, 50)
})

test('resume recovery discards a batch after the active account changes', async () => {
  installMemoryLocalStorage()
  let userId = 'user-a'
  let plansCalls = 0
  const authStore = {
    getState: () => ({
      isAuthenticated: true,
      isOperational: true,
      user: { id: userId, email: `${userId}@example.test`, role: 'USER' },
    }),
  }
  const stubs = {
    '@/services/auth-store': { authStore },
    '@/services/backend-controller': {
      isBackendSubjectCurrent: (subjectId) => subjectId === userId,
      isSubscriptionActiveNow: () => false,
      backendController: {
        userProfile: async () => {
          userId = 'user-b'
          return { id: 'user-a', email: 'user-a@example.test', role: 'USER' }
        },
        plans: async () => {
          plansCalls += 1
          return []
        },
      },
    },
    '@/services/subscription-sync': { syncSubscription: async () => {} },
    '@/services/safe-client-error': {
      toSafeClientFailureRecord: () => ({
        scope: 'resume-recovery',
        kind: 'unknown',
        retryable: false,
      }),
    },
  }
  const recovery = loadTsModule('src/services/resume-recovery.ts', stubs)

  await recovery.runResumeRecovery('test', { force: true })

  assert.equal(plansCalls, 0)
  const lkg = loadTsModule('src/services/account-lkg-cache.ts')
  assert.equal(lkg.readAccountLkgCache('user-a'), null)
  assert.equal(lkg.readAccountLkgCache('user-b'), null)
})

test('failed resume recovery persists classification without raw client material', async () => {
  installMemoryLocalStorage()
  const rawFailure =
    'Authorization: Bearer resume-secret https://proxy-user:proxy-pass@example.test:8443/path?token=query-secret'
  class ApiError extends Error {}
  const stubs = {
    '@/services/auth-store': {
      authStore: {
        getState: () => ({
          isAuthenticated: true,
          isOperational: true,
          user: { id: 'user-id', email: 'user@example.test', role: 'USER' },
        }),
      },
    },
    '@/services/subscription-sync': { syncSubscription: async () => {} },
    '@/services/backend-controller': {
      isBackendSubjectCurrent: (subjectId) => subjectId === 'user-id',
      isSubscriptionActiveNow: () => false,
      backendController: {
        plans: async () => [],
        subscription: async () => null,
        usage: async () => {
          throw new Error(rawFailure)
        },
        publicBenefit: async () => null,
        nodes: async () => [],
        userProfile: async () => {
          throw new Error(rawFailure)
        },
      },
      BackendControllerError: class BackendControllerError extends Error {},
    },
    '@/services/api': {
      ApiError,
    },
  }
  const recovery = loadTsModule('src/services/resume-recovery.ts', stubs)

  await recovery.runResumeRecovery('test', { force: true })

  const persisted = localStorage.getItem('xxlink:last-sync-error')
  assert.ok(persisted)
  assert.deepEqual(Object.keys(JSON.parse(persisted)).sort(), [
    'kind',
    'reason',
    'retryable',
    'scope',
    'ts',
  ])
  assert.equal(persisted.includes(rawFailure), false)
  assert.equal(persisted.includes('resume-secret'), false)
  assert.equal(persisted.includes('proxy-pass'), false)
  assert.equal(persisted.includes('query-secret'), false)
})

test('display helpers distinguish unknown usage and confirmed empty plans', () => {
  const display = loadTsModule('src/services/account-display-state.ts')

  assert.equal(
    display.formatUsagePairLabel({
      usageKnown: false,
      usedLabel: '0 GB',
      limitLabel: null,
      unknownLabel: '用量暂时不可用',
    }),
    '用量暂时不可用',
  )
  assert.notEqual(
    display.formatUsagePairLabel({
      usageKnown: false,
      usedLabel: '0 GB',
      limitLabel: null,
      unknownLabel: '用量暂时不可用',
    }),
    '0 GB / --',
  )

  assert.equal(
    display.shouldShowConfirmedEmptyPlans({
      loading: false,
      planCount: 0,
      loadFailed: true,
    }),
    false,
  )
  assert.equal(
    display.shouldShowConfirmedEmptyPlans({
      loading: false,
      planCount: 0,
      loadFailed: false,
    }),
    true,
  )

  const accountOnlyFailure = display.getAccountRefreshFailureState({
    subscriptionFailed: true,
    benefitFailed: false,
    usageFailed: true,
    nodesFailed: false,
  })
  assert.equal(accountOnlyFailure.accountDataRefreshFailed, true)
  assert.equal(accountOnlyFailure.nodeListRefreshFailed, false)
  assert.equal(accountOnlyFailure.anyRefreshFailed, true)

  const nodeOnlyFailure = display.getAccountRefreshFailureState({
    subscriptionFailed: false,
    benefitFailed: false,
    usageFailed: false,
    nodesFailed: true,
  })
  assert.equal(nodeOnlyFailure.accountDataRefreshFailed, false)
  assert.equal(nodeOnlyFailure.nodeListRefreshFailed, true)
  assert.equal(nodeOnlyFailure.anyRefreshFailed, true)
  assert.equal(
    display.shouldShowRefreshFailureNotice({
      refreshFailed: true,
      hasLastKnownGood: true,
    }),
    false,
  )
  assert.equal(
    display.shouldShowRefreshFailureNotice({
      refreshFailed: true,
      hasLastKnownGood: false,
    }),
    true,
  )
  assert.equal(
    display.shouldShowRefreshFailureNotice({
      refreshFailed: false,
      hasLastKnownGood: false,
    }),
    false,
  )
  assert.equal('shouldShowCachedAccountWarning' in display, false)

  const plansSource = readFileSync(
    resolve(repoRoot, 'src/pages/plans.tsx'),
    'utf8',
  )
  const plansFailureBlock = plansSource.slice(
    plansSource.indexOf(
      "if (plansResult.status === 'fulfilled' && plansKnown)",
    ),
    plansSource.indexOf(
      "if (subResult.status === 'fulfilled' && subscriptionKnown)",
    ),
  )
  assert.equal(plansFailureBlock.includes('!hasLastKnownGood'), true)
  assert.equal(plansFailureBlock.includes('setError('), true)
})

test('mine page uses LKG usage and does not render transient failures as false zero state', () => {
  const mineSource = readFileSync(
    resolve(repoRoot, 'src/pages/mine.tsx'),
    'utf8',
  )

  assert.match(mineSource, /readAccountLkgCache/)
  assert.match(mineSource, /writeAccountLkgCache/)
  assert.match(mineSource, /ACCOUNT_LKG_CHANGED_EVENT/)
  assert.match(mineSource, /setUsageRefreshFailed\(true\)/)
  assert.match(
    mineSource,
    /writeAccountLkgCache\(user\.id, \{[\s\S]*usage: value,[\s\S]*accessDecision:/,
  )
  const mineUsageRefreshStart = mineSource.search(
    /backendController\s*\.usage\(\)/,
  )
  const mineUsageRefreshEnd = mineSource.indexOf(
    'return () =>',
    mineUsageRefreshStart,
  )
  assert.notEqual(mineUsageRefreshStart, -1)
  assert.notEqual(mineUsageRefreshEnd, -1)
  const mineUsageRefreshBlock = mineSource.slice(
    mineUsageRefreshStart,
    mineUsageRefreshEnd,
  )
  assert.equal(mineUsageRefreshBlock.includes('setUsage(null)'), false)
  assert.match(
    mineSource,
    /variant=\{usage \? 'determinate' : 'indeterminate'\}/,
  )
  assert.match(mineSource, /formatUsagePairLabel\(/)
  assert.match(mineSource, /shouldShowRefreshFailureNotice\(/)
})

test('legacy Home profile card is removed while Mine retains LKG coverage', () => {
  assert.equal(
    existsSync(resolve(repoRoot, 'src/components/home/home-profile-card.tsx')),
    false,
  )
})
