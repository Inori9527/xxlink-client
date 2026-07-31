import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import test from 'node:test'
import ts from 'typescript'
import vm from 'node:vm'

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
    throw new Error(`Unexpected runtime import in focused test: ${specifier}`)
  }

  const wrapped = `(function (exports, require, module) {\n${outputText}\n})`
  const fn = vm.runInNewContext(
    wrapped,
    {
      console,
      setTimeout,
      clearTimeout,
      URL,
    },
    { filename: absolutePath },
  )
  fn(module.exports, requireForModule, module)
  return module.exports
}

function loadReadinessModule(stubs = {}) {
  return loadTsModule('src/services/selected-node-readiness.ts', {
    '@/services/runtime-node-controller': {
      runtimeNodeController: {
        probeDelay: async () => 42,
      },
    },
    ...stubs,
  })
}

function loadLatencyModule() {
  return loadTsModule('src/services/node-latency-display.ts')
}

test('selected node is connected only after runtime and readiness pass', () => {
  const readiness = loadReadinessModule()

  assert.equal(readiness.isSelectedNodeConnected(false, 'ready'), false)
  assert.equal(readiness.isSelectedNodeConnected(true, 'connecting'), false)
  assert.equal(readiness.isSelectedNodeConnected(true, 'validating'), false)
  assert.equal(readiness.isSelectedNodeConnected(true, 'failed'), false)
  assert.equal(readiness.isSelectedNodeConnected(true, 'ready'), true)
})

test('node latency display is simple ms or timeout', () => {
  const latency = loadLatencyModule()

  const ok = latency.getNodeLatencyDisplay(88, 6000)
  assert.equal(ok.kind, 'ms')
  assert.equal(ok.value, 88)
  assert.equal(latency.getNodeLatencyDisplay(0, 6000).kind, 'timeout')
  assert.equal(latency.getNodeLatencyDisplay(6000, 6000).kind, 'timeout')
  assert.equal(latency.getNodeLatencyDisplay(-1, 6000).kind, 'unknown')
  assert.equal(
    latency.formatNodeLatencyLabel(88, 6000, {
      timeout: 'Timeout',
      unknown: '-',
    }),
    '88 ms',
  )
  assert.equal(
    latency.formatNodeLatencyLabel(0, 6000, {
      timeout: 'Timeout',
      unknown: '-',
    }),
    'Timeout',
  )
})

test('readiness probes use selected proxy targets and never api.xxlink.net', async () => {
  const calls = []
  const readiness = loadReadinessModule()

  assert.ok(readiness.SELECTED_NODE_READINESS_PROBE_URLS.length >= 2)
  assert.ok(
    readiness.SELECTED_NODE_READINESS_PROBE_URLS.some((url) =>
      url.startsWith('http://'),
    ),
  )
  assert.ok(
    readiness.SELECTED_NODE_READINESS_PROBE_URLS.some((url) =>
      url.startsWith('https://'),
    ),
  )
  assert.equal(
    readiness.SELECTED_NODE_READINESS_PROBE_URLS.some((url) =>
      new URL(url).hostname.endsWith('xxlink.net'),
    ),
    false,
  )
  assert.equal(
    readiness.isReadinessProbeTargetSafe('https://api.xxlink.net./health'),
    false,
  )
  assert.equal(
    readiness.isReadinessProbeTargetSafe(
      'https://edge.xxlink.net./generate_204',
    ),
    false,
  )
  assert.equal(
    readiness.isReadinessProbeTargetSafe('https://example.com/generate_204'),
    false,
  )

  const result = await readiness.checkSelectedNodeReadiness({
    proxyName: '东京-免费/轻量-01',
    probe: async (proxyName, url, timeoutMs) => {
      calls.push({ proxyName, url, timeoutMs })
      return { delay: 88 }
    },
  })

  assert.equal(result.ok, true)
  assert.deepEqual(
    calls.map((call) => call.url),
    [...readiness.SELECTED_NODE_READINESS_PROBE_URLS],
  )
  assert.equal(
    calls.every((call) => call.proxyName === '东京-免费/轻量-01'),
    true,
  )
})

test('readiness failure keeps selected node and blocks false connected state', async () => {
  const readiness = loadReadinessModule()
  const selectedNode = '日本-ISP专线-01'

  const result = await readiness.checkSelectedNodeReadiness({
    proxyName: selectedNode,
    probe: async () => ({ delay: 0 }),
  })

  assert.equal(result.ok, false)
  assert.equal(readiness.isSelectedNodeConnected(true, 'failed'), false)
  assert.equal(
    readiness.shouldAutoSelectNode({
      runtimeConnected: true,
      groupName: 'GLOBAL',
      nodeCount: 6,
      currentSelectionValid: false,
    }),
    false,
  )
  assert.equal(selectedNode, '日本-ISP专线-01')
})

test('readiness probe failure keeps runtime enabled without false connected state', () => {
  const readiness = loadReadinessModule()

  const payload = readiness.getReadinessFailureDisconnectPayload()
  assert.equal(payload.enable_tun_mode, false)
  assert.equal(payload.enable_system_proxy, false)
  assert.equal(readiness.shouldDisplayReadinessFailure('failed', false), true)
  assert.equal(readiness.shouldDisplayReadinessFailure('ready', false), false)
  assert.equal('shouldDisplayReadinessWarning' in readiness, false)
  assert.equal(
    readiness.shouldDisplayReadinessFailure('disconnected', true),
    true,
  )
  assert.equal(
    readiness.shouldDisplayReadinessFailure('disconnected', false),
    false,
  )
  assert.equal(readiness.shouldShowReadinessRetryAction(true, 'failed'), true)
  assert.equal(readiness.shouldShowReadinessRetryAction(true, 'ready'), false)
  assert.equal(readiness.shouldShowReadinessRetryAction(false, 'failed'), false)
})

test('readiness gate preserves account state ownership and disconnected self-heal', () => {
  const readiness = loadReadinessModule()
  const source = readFileSync(
    resolve(repoRoot, 'src/services/selected-node-readiness.ts'),
    'utf8',
  )

  assert.equal(source.includes('account-lkg-cache'), false)
  assert.equal(source.includes('auth-store'), false)
  assert.equal(source.includes('localStorage'), false)
  assert.equal(source.includes('refreshAccountState'), false)
  assert.equal(
    readiness.shouldAutoSelectNode({
      runtimeConnected: false,
      groupName: 'GLOBAL',
      nodeCount: 6,
      currentSelectionValid: false,
    }),
    true,
  )
  assert.equal(
    readiness.shouldAutoSelectNode({
      runtimeConnected: false,
      groupName: 'GLOBAL',
      nodeCount: 6,
      currentSelectionValid: true,
    }),
    false,
  )
})

test('manual retry reruns bounded readiness probes', async () => {
  const readiness = loadReadinessModule()
  let attempts = 0

  const first = await readiness.checkSelectedNodeReadiness({
    proxyName: '香港-付费-01',
    probe: async () => {
      attempts += 1
      return { delay: 0 }
    },
  })
  const second = await readiness.checkSelectedNodeReadiness({
    proxyName: '香港-付费-01',
    probe: async () => {
      attempts += 1
      return { delay: 70 }
    },
  })

  assert.equal(first.ok, false)
  assert.equal(second.ok, true)
  assert.equal(
    attempts,
    readiness.SELECTED_NODE_READINESS_PROBE_URLS.length * 2,
  )
})

test('probe timeout does not stop or switch the selected route', () => {
  const source = readFileSync(
    resolve(repoRoot, 'src/pages/connect.tsx'),
    'utf8',
  )

  assert.equal(source.includes('const next = !runtimeConnected'), true)
  assert.equal(source.includes('stopFailedReadinessConnection'), true)
  assert.equal(
    source.includes(
      'runtimeActionController.setConnectionEnabled(mode, false)',
    ),
    true,
  )
  const stopBlock = source.slice(
    source.indexOf('const stopFailedReadinessConnection'),
    source.indexOf('const validateSelectedNodeReadiness'),
  )
  assert.equal(stopBlock.includes('changeProxy('), false)
  const resultBlockStart = source.indexOf(
    'const result = await checkSelectedNodeReadiness',
  )
  const probeFailureBlock = source.slice(
    resultBlockStart,
    source.indexOf('  }, [', resultBlockStart),
  )
  assert.equal(
    probeFailureBlock.includes('stopFailedReadinessConnection'),
    false,
  )
  const readinessFailureBranch = probeFailureBlock.slice(
    probeFailureBlock.indexOf("setReadinessStatus('failed')"),
  )
  assert.equal(
    readinessFailureBranch.includes("setReadinessStatus('ready')"),
    false,
  )
  assert.equal(
    readinessFailureBranch.includes("setReadinessStatus('failed')"),
    true,
  )
  assert.equal(source.includes('selectedNodeProbeWarning'), false)
  assert.equal(source.includes('showReadinessRetryAction'), true)
  assert.equal(source.includes('layout.components.connect.actions.retry'), true)
  assert.equal(source.includes('onClick={validateSelectedNodeReadiness}'), true)
})

test('readiness failure copy is localized for Chinese and English', () => {
  const zh = JSON.parse(
    readFileSync(resolve(repoRoot, 'src/locales/zh/layout.json'), 'utf8'),
  )
  const en = JSON.parse(
    readFileSync(resolve(repoRoot, 'src/locales/en/layout.json'), 'utf8'),
  )

  assert.equal(
    zh.components.connect.feedback.selectedNodeFailed,
    '该节点连接失败，请切换其他节点或稍后重试',
  )
  assert.equal(
    en.components.connect.feedback.selectedNodeFailed,
    'This node failed to connect. Switch to another node or try again later.',
  )
  assert.equal(
    'selectedNodeProbeWarning' in zh.components.connect.feedback,
    false,
  )
  assert.equal(
    'selectedNodeProbeWarning' in en.components.connect.feedback,
    false,
  )
})
