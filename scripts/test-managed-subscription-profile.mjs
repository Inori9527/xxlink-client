import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import test from 'node:test'

import ts from 'typescript'

// PROVES:         Part executed, part source text. One of the five tests genuinely
//                 executes the code under test.
// DOES NOT PROVE: That managed-subscription-profile.ts works, or even runs — nothing in
//                 the file imports or calls the adapter, so the three exported
//                 functions are parsed but never invoked, and a green run says nothing
//                 about ...

const repoRoot = resolve(import.meta.dirname, '..')
const adapterPath = resolve(
  repoRoot,
  'src/services/managed-subscription-profile.ts',
)

function readSource(relativePath) {
  return readFileSync(resolve(repoRoot, relativePath), 'utf8')
}

function parseSource(path, source) {
  return ts.createSourceFile(
    path,
    source,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  )
}

function hasModifier(node, kind) {
  return node.modifiers?.some((modifier) => modifier.kind === kind) ?? false
}

function loadSubscriptionSync(mocks) {
  const source = readSource('src/services/subscription-sync.ts')
  const compiled = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
    },
  }).outputText
  const module = { exports: {} }
  const window = {
    setTimeout(callback, timeoutMs) {
      return setTimeout(callback, timeoutMs).unref()
    },
  }

  Function(
    'require',
    'module',
    'exports',
    'window',
    compiled,
  )(
    (specifier) => {
      assert.equal(specifier, '@/services/managed-subscription-profile')
      return mocks
    },
    module,
    module.exports,
    window,
  )
  return module.exports
}

test('managed subscription adapter exports only opaque void operations', () => {
  assert.equal(
    existsSync(adapterPath),
    true,
    'managed subscription profile adapter is missing',
  )

  const source = readFileSync(adapterPath, 'utf8')
  const sourceFile = parseSource(adapterPath, source)
  const exportedStatements = sourceFile.statements.filter((statement) =>
    hasModifier(statement, ts.SyntaxKind.ExportKeyword),
  )

  assert.equal(
    exportedStatements.every(ts.isFunctionDeclaration),
    true,
    'adapter must not export profile, URL, or implementation types/values',
  )

  const exportedFunctions = exportedStatements.filter(ts.isFunctionDeclaration)
  assert.deepEqual(
    exportedFunctions.map((declaration) => declaration.name?.text).sort(),
    [
      'ensureManagedSubscriptionProfile',
      'rebuildManagedSubscriptionProfile',
      'refreshManagedSubscriptionProfile',
    ],
  )

  for (const declaration of exportedFunctions) {
    assert.equal(declaration.parameters.length, 0)
    assert.equal(declaration.type?.getText(sourceFile), 'Promise<void>')

    const valueReturns = []
    const visit = (node) => {
      if (ts.isReturnStatement(node) && node.expression) {
        valueReturns.push(node.expression.getText(sourceFile))
      }
      ts.forEachChild(node, visit)
    }
    visit(declaration.body)
    assert.deepEqual(
      valueReturns,
      [],
      `${declaration.name?.text} must not return URLs, profiles, or content`,
    )
  }
})

test('subscription sync retains orchestration and delegates managed profile work', () => {
  const source = readSource('src/services/subscription-sync.ts')
  const sourceFile = parseSource('subscription-sync.ts', source)
  const imports = sourceFile.statements.filter(ts.isImportDeclaration)
  const serviceImports = imports.map((declaration) =>
    declaration.moduleSpecifier.getText(sourceFile).slice(1, -1),
  )

  assert.deepEqual(serviceImports, ['@/services/managed-subscription-profile'])
  assert.match(source, /refreshManagedSubscriptionProfile\(\)/)
  assert.match(source, /rebuildManagedSubscriptionProfile\(\)/)
  assert.doesNotMatch(
    source,
    /\b(?:api|getSubUrl|getProfiles|importProfile|updateProfile|deleteProfile|patchProfile|patchProfilesConfig)\b/,
  )
  assert.match(source, /if \(inflight\)/)
  assert.match(source, /forcedFollowup/)
  assert.match(source, /Promise\.race\(\[work, timeout\]\)/)
  assert.match(source, /options\?\.timeoutMs \?\? 15_000/)
})

test('force sync queued during regular sync runs one forced follow-up', async () => {
  let finishRefresh
  let refreshCount = 0
  let rebuildCount = 0
  const { syncSubscription } = loadSubscriptionSync({
    refreshManagedSubscriptionProfile() {
      refreshCount += 1
      return new Promise((resolve) => {
        finishRefresh = resolve
      })
    },
    async rebuildManagedSubscriptionProfile() {
      rebuildCount += 1
    },
  })

  const regular = syncSubscription({ timeoutMs: 100 })
  const forced = syncSubscription({ force: true, timeoutMs: 100 })
  const coalescedForced = syncSubscription({ force: true, timeoutMs: 100 })

  assert.equal(refreshCount, 1)
  assert.equal(rebuildCount, 0)
  finishRefresh()
  await Promise.all([regular, forced, coalescedForced])
  assert.equal(rebuildCount, 1)
})

test('managed profile sources never log or return raw failure details', () => {
  const sources = [
    'src/services/managed-subscription-profile.ts',
    'src/services/subscription-sync.ts',
  ].map((relativePath) => [relativePath, readSource(relativePath)])

  for (const [relativePath, source] of sources) {
    assert.doesNotMatch(
      source,
      /console\.(?:warn|error)\s*\(/,
      `${relativePath} must use safe failure classification`,
    )
    assert.doesNotMatch(source, /\b(?:err|error)\.message\b/)
    assert.equal(source.includes('catch(console.error)'), false)
    assert.doesNotMatch(
      source,
      /console\.log\s*\([^)]*\b(?:url|subUrl|profile(?:sConfig)?)\b/i,
    )
  }

  const adapterSource = sources[0][1]
  assert.match(adapterSource, /backendController\.syncManagedSubscription/)
  assert.doesNotMatch(adapterSource, /catch\s*\([^)]*\)/)
})

test('Plans keeps dashboard recharge behavior outside the adapter change', () => {
  const source = readSource('src/pages/plans.tsx')

  assert.match(source, /https:\/\/xxlink\.net\/dashboard\/recharge/)
  assert.equal(source.includes('/payment/subscription/checkout'), false)
})
