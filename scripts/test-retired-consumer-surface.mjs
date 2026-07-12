import assert from 'node:assert/strict'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { dirname, posix, relative, resolve } from 'node:path'
import test from 'node:test'

const repoRoot = resolve(import.meta.dirname, '..')
const sourceRoot = resolve(repoRoot, 'src')

const retiredPaths = [
  'src/pages/home.tsx',
  'src/pages/profiles.tsx',
  'src/pages/proxies.tsx',
  'src/pages/connections.tsx',
  'src/pages/rules.tsx',
  'src/pages/unlock.tsx',
  'src/pages/settings.tsx',
  'src/pages/logs.tsx',
  'src/pages/api-keys.tsx',
  'src/components/home',
  'src/components/connection',
  'src/components/rule',
  'src/components/proxy',
  'src/hooks/use-connection-data.ts',
  'src/hooks/use-connection-setting.ts',
  'src/hooks/use-current-proxy.ts',
  'src/hooks/use-log-data.ts',
  'src/hooks/use-profiles.ts',
]

const retainedPaths = [
  'src/pages/connect.tsx',
  'src/pages/nodes.tsx',
  'src/pages/plans.tsx',
  'src/pages/mine.tsx',
  'src/components/shared/proxy-control-switches.tsx',
  'src/hooks/use-proxy-selection.ts',
  'src/hooks/use-system-state.ts',
]

const redirectTargets = new Map([
  ['/home', '/connect'],
  ['/profile', '/connect'],
  ['/connections', '/connect'],
  ['/rules', '/connect'],
  ['/unlock', '/connect'],
  ['/proxies', '/nodes'],
  ['/settings', '/mine'],
  ['/logs', '/mine'],
  ['/api-keys', '/mine'],
])

const retiredImportRoots = retiredPaths.map((entry) =>
  entry.replace(/\.(?:ts|tsx)$/, ''),
)

const listSourceFiles = (directory) =>
  readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const entryPath = resolve(directory, entry.name)
    if (entry.isDirectory()) return listSourceFiles(entryPath)
    return /\.(?:ts|tsx)$/.test(entry.name) ? [entryPath] : []
  })

const sourceImportSpecifiers = (source) => {
  const specifiers = []
  const patterns = [
    /\b(?:import|export)\s+(?:type\s+)?[^'"`]*?\s+from\s+['"]([^'"]+)['"]/g,
    /\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
    /\bimport\s*['"]([^'"]+)['"]/g,
  ]

  for (const pattern of patterns) {
    for (const match of source.matchAll(pattern)) {
      specifiers.push(match[1])
    }
  }

  return specifiers
}

const resolveImportPath = (sourcePath, specifier) => {
  const sourceRelativePath = relative(sourceRoot, sourcePath).replaceAll(
    '\\',
    '/',
  )
  const withoutQuery = specifier.split(/[?#]/, 1)[0]
  const importedPath = withoutQuery.startsWith('@/')
    ? `src/${withoutQuery.slice(2)}`
    : withoutQuery.startsWith('.')
      ? posix.join('src', posix.dirname(sourceRelativePath), withoutQuery)
      : null

  return importedPath?.replace(/\.(?:ts|tsx)$/, '')
}

test('retired consumer pages, component trees, and hooks are absent', () => {
  for (const relativePath of retiredPaths) {
    assert.equal(
      existsSync(resolve(repoRoot, relativePath)),
      false,
      `${relativePath} must be removed`,
    )
  }
})

test('legacy routes remain redirects while retained consumer controls remain available', () => {
  const routerSource = readFileSync(
    resolve(repoRoot, 'src/pages/_routers.tsx'),
    'utf8',
  )

  for (const [legacyPath, targetPath] of redirectTargets) {
    assert.match(
      routerSource,
      new RegExp(`path:\\s*'${legacyPath}'.{0,180}to=\\"${targetPath}\\"`, 's'),
    )
  }

  for (const relativePath of retainedPaths) {
    assert.equal(
      existsSync(resolve(repoRoot, relativePath)),
      true,
      `${relativePath} must remain`,
    )
  }
})

test('source imports do not reference the retired consumer surface', () => {
  for (const sourcePath of listSourceFiles(sourceRoot)) {
    const source = readFileSync(sourcePath, 'utf8')
    for (const specifier of sourceImportSpecifiers(source)) {
      const importedPath = resolveImportPath(sourcePath, specifier)
      assert.equal(
        retiredImportRoots.some(
          (retiredRoot) =>
            importedPath === retiredRoot ||
            importedPath?.startsWith(`${retiredRoot}/`),
        ),
        false,
        `${relative(repoRoot, sourcePath)} imports retired ${specifier}`,
      )
    }
  }
})

test('Plans sends purchases to dashboard recharge rather than direct checkout', () => {
  const plansSource = readFileSync(
    resolve(repoRoot, 'src/pages/plans.tsx'),
    'utf8',
  )

  assert.match(plansSource, /https:\/\/xxlink\.net\/dashboard\/recharge/)
  assert.equal(plansSource.includes('/payment/subscription/checkout'), false)
})

test('manual node selection persists while automatic recovery remains transient', () => {
  const connectSource = readFileSync(
    resolve(repoRoot, 'src/pages/connect.tsx'),
    'utf8',
  )
  const nodesSource = readFileSync(
    resolve(repoRoot, 'src/pages/nodes.tsx'),
    'utf8',
  )

  assert.match(
    connectSource,
    /changeProxy\(\s*groupName,\s*target\.name,\s*currentNode,\s*true,?\s*\)/,
  )
  assert.match(
    connectSource,
    /changeProxy\(\s*globalGroup\.name,\s*entry\.name,\s*currentRuntimeNode \|\| currentNode,?\s*\)/,
  )
  assert.doesNotMatch(
    connectSource,
    /changeProxy\(\s*globalGroup\.name,\s*entry\.name,\s*currentRuntimeNode \|\| currentNode,\s*true,?\s*\)/,
  )
  assert.match(
    connectSource,
    /onError:\s*\(error\)\s*=>\s*reportSafeClientFailure\('connect-proxy-selection', error\)/,
  )
  assert.match(
    nodesSource,
    /changeProxy\(\s*globalGroup\.name,\s*node\.name,\s*currentRuntimeNode \|\| currentNode,?\s*\)/,
  )
  assert.doesNotMatch(
    nodesSource,
    /changeProxy\(\s*globalGroup\.name,\s*node\.name,\s*currentRuntimeNode \|\| currentNode,\s*true,?\s*\)/,
  )
  assert.match(
    nodesSource,
    /onError:\s*\(error\)\s*=>\s*reportSafeClientFailure\('nodes-proxy-selection', error\)/,
  )
})

test('proxy selection awaits queued persistence and reports errors safely', () => {
  const selectionSource = readFileSync(
    resolve(repoRoot, 'src/hooks/use-proxy-selection.ts'),
    'utf8',
  )

  assert.match(selectionSource, /import \{ reportSafeClientFailure \}/)
  assert.match(selectionSource, /await patchCurrent\(\{ selected \}\)/)
  assert.match(
    selectionSource,
    /await persistSelection\(groupName, proxyName, skipConfigSave\)/,
  )
  assert.equal(selectionSource.includes('void persistSelection'), false)
  assert.doesNotMatch(
    selectionSource,
    /console\.(?:warn|error)\s*\([^)]*\b(?:error|fallbackError)\b/,
  )
})
