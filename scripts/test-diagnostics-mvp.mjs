import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
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
      'proxy socks5://socks-user:socks-password@proxy.example.test:1080/path',
    fragments: ['socks-user', 'socks-password', 'proxy.example.test'],
  },
  {
    value:
      '- name: standalone-private-proxy\n  type: socks5\n  server: standalone.example.test\n  port: 1080\n  username: standalone-user\n  password: standalone-password',
    fragments: [
      'standalone-private-proxy',
      'standalone.example.test',
      'standalone-user',
      'standalone-password',
    ],
  },
  {
    value:
      '- name: credential-free-private-proxy\n  type: trojan\n  server: credential-free.example.test\n  port: 443',
    fragments: [
      'credential-free-private-proxy',
      'credential-free.example.test',
    ],
  },
  {
    value:
      '{"name":"json-private-proxy","type":"http","server":"json-standalone.example.test","port":8080,"username":"json-user","password":"json-password"}',
    fragments: [
      'json-private-proxy',
      'json-standalone.example.test',
      'json-user',
      'json-password',
    ],
  },
  {
    value:
      '{name: flow-private-proxy, type: socks5, server: flow.example.test, port: 1080, user: flow-user-sentinel, pass: flow-pass-sentinel}',
    fragments: [
      'flow-private-proxy',
      'flow.example.test',
      'flow-user-sentinel',
      'flow-pass-sentinel',
    ],
  },
  {
    value:
      "{'name': 'quoted-flow-private-proxy', 'type': 'http', 'server': 'quoted-flow.example.test', 'port': 8080, 'user': 'quoted-flow-user-sentinel', 'pass': 'quoted-flow-pass-sentinel'}",
    fragments: [
      'quoted-flow-private-proxy',
      'quoted-flow.example.test',
      'quoted-flow-user-sentinel',
      'quoted-flow-pass-sentinel',
    ],
  },
  {
    value:
      'request https://api.example.test/path?token=query-token&api_key=query-api-key&safe=metadata',
    fragments: ['query-token', 'query-api-key'],
  },
  {
    value:
      'request https://api.example.test/path?user=query-user-sentinel&pass=query-pass-sentinel&UsEr=query-case-user-sentinel&PaSs=query-case-pass-sentinel&safe=metadata',
    fragments: [
      'query-user-sentinel',
      'query-pass-sentinel',
      'query-case-user-sentinel',
      'query-case-pass-sentinel',
    ],
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

const RANDOM_SENTINELS = Array.from(
  { length: 12 },
  () => `random-sentinel-${randomBytes(12).toString('hex')}`,
)

const assertOriginalsAbsent = (serialized) => {
  for (const sample of HOSTILE_DIAGNOSTIC_SAMPLES) {
    assert.equal(serialized.includes(sample.value), false)
    for (const fragment of sample.fragments) {
      assert.equal(serialized.includes(fragment), false)
    }
  }
  for (const sentinel of RANDOM_SENTINELS) {
    assert.equal(serialized.includes(sentinel), false)
  }
}

test('bundle serializes metadata only for arbitrary strings, errors, profiles, and logs', () => {
  const { buildDiagnosticsBundle, diagnosticsJsonHasForbiddenMaterial } =
    loadDiagnosticsModule()

  const runtimeEntries = [
    ...HOSTILE_DIAGNOSTIC_SAMPLES.map((sample, index) => [
      index === 0 ? 'WARN' : 'INFO',
      `component wrapper ${sample.value}`,
    ]),
    ...RANDOM_SENTINELS.map((sentinel) => [
      'ERROR',
      new Error(`prefixed worker failure ${sentinel}`),
    ]),
    ['INFO', { arbitrary: { payload: RANDOM_SENTINELS[0] } }],
  ]

  const bundle = buildDiagnosticsBundle(
    {
      appVersion: '2.4.15',
      systemInfo: `Windows 11\nUser alice@example.test\n${RANDOM_SENTINELS[0]}`,
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
      lastSyncErrorRaw: `worker failed: ${RANDOM_SENTINELS[1]} https://api.xxlink.net/subscription/raw`,
      logs: {
        runtime: {
          [RANDOM_SENTINELS[2]]: runtimeEntries,
        },
        clash: [
          {
            time: '06-29 12:00:00',
            type: 'warning',
            payload: `prefixed log ${RANDOM_SENTINELS[3]} socks5://user:pass@host:1080`,
          },
          ...HOSTILE_DIAGNOSTIC_SAMPLES.map((sample) => sample.value),
        ],
      },
    },
    { now: () => new Date('2026-06-29T12:00:00.000Z') },
  )

  assert.equal(bundle.schemaVersion, 1)
  assert.equal(bundle.exportedAt, '2026-06-29T12:00:00.000Z')
  assert.equal(bundle.app.version, '2.4.15')
  assert.equal(bundle.system.platform, 'windows')
  assert.equal(bundle.authSession.status, 'authenticated')
  assert.equal(bundle.authSession.accessToken, 'present')
  assert.equal(bundle.authSession.refreshToken, 'present')
  assert.equal(bundle.selectedNode.status, 'selected')
  assert.equal(bundle.profileGeneration.status, 'present')
  assert.equal(bundle.nodeSync.status, 'error')
  assert.equal(bundle.runtimeCore.runningMode, 'rule')
  assert.equal(bundle.dataPlane.status, 'not-tested')
  assert.equal(bundle.logs.runtime.source, 'runtime')
  assert.equal(bundle.logs.runtime.componentCount, 1)
  assert.equal(bundle.logs.runtime.totalCount, runtimeEntries.length)
  assert.equal(bundle.logs.clash.source, 'clash')
  assert.equal(
    bundle.logs.clash.totalCount,
    HOSTILE_DIAGNOSTIC_SAMPLES.length + 1,
  )

  const serialized = JSON.stringify(bundle)
  assertOriginalsAbsent(serialized)
  assert.equal(serialized.includes('alice@example.test'), false)
  assert.equal(serialized.includes('Tokyo paid node'), false)
  assert.equal(serialized.includes('node-secret'), false)
  assert.equal(serialized.includes('api.xxlink.net'), false)
  assert.equal(serialized.includes('prefixed worker failure'), false)
  assert.equal(serialized.includes('component wrapper'), false)
  assert.equal(diagnosticsJsonHasForbiddenMaterial(serialized), false)
})

test('log summaries bound inspected entries and count limit plus one without retaining lines', () => {
  const { buildDiagnosticsBundle } = loadDiagnosticsModule()
  const limit = 50

  const clash = Array.from({ length: limit + 1 }, (_, index) => ({
    time: `06-29 12:${String(index).padStart(2, '0')}:00`,
    type: 'info',
    payload: `line-${index}-${RANDOM_SENTINELS[index % RANDOM_SENTINELS.length]}`,
  }))
  const runtime = Array.from({ length: limit + 1 }, (_, index) => [
    index % 2 === 0 ? 'WARN' : 'INFO',
    `prefixed-${index}-${RANDOM_SENTINELS[index % RANDOM_SENTINELS.length]}`,
  ])

  const bundle = buildDiagnosticsBundle(
    {
      appVersion: '2.4.15',
      logs: { clash, runtime: { default: runtime } },
    },
    {
      now: () => new Date('2026-06-29T12:00:00.000Z'),
      maxLogItems: limit,
    },
  )

  for (const summary of [bundle.logs.runtime, bundle.logs.clash]) {
    assert.equal(summary.totalCount, limit + 1)
    assert.equal(summary.inspectedCount, limit)
    assert.equal(summary.omittedCount, 1)
  }
  const serialized = JSON.stringify(bundle.logs)
  assert.equal(serialized.includes('line-'), false)
  assert.equal(serialized.includes('prefixed-'), false)
  assertOriginalsAbsent(serialized)
})

test('unrecognized, oversized, structured, and prefixed log inputs become closed counters', () => {
  const { buildDiagnosticsBundle } = loadDiagnosticsModule()
  const oversized = `${'x'.repeat(1025)}${RANDOM_SENTINELS[6]}`
  const flowYaml = HOSTILE_DIAGNOSTIC_SAMPLES[5].value
  const socksCredential = HOSTILE_DIAGNOSTIC_SAMPLES[1].value
  const httpCredential = HOSTILE_DIAGNOSTIC_SAMPLES[0].value
  const prefixed = `worker lifecycle changed ${RANDOM_SENTINELS[7]}`

  const bundle = buildDiagnosticsBundle({
    appVersion: '2.4.15',
    logs: {
      runtime: {
        default: [
          ['INFO', { wrapper: RANDOM_SENTINELS[8] }],
          ['WARN', oversized],
          ['WARN', flowYaml],
          ['ERROR', socksCredential],
          ['ERROR', httpCredential],
          ['INFO', prefixed],
        ],
      },
    },
  })

  assert.equal(bundle.logs.runtime.categories.unrecognized, 1)
  assert.equal(bundle.logs.runtime.categories.oversized, 1)
  assert.equal(bundle.logs.runtime.categories['structured-or-sensitive'], 3)
  assert.equal(bundle.logs.runtime.categories.other, 1)
  const serialized = JSON.stringify(bundle)
  assert.equal(serialized.includes(oversized), false)
  assert.equal(serialized.includes(flowYaml), false)
  assert.equal(serialized.includes(socksCredential), false)
  assert.equal(serialized.includes(httpCredential), false)
  assert.equal(serialized.includes(prefixed), false)
  assertOriginalsAbsent(serialized)
})

test('runtime collector copies only metadata and no hostile sentinel reaches clipboard', async () => {
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
        [RANDOM_SENTINELS[4]]: [
          ...HOSTILE_DIAGNOSTIC_SAMPLES.map((sample) => [
            'WARN',
            `runtime prefix ${sample.value}`,
          ]),
          ...RANDOM_SENTINELS.map((sentinel) => ['ERROR', new Error(sentinel)]),
        ],
      }),
      getClashLogs: async () =>
        HOSTILE_DIAGNOSTIC_SAMPLES.map((sample) => ({
          time: RANDOM_SENTINELS[5],
          type: 'warning',
          payload: sample.value,
        })),
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
  assertOriginalsAbsent(extraContext.clipboardText)
  assert.equal(extraContext.clipboardText.includes('runtime prefix'), false)
  assert.equal(extraContext.clipboardText.includes('raw-refresh-token'), false)
  assert.equal(extraContext.clipboardText.includes('raw-node-secret'), false)
  assert.equal(
    diagnosticsJsonHasForbiddenMaterial(extraContext.clipboardText),
    false,
  )
})

test('clipboard final gate rejects a forced invalid value before invoking writer', async () => {
  const { writeDiagnosticsJsonToClipboard } = loadDiagnosticsModule()
  let writes = 0

  await assert.rejects(
    () =>
      writeDiagnosticsJsonToClipboard(
        JSON.stringify({ schemaVersion: 1, forced: RANDOM_SENTINELS[0] }),
        async () => {
          writes++
        },
      ),
    /forbidden material/i,
  )
  assert.equal(writes, 0)
})

test('metadata-only diagnostics source has no free-form parser dependency', () => {
  const source = fs.readFileSync(
    path.join(repoRoot, 'src/services/diagnostics-bundle.ts'),
    'utf8',
  )
  assert.doesNotMatch(source, /from ['"]js-yaml['"]/)
  assert.doesNotMatch(source, /redactText|redactDiagnosticsValue|parseYaml/)
})
