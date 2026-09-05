import assert from 'node:assert/strict'
import fs from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'
import test from 'node:test'
import vm from 'node:vm'

import ts from 'typescript'

// PROVES:         Part executed, part source text. Five of the six tests execute the
//                 real renderer code: they read src/services/diagnostics-bundle.ts,
//                 transpile it with the TypeScript compiler API (ts.transpileModule),
//                 and run it in a node:vm context where ...
// DOES NOT PROVE: Nothing about the Rust side or the real clipboard: both IPC commands
//                 are mocked, so no Tauri command, no log collection and no clipboard
//                 write is exercised.

const repoRoot = path.resolve(import.meta.dirname, '..')
const require = createRequire(import.meta.url)

const emptyCounts = () => ({
  debug: 0,
  info: 0,
  warn: 0,
  error: 0,
  unknown: 0,
})

const emptyCategories = () => ({
  'auth-session': 0,
  network: 0,
  'profile-sync': 0,
  timeout: 0,
  storage: 0,
  'structured-or-sensitive': 0,
  oversized: 0,
  other: 0,
  unrecognized: 0,
})

const safeSummary = (source, overrides = {}) => ({
  source,
  componentCount: 0,
  totalCount: 0,
  inspectedCount: 0,
  omittedCount: 0,
  levels: emptyCounts(),
  categories: emptyCategories(),
  ...overrides,
})

function loadDiagnosticsModule(extraContext = {}) {
  const sourcePath = path.join(repoRoot, 'src/services/diagnostics-bundle.ts')
  const source = fs.readFileSync(sourcePath, 'utf8')
  const { outputText } = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
      esModuleInterop: true,
      resolveJsonModule: true,
    },
    fileName: sourcePath,
  })
  const calls = []
  const module = { exports: {} }
  const invoke = async (command, payload) => {
    calls.push({ command, payload })
    if (command === 'runtime_get_diagnostics_log_summaries') {
      return (
        extraContext.logSummaries ?? {
          runtime: safeSummary('runtime'),
          clash: safeSummary('clash'),
        }
      )
    }
    if (command === 'runtime_write_diagnostics_bundle') {
      extraContext.clipboardText = JSON.stringify(payload.bundle, null, 2)
      return undefined
    }
    throw new Error(`unexpected command: ${command}`)
  }
  const mocks = {
    '@tauri-apps/api/core': { invoke },
    '@/services/cmds': {
      getSystemInfo: async () => 'Windows 11 / XXLink test system',
      getAppUptime: async () => 42_000,
      getRunningMode: async () => 'rule',
    },
    '@/services/auth-store': {
      authStore: {
        getState: () => ({
          isAuthenticated: true,
          isOperational: true,
          user: {
            id: 'fixture-user',
            email: 'fixture@example.test',
            role: 'USER',
          },
        }),
      },
    },
    '@/services/account-lkg-cache': {
      readAccountLkgCache: () => ({
        updatedAt: Date.parse('2026-06-29T11:55:00.000Z'),
        subscription: { status: 'ACTIVE' },
        usage: { status: 'ACTIVE', entitlement: { accessTier: 'PAID' } },
        nodes: [{ id: 'private-node-id' }],
      }),
    },
    '@root/package.json': { version: '2.5.3-rc.3' },
  }
  const localStorage = extraContext.localStorage ?? {
    getItem(key) {
      const values = {
        'clash-verge-selected-proxy': 'private-selected-node',
        'xxlink:subscription-profile-generation': 'private-generation',
        'xxlink:last-sync-error':
          'https://api.example.test/subscription?token=private-token',
        last_check_update: '1782730800000',
      }
      return values[key] ?? null
    },
  }
  vm.runInNewContext(outputText, {
    console,
    Date,
    exports: module.exports,
    localStorage,
    module,
    require: (specifier) => mocks[specifier] ?? require(specifier),
    URL,
  })
  return { ...module.exports, calls }
}

test('bundle accepts only closed log summaries and never serializes raw state', () => {
  const { buildDiagnosticsBundle, diagnosticsJsonHasForbiddenMaterial } =
    loadDiagnosticsModule()
  const bundle = buildDiagnosticsBundle(
    {
      appVersion: '2.5.3-rc.3',
      systemInfo: 'Windows 11 private-hostname',
      appUptimeMs: 123_456,
      runningMode: 'rule',
      authState: {
        isAuthenticated: true,
        hasAccessToken: true,
        hasRefreshToken: true,
        userRole: 'USER',
      },
      accountLkg: {
        present: true,
        updatedAt: Date.parse('2026-06-29T11:50:00.000Z'),
        subscriptionStatus: 'ACTIVE',
        nodeCount: 3,
        entitlementClass: 'PAID',
      },
      selectedNodeRaw: 'private-selected-node',
      profileGenerationRaw: 'private-generation',
      lastSyncErrorRaw: 'https://api.example.test/path?token=private-token',
      logs: {
        runtime: safeSummary('runtime', {
          componentCount: 1,
          totalCount: 2,
          inspectedCount: 2,
          levels: { ...emptyCounts(), info: 1, warn: 1 },
          categories: {
            ...emptyCategories(),
            other: 1,
            'structured-or-sensitive': 1,
          },
        }),
        clash: safeSummary('clash'),
      },
    },
    { now: () => new Date('2026-06-29T12:00:00.000Z') },
  )
  const serialized = JSON.stringify(bundle)
  assert.equal(bundle.logs.runtime.totalCount, 2)
  assert.equal(bundle.nodeSync.lastErrorFamily, 'other')
  assert.equal(serialized.includes('private-token'), false)
  assert.equal(serialized.includes('private-selected-node'), false)
  assert.equal(serialized.includes('private-generation'), false)
  assert.equal(serialized.includes('private-hostname'), false)
  assert.equal(diagnosticsJsonHasForbiddenMaterial(serialized), false)
})

test('invalid renderer-provided summaries fail closed to empty counters', () => {
  const { buildDiagnosticsBundle } = loadDiagnosticsModule()
  const bundle = buildDiagnosticsBundle({
    logs: {
      runtime: safeSummary('runtime', {
        totalCount: 1,
        inspectedCount: 1,
        levels: { ...emptyCounts(), info: 1 },
      }),
      clash: safeSummary('runtime'),
    },
  })
  assert.equal(bundle.logs.runtime.totalCount, 0)
  assert.equal(bundle.logs.clash.source, 'clash')
  assert.equal(bundle.logs.clash.totalCount, 0)
})

test('collector receives only Rust summaries and writes a typed bundle', async () => {
  const context = {
    clipboardText: '',
    logSummaries: {
      runtime: safeSummary('runtime', {
        componentCount: 1,
        totalCount: 1,
        inspectedCount: 1,
        levels: { ...emptyCounts(), warn: 1 },
        categories: { ...emptyCategories(), network: 1 },
      }),
      clash: safeSummary('clash'),
    },
  }
  const { copyDiagnosticsBundleToClipboard, calls } =
    loadDiagnosticsModule(context)
  const bundle = await copyDiagnosticsBundleToClipboard({ maxLogItems: 25 })
  assert.equal(bundle.logs.runtime.categories.network, 1)
  assert.deepEqual(
    calls.map(({ command }) => command),
    [
      'runtime_get_diagnostics_log_summaries',
      'runtime_write_diagnostics_bundle',
    ],
  )
  assert.equal(calls[0].payload.maxItems, 25)
  assert.equal(context.clipboardText.includes('private-token'), false)
  assert.equal(context.clipboardText, JSON.stringify(bundle, null, 2))
})

test('clipboard final gate rejects an invalid schema before IPC', async () => {
  const { writeDiagnosticsJsonToClipboard, calls } = loadDiagnosticsModule()
  await assert.rejects(
    () =>
      writeDiagnosticsJsonToClipboard(
        JSON.stringify({ schemaVersion: 1, forced: 'private-token' }),
      ),
    /forbidden material/i,
  )
  assert.equal(calls.length, 0)
})

test('clipboard writes canonical parsed JSON without duplicate-key bytes', async () => {
  const { buildDiagnosticsBundle, writeDiagnosticsJsonToClipboard, calls } =
    loadDiagnosticsModule()
  const bundle = buildDiagnosticsBundle(
    { appVersion: '2.5.3-rc.3' },
    { now: () => new Date('2026-06-29T12:00:00.000Z') },
  )
  const canonical = JSON.stringify(bundle, null, 2)
  const duplicateKeyJson = `{"app":{"version":"private-token"},${canonical.slice(1)}`
  await writeDiagnosticsJsonToClipboard(duplicateKeyJson)
  assert.equal(calls.length, 1)
  assert.equal(calls[0].command, 'runtime_write_diagnostics_bundle')
  assert.equal(
    JSON.stringify(calls[0].payload.bundle).includes('private-token'),
    false,
  )
})

test('renderer source cannot fetch raw logs or use generic clipboard capability', () => {
  const diagnostics = fs.readFileSync(
    path.join(repoRoot, 'src/services/diagnostics-bundle.ts'),
    'utf8',
  )
  const commands = fs.readFileSync(
    path.join(repoRoot, 'src/services/cmds.ts'),
    'utf8',
  )
  assert.doesNotMatch(diagnostics, /getRuntimeLogs|getClashLogs/)
  assert.doesNotMatch(diagnostics, /plugin-clipboard-manager/)
  assert.doesNotMatch(diagnostics, /runtime\?: Record|clash\?: unknown\[\]/)
  assert.doesNotMatch(commands, /getRuntimeLogs|getClashLogs/)
})
