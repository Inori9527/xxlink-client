import assert from 'node:assert/strict'
import fs from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'
import test from 'node:test'
import vm from 'node:vm'

import ts from 'typescript'

const repoRoot = path.resolve(import.meta.dirname, '..')
const require = createRequire(import.meta.url)

const HOSTILE_DIAGNOSTIC_SAMPLES = [
  {
    value:
      'proxy https://proxy-user:proxy-password@proxy.example.test:8443/path',
    fragments: ['proxy-user', 'proxy-password'],
  },
  {
    value:
      'request https://api.example.test/path?token=query-token&api_key=query-api-key&safe=metadata',
    fragments: ['query-token', 'query-api-key'],
  },
  {
    value:
      'proxies:\n  - name: private-profile\n    server: secret.example.test\n    port: 443\n    uuid: 11111111-2222-4333-8444-555555555555\n    password: profile-password\nproxy-groups:\n  - name: private-group',
    fragments: [
      'private-profile',
      'secret.example.test',
      'profile-password',
      'private-group',
    ],
  },
  {
    value:
      '{"inbounds":[{"listen":"127.0.0.1","port":1080}],"outbounds":[{"server":"json-secret.example.test","password":"json-profile-password"}]}',
    fragments: ['json-secret.example.test', 'json-profile-password'],
  },
  {
    value:
      'mixed-port: 7890\nallow-lan: true\nexternal-controller: 127.0.0.1:9090\nsecret: controller-secret\ndns:\n  enable: true\nrules:\n  - MATCH,DIRECT',
    fragments: ['127.0.0.1:9090', 'controller-secret', 'MATCH,DIRECT'],
  },
  {
    value:
      'Authorization: Bearer bearer-token Cookie: sid=cookie-secret vless://11111111-2222-4333-8444-555555555555@node.example.test:443?shortId=abcdef12',
    fragments: [
      'bearer-token',
      'cookie-secret',
      '11111111-2222-4333-8444-555555555555',
      'abcdef12',
    ],
  },
]

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

  const module = { exports: {} }
  const tauriMocks = {
    getSystemInfo: async () => 'Windows 11 / XXLink test system',
    getAppUptime: async () => 42_000,
    getRunningMode: async () => 'rule',
    getRuntimeLogs: async () => ({
      default: [
        ['INFO', 'Runtime started'],
        ['WARN', 'Authorization: Bearer runtime-secret-token'],
      ],
    }),
    getClashLogs: async () => [
      {
        time: '06-29 12:00:00',
        type: 'info',
        payload:
          'profile vless://11111111-2222-4333-8444-555555555555@node.example:443?shortId=abcdef12',
      },
    ],
    ...(extraContext.tauriMocks ?? {}),
  }

  const mocks = {
    '@/services/cmds': tauriMocks,
    '@/services/auth-store': {
      authStore: {
        getState: () => ({
          isAuthenticated: true,
          accessToken: 'access-token-fixture',
          refreshToken: 'refresh-token-fixture',
          user: {
            id: '11111111-2222-4333-8444-555555555555',
            email: 'alice@example.test',
            role: 'USER',
          },
        }),
      },
    },
    '@/services/account-lkg-cache': {
      readAccountLkgCache: () => ({
        updatedAt: Date.parse('2026-06-29T11:55:00.000Z'),
        subscription: {
          status: 'ACTIVE',
          expireAt: '2026-07-29T00:00:00.000Z',
        },
        usage: {
          status: 'ACTIVE',
          expireAt: '2026-07-29T00:00:00.000Z',
          entitlement: {
            accessTier: 'PAID',
            nodeTier: 'PAID',
            speedLimitMbps: 150,
          },
        },
        nodes: [
          {
            id: 'node-secret-id',
            name: 'Tokyo paid node',
            protocol: 'vless',
            region: 'JP',
            isActive: true,
          },
        ],
      }),
    },
    '@root/package.json': { version: '2.4.15' },
    '@tauri-apps/plugin-clipboard-manager': {
      writeText: async (text) => {
        extraContext.clipboardText = text
      },
    },
  }

  vm.runInNewContext(outputText, {
    console,
    Date,
    exports: module.exports,
    localStorage: extraContext.localStorage,
    module,
    require: (specifier) => mocks[specifier] ?? require(specifier),
    URL,
    ...extraContext,
  })

  return module.exports
}

test('redaction removes forbidden diagnostics material from strings and objects', () => {
  const {
    diagnosticsJsonHasForbiddenMaterial,
    redactDiagnosticsValue,
    redactText,
  } = loadDiagnosticsModule()

  const unsafe =
    'Authorization: Bearer raw-access-token Cookie: sid=raw-cookie ' +
    'refreshToken=raw-refresh-token alice@example.test ' +
    'https://api.xxlink.net/subscription/clash/raw-subscription-token ' +
    'vless://11111111-2222-4333-8444-555555555555@host:443?shortId=abcdef12&privateKey=raw-private-key'

  const redacted = redactText(unsafe)
  assert.equal(redacted.includes('raw-access-token'), false)
  assert.equal(redacted.includes('raw-cookie'), false)
  assert.equal(redacted.includes('raw-refresh-token'), false)
  assert.equal(redacted.includes('alice@example.test'), false)
  assert.equal(redacted.includes('raw-subscription-token'), false)
  assert.equal(redacted.includes('11111111-2222-4333-8444-555555555555'), false)
  assert.equal(redacted.includes('raw-private-key'), false)
  assert.match(redacted, /\[REDACTED/)

  const redactedObject = redactDiagnosticsValue({
    accessToken: 'raw-access-token',
    nested: {
      authorization: 'Bearer raw-access-token',
      safeStatus: 'authenticated',
    },
  })
  const json = JSON.stringify(redactedObject)
  assert.equal(json.includes('raw-access-token'), false)
  assert.equal(json.includes('authenticated'), true)
  assert.equal(diagnosticsJsonHasForbiddenMaterial(json), false)
  assert.equal(diagnosticsJsonHasForbiddenMaterial(unsafe), true)

  for (const sample of HOSTILE_DIAGNOSTIC_SAMPLES) {
    const sanitized = redactText(sample.value)
    assert.equal(
      diagnosticsJsonHasForbiddenMaterial(sample.value),
      true,
      `forbidden gate missed: ${sample.value.slice(0, 40)}`,
    )
    assert.equal(diagnosticsJsonHasForbiddenMaterial(sanitized), false)
    for (const fragment of sample.fragments) {
      assert.equal(sanitized.includes(fragment), false)
    }
  }
})

test('diagnostics serialization drops complete hostile profiles while retaining metadata', () => {
  const { buildDiagnosticsBundle, diagnosticsJsonHasForbiddenMaterial } =
    loadDiagnosticsModule()
  const runtimeEntries = HOSTILE_DIAGNOSTIC_SAMPLES.map((sample, index) => [
    index === 0 ? 'WARN' : 'INFO',
    sample.value,
  ])
  runtimeEntries.push(['INFO', 'safe lifecycle metadata: retryable=false'])

  const bundle = buildDiagnosticsBundle({
    appVersion: '2.4.15',
    runningMode: 'rule',
    logs: { runtime: { default: runtimeEntries }, clash: [] },
  })
  const serialized = JSON.stringify(bundle)

  assert.equal(bundle.runtimeCore.runningMode, 'rule')
  assert.equal(bundle.logs.runtime.default.at(-1)?.[0], 'INFO')
  assert.equal(
    bundle.logs.runtime.default.at(-1)?.[1],
    'safe lifecycle metadata: retryable=false',
  )
  assert.equal(diagnosticsJsonHasForbiddenMaterial(serialized), false)
  for (const sample of HOSTILE_DIAGNOSTIC_SAMPLES) {
    for (const fragment of sample.fragments) {
      assert.equal(serialized.includes(fragment), false)
    }
  }
})

test('bundle shape contains only safe class/status fields', () => {
  const { buildDiagnosticsBundle, diagnosticsJsonHasForbiddenMaterial } =
    loadDiagnosticsModule()

  const bundle = buildDiagnosticsBundle(
    {
      appVersion: '2.4.15',
      systemInfo:
        'Windows 11\nUser alice@example.test\nAuthorization: Bearer bad-token',
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
      selectedNodeRaw: 'Tokyo paid node 11111111-2222-4333-8444-555555555555',
      profileGenerationRaw:
        '{"nodes":"node-secret:host:443","subscription":"https://api.xxlink.net/subscription/raw"}',
      lastSyncErrorRaw:
        '{"message":"sync failed for https://api.xxlink.net/subscription/raw","code":"TOKEN"}',
      logs: {
        runtime: {
          default: [['WARN', 'shortId=abcdef12 privateKey=raw-private-key']],
        },
        clash: [
          {
            time: '06-29 12:00:00',
            type: 'warning',
            payload: 'vless://11111111-2222-4333-8444-555555555555@host:443',
          },
        ],
      },
    },
    { now: () => new Date('2026-06-29T12:00:00.000Z') },
  )

  assert.equal(bundle.schemaVersion, 1)
  assert.equal(bundle.exportedAt, '2026-06-29T12:00:00.000Z')
  assert.equal(bundle.app.version, '2.4.15')
  assert.equal(bundle.authSession.status, 'authenticated')
  assert.equal(bundle.authSession.accessToken, 'present')
  assert.equal(bundle.authSession.refreshToken, 'present')
  assert.equal(bundle.selectedNode.status, 'selected')
  assert.equal(bundle.profileGeneration.status, 'present')
  assert.equal(bundle.nodeSync.status, 'error')
  assert.equal(bundle.runtimeCore.runningMode, 'rule')
  assert.equal(bundle.dataPlane.status, 'not-tested')

  const json = JSON.stringify(bundle)
  assert.equal(json.includes('alice@example.test'), false)
  assert.equal(json.includes('bad-token'), false)
  assert.equal(json.includes('raw-private-key'), false)
  assert.equal(json.includes('11111111-2222-4333-8444-555555555555'), false)
  assert.equal(json.includes('https://api.xxlink.net/subscription/raw'), false)
  assert.equal(diagnosticsJsonHasForbiddenMaterial(json), false)
})

test('log samples are tailed and redacted before export', () => {
  const { buildDiagnosticsBundle } = loadDiagnosticsModule()

  const clash = Array.from({ length: 65 }, (_, index) => ({
    time: `06-29 12:${String(index).padStart(2, '0')}:00`,
    type: 'info',
    payload: `line-${index} Cookie: session=${index}`,
  }))

  const bundle = buildDiagnosticsBundle(
    {
      appVersion: '2.4.15',
      logs: { clash, runtime: {} },
    },
    { now: () => new Date('2026-06-29T12:00:00.000Z'), maxLogItems: 50 },
  )

  assert.equal(bundle.logs.clash.length, 50)
  assert.equal(bundle.logs.clash[0]?.payload.includes('line-15'), true)
  assert.equal(JSON.stringify(bundle.logs).includes('session=64'), false)
})

test('runtime collector copies a serializable redacted bundle to clipboard', async () => {
  const extraContext = {
    clipboardText: '',
    localStorage: {
      getItem(key) {
        const values = {
          'clash-verge-selected-proxy':
            'Selected 11111111-2222-4333-8444-555555555555',
          'xxlink:subscription-profile-generation':
            '{"nodes":"raw-node-secret"}',
          'xxlink:last-sync-error':
            '{"message":"sync failed for refreshToken=raw-refresh-token","code":"SYNC"}',
          'xxlink:last-update-check': '2026-06-29T10:00:00.000Z',
        }
        return values[key] ?? null
      },
    },
    tauriMocks: {
      getRuntimeLogs: async () => ({
        default: HOSTILE_DIAGNOSTIC_SAMPLES.map((sample) => [
          'WARN',
          sample.value,
        ]),
      }),
    },
  }
  const {
    copyDiagnosticsBundleToClipboard,
    diagnosticsJsonHasForbiddenMaterial,
  } = loadDiagnosticsModule(extraContext)

  const bundle = await copyDiagnosticsBundleToClipboard({
    now: () => new Date('2026-06-29T12:00:00.000Z'),
  })

  assert.equal(bundle.app.version, '2.4.15')
  assert.equal(bundle.selectedNode.status, 'selected')
  assert.equal(bundle.profileGeneration.status, 'present')
  assert.equal(bundle.nodeSync.status, 'error')
  assert.equal(extraContext.clipboardText.length > 0, true)
  assert.equal(
    JSON.stringify(JSON.parse(extraContext.clipboardText)),
    JSON.stringify(bundle),
  )
  assert.equal(extraContext.clipboardText.includes('raw-refresh-token'), false)
  assert.equal(
    extraContext.clipboardText.includes('11111111-2222-4333-8444-555555555555'),
    false,
  )
  assert.equal(
    diagnosticsJsonHasForbiddenMaterial(extraContext.clipboardText),
    false,
  )
  for (const sample of HOSTILE_DIAGNOSTIC_SAMPLES) {
    for (const fragment of sample.fragments) {
      assert.equal(extraContext.clipboardText.includes(fragment), false)
    }
  }
})
