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
  if (!existsSync(absolutePath))
    throw new Error(`Missing module: ${relativePath}`)

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
    { console, setTimeout, clearTimeout, URL },
    { filename: absolutePath },
  )
  fn(module.exports, requireForModule, module)
  return module.exports
}

function loadReadinessModule() {
  return loadTsModule('src/services/selected-node-readiness.ts', {
    '@/services/runtime-node-controller': {
      runtimeNodeController: { probeDelay: async () => 42 },
    },
  })
}

test('selected node remains operational while inconclusive probes stay visible', () => {
  const readiness = loadReadinessModule()

  assert.equal(readiness.isSelectedNodeConnected(false, 'ready'), false)
  assert.equal(readiness.isSelectedNodeConnected(true, 'connecting'), false)
  assert.equal(readiness.isSelectedNodeConnected(true, 'validating'), false)
  assert.equal(readiness.isSelectedNodeConnected(true, 'failed'), false)
  assert.equal(readiness.isSelectedNodeConnected(true, 'ready'), true)
  assert.equal(readiness.isSelectedNodeConnected(true, 'degraded'), true)
})

test('readiness probes use fixed safe targets and never xxlink.net', async () => {
  const calls = []
  const readiness = loadReadinessModule()

  assert.ok(readiness.SELECTED_NODE_READINESS_PROBE_URLS.length >= 2)
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
    readiness.isReadinessProbeTargetSafe('https://example.com/generate_204'),
    false,
  )

  const result = await readiness.checkSelectedNodeReadiness({
    proxyName: 'synthetic-selected-node',
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
    calls.every((call) => call.proxyName === 'synthetic-selected-node'),
    true,
  )
})

test('timeout and probe errors are non-blocking readiness evidence', async () => {
  const readiness = loadReadinessModule()
  const timeoutResult = await readiness.checkSelectedNodeReadiness({
    proxyName: 'synthetic-selected-node',
    probe: async () => ({ delay: 0 }),
  })
  const errorResult = await readiness.checkSelectedNodeReadiness({
    proxyName: 'synthetic-selected-node',
    probe: async () => {
      throw new Error('synthetic_probe_failure')
    },
  })

  assert.equal(timeoutResult.ok, false)
  assert.equal(errorResult.ok, false)
  assert.equal(readiness.isReadinessFailureNonBlocking('timeout'), true)
  assert.equal(readiness.isReadinessFailureNonBlocking('probe-error'), true)
  assert.equal(
    readiness.resolveSelectedNodeReadinessStatus(timeoutResult),
    'degraded',
  )
  assert.equal(
    readiness.resolveSelectedNodeReadinessStatus(errorResult),
    'degraded',
  )
  assert.equal(readiness.shouldShowReadinessRetryAction(true, 'degraded'), true)
})

test('missing proxy and unsafe target remain blocking', async () => {
  const readiness = loadReadinessModule()
  const missing = await readiness.checkSelectedNodeReadiness({ proxyName: '' })
  const unsafe = await readiness.checkSelectedNodeReadiness({
    proxyName: 'synthetic-selected-node',
    probeUrls: ['https://example.com/generate_204'],
  })

  assert.equal(readiness.isReadinessFailureNonBlocking('missing-proxy'), false)
  assert.equal(readiness.isReadinessFailureNonBlocking('unsafe-target'), false)
  assert.equal(readiness.resolveSelectedNodeReadinessStatus(missing), 'failed')
  assert.equal(readiness.resolveSelectedNodeReadinessStatus(unsafe), 'failed')
})

test('an empty readiness target list remains blocking', async () => {
  const readiness = loadReadinessModule()
  const result = await readiness.checkSelectedNodeReadiness({
    proxyName: 'Synthetic node',
    probeUrls: [],
  })

  assert.equal(result.ok, false)
  assert.equal(result.reason, 'missing-probe')
  assert.equal(readiness.resolveSelectedNodeReadinessStatus(result), 'failed')
})

test('manual retry reruns bounded readiness probes', async () => {
  const readiness = loadReadinessModule()
  let attempts = 0
  const run = (delay) =>
    readiness.checkSelectedNodeReadiness({
      proxyName: 'synthetic-selected-node',
      probe: async () => {
        attempts += 1
        return { delay }
      },
    })

  assert.equal((await run(0)).ok, false)
  assert.equal((await run(70)).ok, true)
  assert.equal(
    attempts,
    readiness.SELECTED_NODE_READINESS_PROBE_URLS.length * 2,
  )
})

test('connect page does not auto-select, switch, or stop on probe timeout', () => {
  const source = readFileSync(
    resolve(repoRoot, 'src/pages/connect.tsx'),
    'utf8',
  )
  const resultBlockStart = source.indexOf(
    'const result = await checkSelectedNodeReadiness',
  )
  const probeResultBlock = source.slice(
    resultBlockStart,
    source.indexOf('  }, [', resultBlockStart),
  )

  assert.ok(resultBlockStart >= 0)
  assert.equal(source.includes('shouldAutoSelectNode'), false)
  assert.equal(source.includes('nodeEntries[0]'), false)
  assert.equal(
    probeResultBlock.includes('resolveSelectedNodeReadinessStatus(result)'),
    true,
  )
  assert.equal(
    probeResultBlock.includes('stopFailedReadinessConnection'),
    false,
  )
})

test('readiness gate remains independent from account and auth state', () => {
  const source = readFileSync(
    resolve(repoRoot, 'src/services/selected-node-readiness.ts'),
    'utf8',
  )

  assert.equal(source.includes('account-lkg-cache'), false)
  assert.equal(source.includes('auth-store'), false)
  assert.equal(source.includes('localStorage'), false)
  assert.equal(source.includes('refreshAccountState'), false)
})
